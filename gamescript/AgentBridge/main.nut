// AgentBridge main loop. Protocol (see docs/PROTOCOL.md):
//
// Request  (admin -> GS): {"id": int, "client": string, "cmd": string, "args": table}
// Reply    (GS -> admin): {"id": int, "client": string, "ok": bool, "part": int,
//                          "last": bool, "data": any, "error": string (ok=false only)}
// Replies are broadcast to every admin connection; clients match on (client, id).
// An array "data" may be split over several parts; the client concatenates them.
//
// Invariants:
//  - each GSAdmin.Send payload stays under MAX_PART_BYTES (COMPAT_MTU is 1460 in 15.x)
//  - build commands go through BuildGate() so the rate limit applies to all of them

const MAX_PART_BYTES = 1100;

class AgentBridge extends GSController {
	handlers = null;
	builds_today = null;     // company id -> build commands issued today
	builds_date = 0;         // date builds_today refers to
	delay_override = -1;     // set via set_rate; -1 = use GS setting
	perday_override = -1;

	constructor() {
		this.builds_today = {};
		this.handlers = {
			ping = this.CmdPing,
			info = this.CmdInfo,
			echo = this.CmdEcho,
			companies = this.CmdCompanies,
			cargos = this.CmdCargos,
			towns = this.CmdTowns,
			industries = this.CmdIndustries,
			industry_types = this.CmdIndustryTypes,
			dump_tiles = this.CmdDumpTiles,
			get_rate = this.CmdGetRate,
			set_rate = this.CmdSetRate,
			airport_types = this.CmdAirportTypes,
			check_airport = this.CmdCheckAirport,
			test_build_road = this.CmdTestBuildRoad,
			build_road = this.CmdBuildRoad,
		};
	}
}

function AgentBridge::Start() {
	GSLog.Info("AgentBridge v2 started");
	GSAdmin.Send({ id = 0, client = "", ok = true, part = 0, last = true, data = { event = "started", tick = GSController.GetTick() } });
	while (true) {
		while (GSEventController.IsEventWaiting()) {
			local ev = GSEventController.GetNextEvent();
			if (ev == null) continue;
			if (ev.GetEventType() == GSEvent.ET_ADMIN_PORT) {
				this.HandleRequest(GSEventAdminPort.Convert(ev).GetObject());
			}
		}
		GSController.Sleep(1);
	}
}

function AgentBridge::Save() { return {}; }
function AgentBridge::Load(version, data) {}

function AgentBridge::HandleRequest(req) {
	if (typeof req != "table" || !("id" in req) || !("cmd" in req)) {
		GSLog.Warning("AgentBridge: malformed request");
		return;
	}
	local client = ("client" in req) ? req.client : "";
	local args = ("args" in req && req.args != null) ? req.args : {};
	if (!(req.cmd in this.handlers)) {
		this.Fail(req.id, client, "unknown cmd: " + req.cmd);
		return;
	}
	local result = null;
	try {
		result = this.handlers[req.cmd].call(this, args);
	} catch (e) {
		GSLog.Error("AgentBridge: " + req.cmd + " failed: " + e);
		this.Fail(req.id, client, "exception in " + req.cmd + ": " + e);
		return;
	}
	this.Reply(req.id, client, result);
}

// ---- Reply / chunking -------------------------------------------------------

function AgentBridge::Fail(id, client, error) {
	GSAdmin.Send({ id = id, client = client, ok = false, part = 0, last = true, error = error });
}

function AgentBridge::Reply(id, client, data) {
	if (typeof data != "array") {
		local msg = { id = id, client = client, ok = true, part = 0, last = true, data = data };
		if (this.EstimateJsonLen(msg) > MAX_PART_BYTES) {
			this.Fail(id, client, "reply too large; handler must return an array");
			return;
		}
		GSAdmin.Send(msg);
		return;
	}
	local envelope = 70 + client.len();
	local part = 0;
	local batch = [];
	local batch_len = envelope;
	foreach (item in data) {
		local item_len = this.EstimateJsonLen(item) + 1;
		if (batch.len() > 0 && batch_len + item_len > MAX_PART_BYTES) {
			GSAdmin.Send({ id = id, client = client, ok = true, part = part, last = false, data = batch });
			part++;
			batch = [];
			batch_len = envelope;
		}
		batch.append(item);
		batch_len += item_len;
	}
	GSAdmin.Send({ id = id, client = client, ok = true, part = part, last = true, data = batch });
}

// Upper-bound estimate of the JSON encoding length of a Squirrel value.
function AgentBridge::EstimateJsonLen(v) {
	switch (typeof v) {
		case "null": return 4;
		case "bool": return 5;
		case "integer": return v.tostring().len();
		case "float": return 24;
		case "string": return v.len() + 2 + v.len() / 6;
		case "array": {
			local n = 2;
			foreach (x in v) n += this.EstimateJsonLen(x) + 1;
			return n;
		}
		case "table": {
			local n = 2;
			foreach (k, x in v) n += k.tostring().len() + 4 + this.EstimateJsonLen(x);
			return n;
		}
	}
	return 16;
}

function AgentBridge::Str(s) { return s == null ? "" : s; }

// ---- Rate limiting ----------------------------------------------------------

function AgentBridge::CommandDelay() {
	return this.delay_override >= 0 ? this.delay_override : GSController.GetSetting("command_delay_ticks");
}

function AgentBridge::MaxBuildsPerDay() {
	return this.perday_override >= 0 ? this.perday_override : GSController.GetSetting("max_builds_per_day");
}

// Returns null if the company may issue one more build command now, else an error string.
function AgentBridge::BuildGate(company) {
	local today = GSDate.GetCurrentDate();
	if (today != this.builds_date) {
		this.builds_date = today;
		this.builds_today = {};
	}
	local used = (company in this.builds_today) ? this.builds_today[company] : 0;
	local cap = this.MaxBuildsPerDay();
	if (cap > 0 && used >= cap) return "rate limit: " + cap + " build commands per game day reached for company " + company;
	this.builds_today[company] <- used + 1;
	GSController.SetCommandDelay(max(1, this.CommandDelay()));
	return null;
}

function AgentBridge::CmdGetRate(args) {
	return { command_delay_ticks = this.CommandDelay(), max_builds_per_day = this.MaxBuildsPerDay(),
		setting_command_delay_ticks = GSController.GetSetting("command_delay_ticks"),
		setting_max_builds_per_day = GSController.GetSetting("max_builds_per_day") };
}

// args: command_delay_ticks, max_builds_per_day (each optional; -1 = back to GS setting)
function AgentBridge::CmdSetRate(args) {
	if ("command_delay_ticks" in args) this.delay_override = args.command_delay_ticks;
	if ("max_builds_per_day" in args) this.perday_override = args.max_builds_per_day;
	return this.CmdGetRate(args);
}

// ---- Read commands ----------------------------------------------------------

function AgentBridge::CmdPing(args) { return { pong = GSController.GetTick() }; }
function AgentBridge::CmdEcho(args) { return args; }

function AgentBridge::CmdInfo(args) {
	local d = GSDate.GetCurrentDate();
	return {
		tick = GSController.GetTick(),
		date = d,
		year = GSDate.GetYear(d), month = GSDate.GetMonth(d), day = GSDate.GetDayOfMonth(d),
		map_x = GSMap.GetMapSizeX(), map_y = GSMap.GetMapSizeY(),
		landscape = GSGame.GetLandscape(),
		paused = GSGame.IsPaused(),
		towns = GSTown.GetTownCount(),
		industries = GSIndustry.GetIndustryCount(),
		bridge_version = 2,
	};
}

function AgentBridge::CmdCompanies(args) {
	local out = [];
	for (local c = GSCompany.COMPANY_FIRST; c <= GSCompany.COMPANY_LAST; c++) {
		if (GSCompany.ResolveCompanyID(c) == GSCompany.COMPANY_INVALID) continue;
		local q = GSCompany.CURRENT_QUARTER + 1; // last full quarter
		out.append({
			id = c,
			name = this.Str(GSCompany.GetName(c)),
			money = GSCompany.GetBankBalance(c),
			loan = GSCompany.GetLoanAmount(c),
			max_loan = GSCompany.GetMaxLoanAmount(),
			value = GSCompany.GetQuarterlyCompanyValue(c, q),
			income = GSCompany.GetQuarterlyIncome(c, q),
			expenses = GSCompany.GetQuarterlyExpenses(c, q),
			cargo_delivered = GSCompany.GetQuarterlyCargoDelivered(c, q),
			performance = GSCompany.GetQuarterlyPerformanceRating(c, q),
			hq = GSCompany.GetCompanyHQ(c),
		});
	}
	return out;
}

function AgentBridge::CmdCargos(args) {
	local out = [];
	foreach (c, _ in GSCargoList()) {
		out.append({
			id = c,
			label = this.Str(GSCargo.GetCargoLabel(c)),
			name = this.Str(GSCargo.GetName(c)),
			passengers = GSCargo.HasCargoClass(c, GSCargo.CC_PASSENGERS),
			mail = GSCargo.HasCargoClass(c, GSCargo.CC_MAIL),
			town_effect = GSCargo.GetTownEffect(c),
		});
	}
	return out;
}

function AgentBridge::CmdIndustryTypes(args) {
	local out = [];
	foreach (t, _ in GSIndustryTypeList()) {
		local produces = [];
		local accepts = [];
		foreach (c, _ in GSIndustryType.GetProducedCargo(t)) produces.append(c);
		foreach (c, _ in GSIndustryType.GetAcceptedCargo(t)) accepts.append(c);
		out.append({ id = t, name = this.Str(GSIndustryType.GetName(t)), produces = produces, accepts = accepts,
			raw = GSIndustryType.IsRawIndustry(t), processing = GSIndustryType.IsProcessingIndustry(t) });
	}
	return out;
}

// Compact rows: [id, type, x, y, [[cargo, produced_last_month, transported_pct], ...], stations_around]
function AgentBridge::CmdIndustries(args) {
	local out = [];
	foreach (i, _ in GSIndustryList()) {
		local t = GSIndustry.GetIndustryType(i);
		local tile = GSIndustry.GetLocation(i);
		local prod = [];
		foreach (c, _ in GSIndustryType.GetProducedCargo(t)) {
			prod.append([c, GSIndustry.GetLastMonthProduction(i, c), GSIndustry.GetLastMonthTransportedPercentage(i, c)]);
		}
		out.append([i, t, GSMap.GetTileX(tile), GSMap.GetTileY(tile), prod, GSIndustry.GetAmountOfStationsAround(i)]);
	}
	return out;
}

// Rows: [id, name, x, y, population, is_city, pax_produced, pax_transported_pct,
//        mail_produced, mail_transported_pct, allowed_noise]
function AgentBridge::CmdTowns(args) {
	local pax = -1;
	local mail = -1;
	foreach (c, _ in GSCargoList()) {
		if (pax < 0 && GSCargo.HasCargoClass(c, GSCargo.CC_PASSENGERS)) pax = c;
		if (mail < 0 && GSCargo.HasCargoClass(c, GSCargo.CC_MAIL)) mail = c;
	}
	local out = [];
	foreach (t, _ in GSTownList()) {
		local tile = GSTown.GetLocation(t);
		out.append([t, this.Str(GSTown.GetName(t)), GSMap.GetTileX(tile), GSMap.GetTileY(tile),
			GSTown.GetPopulation(t), GSTown.IsCity(t),
			pax >= 0 ? GSTown.GetLastMonthProduction(t, pax) : 0,
			pax >= 0 ? GSTown.GetLastMonthTransportedPercentage(t, pax) : 0,
			mail >= 0 ? GSTown.GetLastMonthProduction(t, mail) : 0,
			mail >= 0 ? GSTown.GetLastMonthTransportedPercentage(t, mail) : 0,
			GSTown.GetAllowedNoise(t)]);
	}
	return out;
}

// args: y0, y1 (inclusive rows), optional x0, x1.
// One string per row segment: "y,x0,<4 chars per tile>".
// Per tile: 2 hex chars max height, 1 base32 char slope, 1 class char.
// Class: w water, c coast, i industry, s station, r rail, d road, t trees,
//        f farm, k rocks, h rough, b clear/buildable, o other (houses, objects, HQ).
function AgentBridge::CmdDumpTiles(args) {
	local mx = GSMap.GetMapSizeX();
	local x0 = ("x0" in args) ? args.x0 : 0;
	local x1 = ("x1" in args) ? args.x1 : mx - 1;
	local seg = 200;
	local hex = "0123456789abcdef";
	local b32 = "0123456789abcdefghijklmnopqrstuv";
	local out = [];
	for (local y = args.y0; y <= args.y1; y++) {
		for (local sx = x0; sx <= x1; sx += seg) {
			local ex = min(sx + seg - 1, x1);
			local s = y.tostring() + "," + sx.tostring() + ",";
			for (local x = sx; x <= ex; x++) {
				local t = GSMap.GetTileIndex(x, y);
				local h = GSTile.GetMaxHeight(t);
				if (h < 0) h = 0;
				if (h > 255) h = 255;
				local sl = GSTile.GetSlope(t);
				if (sl < 0 || sl > 31) sl = 0;
				s += hex.slice(h >> 4, (h >> 4) + 1) + hex.slice(h & 15, (h & 15) + 1) + b32.slice(sl, sl + 1) + this.TileClass(t);
			}
			out.append(s);
		}
	}
	return out;
}

function AgentBridge::TileClass(t) {
	if (GSTile.IsWaterTile(t)) return "w";
	if (GSTile.IsCoastTile(t)) return "c";
	if (GSIndustry.IsValidIndustry(GSIndustry.GetIndustryID(t))) return "i";
	if (GSTile.IsStationTile(t)) return "s";
	if (GSRail.IsRailTile(t)) return "r";
	if (GSRoad.IsRoadTile(t)) return "d";
	if (GSTile.HasTreeOnTile(t)) return "t";
	if (GSTile.IsFarmTile(t)) return "f";
	if (GSTile.IsRockTile(t)) return "k";
	if (GSTile.IsRoughTile(t)) return "h";
	if (GSTile.IsBuildable(t)) return "b";
	return "o";
}

// Airport types buildable right now (depends on date and NewGRFs).
function AgentBridge::CmdAirportTypes(args) {
	local names = ["small", "large", "heliport", "metropolitan", "international", "commuter", "helidepot", "intercontinental", "helistation"];
	local out = [];
	for (local t = 0; t < names.len(); t++) {
		if (!GSAirport.IsAirportInformationAvailable(t)) continue;
		out.append({ type = t, name = names[t], buildable_now = GSAirport.IsValidAirportType(t),
			width = GSAirport.GetAirportWidth(t), height = GSAirport.GetAirportHeight(t),
			coverage_radius = GSAirport.GetAirportCoverageRadius(t), price = GSAirport.GetPrice(t),
			monthly_maintenance = GSAirport.GetMonthlyMaintenanceCost(t) });
	}
	return out;
}

// args: x, y, type, optional company (adds a dry-run build check as that company).
function AgentBridge::CmdCheckAirport(args) {
	local tile = GSMap.GetTileIndex(args.x, args.y);
	local town = GSAirport.GetNearestTown(tile, args.type);
	local out = { noise_increase = GSAirport.GetNoiseLevelIncrease(tile, args.type),
		nearest_town = town, town_allowed_noise = GSTown.IsValidTown(town) ? GSTown.GetAllowedNoise(town) : -1 };
	if ("company" in args) {
		local mode = GSCompanyMode(args.company);
		local test = GSTestMode();
		local costs = GSAccounting();
		local ok = GSAirport.BuildAirport(tile, args.type, GSBaseStation.STATION_NEW);
		out.buildable <- ok;
		out.cost <- costs.GetCosts();
		out.error <- ok ? "" : this.Str(GSError.GetLastErrorString());
	}
	return out;
}

// ---- Build commands (always as args.company, always through BuildGate) -----

// args: company, x1, y1, x2, y2 (straight line). Dry run: cost and feasibility.
function AgentBridge::CmdTestBuildRoad(args) {
	local mode = GSCompanyMode(args.company);
	local test = GSTestMode();
	local costs = GSAccounting();
	GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);
	local ok = GSRoad.BuildRoad(GSMap.GetTileIndex(args.x1, args.y1), GSMap.GetTileIndex(args.x2, args.y2));
	return { ok = ok, cost = costs.GetCosts(), error = ok ? "" : this.Str(GSError.GetLastErrorString()) };
}

// args: company, x1, y1, x2, y2 (straight line).
function AgentBridge::CmdBuildRoad(args) {
	local gate = this.BuildGate(args.company);
	if (gate != null) throw gate;
	local mode = GSCompanyMode(args.company);
	local costs = GSAccounting();
	GSRoad.SetCurrentRoadType(GSRoad.ROADTYPE_ROAD);
	local ok = GSRoad.BuildRoad(GSMap.GetTileIndex(args.x1, args.y1), GSMap.GetTileIndex(args.x2, args.y2));
	return { ok = ok, cost = costs.GetCosts(), error = ok ? "" : this.Str(GSError.GetLastErrorString()),
		money = GSCompany.GetBankBalance(args.company) };
}
