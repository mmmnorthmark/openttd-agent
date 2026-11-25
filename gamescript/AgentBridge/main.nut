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
	events = null;           // ring buffer of event tables, oldest first
	event_seq = 0;           // seq of the newest recorded event
	goals = null;            // one table per company with a goal, see CmdGoalSet
	goal_month = 0;          // year * 12 + month of the last monthly goal update
	world_stamp = "";        // identifies this map; saved with the goals (see RestoreGoals)
	loaded = null;           // table handed to Load(), consumed in Start()

	constructor() {
		this.builds_today = {};
		this.events = [];
		this.goals = [];
		this.handlers = {
			ping = "CmdPing",
			info = "CmdInfo",
			echo = "CmdEcho",
			companies = "CmdCompanies",
			cargos = "CmdCargos",
			towns = "CmdTowns",
			industries = "CmdIndustries",
			industry_types = "CmdIndustryTypes",
			dump_tiles = "CmdDumpTiles",
			get_rate = "CmdGetRate",
			set_rate = "CmdSetRate",
			airport_types = "CmdAirportTypes",
			check_airport = "CmdCheckAirport",
			test_build_road = "CmdTestBuildRoad",
			build_road = "CmdBuildRoad",
			stations = "CmdStations",
			vehicles = "CmdVehicles",
			vehicle = "CmdVehicle",
			engines = "CmdEngines",
			groups = "CmdGroups",
			depots = "CmdDepots",
			autorenew = "CmdAutorenew",
			events = "CmdEvents",
			exec = "CmdExec",
			rail_types = "CmdRailTypes",
			bridge_types = "CmdBridgeTypes",
			acceptance = "CmdAcceptance",
			goal_set = "CmdGoalSet",
			goal_status = "CmdGoalStatus",
			goal_clear = "CmdGoalClear",
		};
	}
}

function AgentBridge::Start() {
	GSLog.Info("AgentBridge v8 started");
	this.RestoreGoals();
	GSAdmin.Send({ id = 0, client = "", ok = true, part = 0, last = true, data = { event = "started", tick = GSController.GetTick() } });
	while (true) {
		while (GSEventController.IsEventWaiting()) {
			local ev = GSEventController.GetNextEvent();
			if (ev == null) continue;
			if (ev.GetEventType() == GSEvent.ET_ADMIN_PORT) {
				this.HandleRequest(GSEventAdminPort.Convert(ev).GetObject());
			} else {
				this.RecordEvent(ev);
			}
		}
		if (this.goals.len() > 0 && this.MonthNow() != this.goal_month) this.UpdateGoals();
		GSController.Sleep(1);
	}
}

// Save() must stay cheap and may not call the API: it only hands over what is already in memory.
function AgentBridge::Save() { return { world = this.world_stamp, goals = this.goals, goal_month = this.goal_month }; }
function AgentBridge::Load(version, data) { this.loaded = data; }

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
		// Member call by name, never .call()/acall(): those are native functions and
		// OpenTTD refuses DoCommands (fatal, script dies) with a native call on the stack.
		result = this[this.handlers[req.cmd]](args);
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
		bridge_version = 8,
		event_seq = this.event_seq,
		goals = this.goals.len(),
	};
}

function AgentBridge::CmdCompanies(args) {
	local out = [];
	for (local c = GSCompany.COMPANY_FIRST; c <= GSCompany.COMPANY_LAST; c++) {
		if (GSCompany.ResolveCompanyID(c) == GSCompany.COMPANY_INVALID) continue;
		local q = GSCompany.CURRENT_QUARTER + 1; // last full quarter
		local loan = 0, max_loan = 0;
		{
			// GetLoanAmount/GetMaxLoanAmount take no company arg: they read the current company.
			local cm = GSCompanyMode(c);
			loan = GSCompany.GetLoanAmount();
			max_loan = GSCompany.GetMaxLoanAmount();
		}
		out.append({
			id = c,
			name = this.Str(GSCompany.GetName(c)),
			money = GSCompany.GetBankBalance(c),
			loan = loan,
			max_loan = max_loan,
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

// args: points = [[x, y], ...], optional w, h (station size, default 1), radius (catchment, default 4),
// cargos = [cargo ids] (default: every cargo). Rows: [point_index, cargo, acceptance] for acceptance > 0;
// 8 or more means a station of that size there would accept the cargo. Invalid tiles/cargos are skipped.
function AgentBridge::CmdAcceptance(args) {
	local w = ("w" in args) ? args.w : 1;
	local h = ("h" in args) ? args.h : 1;
	local r = ("radius" in args) ? args.radius : 4;
	local cargos = [];
	if ("cargos" in args) {
		cargos = args.cargos;
	} else {
		foreach (c, _ in GSCargoList()) cargos.append(c);
	}
	local out = [];
	for (local i = 0; i < args.points.len(); i++) {
		local p = args.points[i];
		local tile = GSMap.GetTileIndex(p[0], p[1]);
		if (!GSMap.IsValidTile(tile)) continue;
		foreach (c in cargos) {
			if (!GSCargo.IsValidCargo(c)) continue;
			local v = GSTile.GetCargoAcceptance(tile, c, w, h, r);
			if (v > 0) out.append([i, c, v]);
		}
	}
	return out;
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

// ---- Operate: read ----------------------------------------------------------

// Throws a readable error unless args.company is an existing company.
function AgentBridge::CheckCompany(args) {
	if (!("company" in args)) throw "no company given; run: openttd-agent configure --company <id>";
	if (GSCompany.ResolveCompanyID(args.company) == GSCompany.COMPANY_INVALID) throw "company " + args.company + " does not exist; run: openttd-agent companies";
	return args.company;
}

// args: company. Rows: [id, name, x, y, facilities, [[cargo, waiting, rating_pct], ...], vehicles]
// facilities bitmask: 1 rail, 2 truck, 4 bus, 8 airport, 16 dock.
function AgentBridge::CmdStations(args) {
	local mode = GSCompanyMode(this.CheckCompany(args));
	local kinds = [GSStation.STATION_TRAIN, GSStation.STATION_TRUCK_STOP, GSStation.STATION_BUS_STOP, GSStation.STATION_AIRPORT, GSStation.STATION_DOCK];
	local cargos = GSCargoList();
	local out = [];
	foreach (s, _ in GSStationList(GSStation.STATION_ANY)) {
		local tile = GSBaseStation.GetLocation(s);
		local fac = 0;
		for (local k = 0; k < kinds.len(); k++) {
			if (GSStation.HasStationType(s, kinds[k])) fac = fac | (1 << k);
		}
		local cg = [];
		foreach (c, _ in cargos) {
			if (GSStation.HasCargoRating(s, c)) cg.append([c, GSStation.GetCargoWaiting(s, c), GSStation.GetCargoRating(s, c)]);
		}
		out.append([s, this.Str(GSBaseStation.GetName(s)), GSMap.GetTileX(tile), GSMap.GetTileY(tile), fac, cg, GSVehicleList_Station(s).Count()]);
	}
	return out;
}

// args: company. Rows: [id, name, type, engine, engine_name, age_days, max_age_days, reliability_pct,
//   profit_this_year, profit_last_year, value, state, x, y, group, order_count, unit_number, running_cost, shared_orders]
// type: 0 rail, 1 road, 2 water, 3 air. state: 0 running, 1 stopped, 2 in depot, 3 at station, 4 broken, 5 crashed.
function AgentBridge::CmdVehicles(args) {
	local mode = GSCompanyMode(this.CheckCompany(args));
	local out = [];
	foreach (v, _ in GSVehicleList()) {
		local tile = GSVehicle.GetLocation(v);
		local e = GSVehicle.GetEngineType(v);
		out.append([v, this.Str(GSVehicle.GetName(v)), GSVehicle.GetVehicleType(v), e, this.Str(GSEngine.GetName(e)),
			GSVehicle.GetAge(v), GSVehicle.GetMaxAge(v), GSVehicle.GetReliability(v),
			GSVehicle.GetProfitThisYear(v), GSVehicle.GetProfitLastYear(v), GSVehicle.GetCurrentValue(v),
			GSVehicle.GetState(v), GSMap.GetTileX(tile), GSMap.GetTileY(tile), GSVehicle.GetGroupID(v),
			GSOrder.GetOrderCount(v), GSVehicle.GetUnitNumber(v), GSVehicle.GetRunningCost(v), GSVehicle.HasSharedOrders(v)]);
	}
	return out;
}

// args: company, vehicle. Returns [info table, order row, order row, ...].
// Order row: [position, kind, x, y, flags, station_id, destination_name, jump_to]
// kind: "station", "depot", "waypoint", "conditional", "other". station_id/jump_to are -1 when not applicable.
function AgentBridge::CmdVehicle(args) {
	local mode = GSCompanyMode(this.CheckCompany(args));
	local v = args.vehicle;
	if (!GSVehicle.IsValidVehicle(v)) throw "vehicle " + v + " does not exist or is not owned by company " + args.company + "; run: openttd-agent vehicles";
	local tile = GSVehicle.GetLocation(v);
	local e = GSVehicle.GetEngineType(v);
	local cap = [];
	foreach (c, _ in GSCargoList()) {
		local n = GSVehicle.GetCapacity(v, c);
		if (n > 0) cap.append([c, n, GSVehicle.GetCargoLoad(v, c)]);
	}
	local count = GSOrder.GetOrderCount(v);
	local out = [{
		id = v, name = this.Str(GSVehicle.GetName(v)), type = GSVehicle.GetVehicleType(v), engine = e, engine_name = this.Str(GSEngine.GetName(e)),
		age_days = GSVehicle.GetAge(v), max_age_days = GSVehicle.GetMaxAge(v), reliability_pct = GSVehicle.GetReliability(v),
		profit_this_year = GSVehicle.GetProfitThisYear(v), profit_last_year = GSVehicle.GetProfitLastYear(v),
		value = GSVehicle.GetCurrentValue(v), running_cost = GSVehicle.GetRunningCost(v), state = GSVehicle.GetState(v),
		x = GSMap.GetTileX(tile), y = GSMap.GetTileY(tile), speed = GSVehicle.GetCurrentSpeed(v), group = GSVehicle.GetGroupID(v),
		wagons = GSVehicle.GetNumWagons(v), length = GSVehicle.GetLength(v), capacity = cap, shared_orders = GSVehicle.HasSharedOrders(v),
		order_count = count, current_order = count > 0 ? GSOrder.ResolveOrderPosition(v, GSOrder.ORDER_CURRENT) : -1,
	}];
	for (local i = 0; i < count; i++) {
		local kind = "other";
		local station = -1;
		local name = "";
		local jump = -1;
		local dest = GSOrder.GetOrderDestination(v, i);
		if (GSOrder.IsConditionalOrder(v, i)) {
			kind = "conditional";
			jump = GSOrder.GetOrderJumpTo(v, i);
		} else if (GSOrder.IsGotoStationOrder(v, i)) {
			kind = "station";
			station = GSStation.GetStationID(dest);
			name = this.Str(GSBaseStation.GetName(station));
		} else if (GSOrder.IsGotoDepotOrder(v, i)) {
			kind = "depot";
		} else if (GSOrder.IsGotoWaypointOrder(v, i)) {
			kind = "waypoint";
		}
		local valid = GSMap.IsValidTile(dest);
		out.append([i, kind, valid ? GSMap.GetTileX(dest) : -1, valid ? GSMap.GetTileY(dest) : -1, GSOrder.GetOrderFlags(v, i), station, name, jump]);
	}
	return out;
}

// args: company, type (0 rail, 1 road, 2 water, 3 air), optional cargo, optional rail_type.
// Engines the company can build now. Rows: [id, name, cargo, capacity, max_speed, price, running_cost_per_year,
//   reliability_pct, max_age_days, design_year, power, weight, is_wagon, track_type]
// With cargo: wagons/vehicles that can be refitted to it and locomotives that can pull it.
function AgentBridge::CmdEngines(args) {
	local mode = GSCompanyMode(this.CheckCompany(args));
	local rail = args.type == GSVehicle.VT_RAIL;
	local out = [];
	foreach (e, _ in GSEngineList(args.type)) {
		if (!GSEngine.IsBuildable(e)) continue;
		local wagon = rail && GSEngine.IsWagon(e);
		if ("cargo" in args) {
			local fits = (rail && !wagon) ? GSEngine.CanPullCargo(e, args.cargo) : GSEngine.CanRefitCargo(e, args.cargo);
			if (!fits) continue;
		}
		if (rail && ("rail_type" in args)) {
			if (!GSEngine.CanRunOnRail(e, args.rail_type)) continue;
			if (!wagon && !GSEngine.HasPowerOnRail(e, args.rail_type)) continue;
		}
		local track = -1;
		if (rail) track = GSEngine.GetRailType(e);
		if (args.type == GSVehicle.VT_ROAD) track = GSEngine.GetRoadType(e);
		out.append([e, this.Str(GSEngine.GetName(e)), GSEngine.GetCargoType(e), GSEngine.GetCapacity(e), GSEngine.GetMaxSpeed(e),
			GSEngine.GetPrice(e), GSEngine.GetRunningCost(e), GSEngine.GetReliability(e), GSEngine.GetMaxAge(e),
			GSDate.GetYear(GSEngine.GetDesignDate(e)), GSEngine.GetPower(e), GSEngine.GetWeight(e), wagon, track]);
	}
	return out;
}

// args: company. Rows: [id, name, vehicle_type, parent (-1 none), vehicles, profit_this_year, profit_last_year, usage_pct]
function AgentBridge::CmdGroups(args) {
	local mode = GSCompanyMode(this.CheckCompany(args));
	local out = [];
	foreach (g, _ in GSGroupList()) {
		local vt = GSGroup.GetVehicleType(g);
		local parent_group = GSGroup.GetParent(g);
		out.append([g, this.Str(GSGroup.GetName(g)), vt, GSGroup.IsValidGroup(parent_group) ? parent_group : -1,
			GSGroup.GetNumVehicles(g, vt), GSGroup.GetProfitThisYear(g), GSGroup.GetProfitLastYear(g), GSGroup.GetCurrentUsage(g)]);
	}
	return out;
}

// args: company, type (0 rail, 1 road, 2 water, 3 air). Rows: [x, y, vehicles_inside]
function AgentBridge::CmdDepots(args) {
	local mode = GSCompanyMode(this.CheckCompany(args));
	local kinds = [GSTile.TRANSPORT_RAIL, GSTile.TRANSPORT_ROAD, GSTile.TRANSPORT_WATER, GSTile.TRANSPORT_AIR];
	local out = [];
	foreach (tile, _ in GSDepotList(kinds[args.type])) {
		out.append([GSMap.GetTileX(tile), GSMap.GetTileY(tile), GSVehicleList_Depot(tile).Count()]);
	}
	return out;
}

// args: company. Autorenew settings of the company (set them with the exec op "autorenew").
function AgentBridge::CmdAutorenew(args) {
	local c = this.CheckCompany(args);
	return { enabled = GSCompany.GetAutoRenewStatus(c), months = GSCompany.GetAutoRenewMonths(c), money = GSCompany.GetAutoRenewMoney(c) };
}

// ---- Events -------------------------------------------------------------------

const MAX_EVENTS = 300;

// Turn one game event into a table in the ring buffer. Event types a GameScript
// receives in 15.x (vehicle lost/unprofitable and engine-available are AI-only).
function AgentBridge::RecordEvent(ev) {
	local d = null;
	switch (ev.GetEventType()) {
		case GSEvent.ET_VEHICLE_CRASHED: {
			local e = GSEventVehicleCrashed.Convert(ev);
			local tile = e.GetCrashSite();
			d = { type = "vehicle_crashed", company = e.GetVehicleOwner(), vehicle = e.GetVehicleID(),
				x = GSMap.GetTileX(tile), y = GSMap.GetTileY(tile), reason = e.GetCrashReason(), victims = e.GetVictims() };
			break;
		}
		case GSEvent.ET_SUBSIDY_OFFER:
			d = this.SubsidyEvent("subsidy_offer", GSEventSubsidyOffer.Convert(ev).GetSubsidyID());
			break;
		case GSEvent.ET_SUBSIDY_OFFER_EXPIRED:
			d = this.SubsidyEvent("subsidy_offer_expired", GSEventSubsidyOfferExpired.Convert(ev).GetSubsidyID());
			break;
		case GSEvent.ET_SUBSIDY_AWARDED:
			d = this.SubsidyEvent("subsidy_awarded", GSEventSubsidyAwarded.Convert(ev).GetSubsidyID());
			break;
		case GSEvent.ET_SUBSIDY_EXPIRED:
			d = this.SubsidyEvent("subsidy_expired", GSEventSubsidyExpired.Convert(ev).GetSubsidyID());
			break;
		case GSEvent.ET_COMPANY_NEW:
			d = { type = "company_new", company = GSEventCompanyNew.Convert(ev).GetCompanyID() };
			break;
		case GSEvent.ET_COMPANY_IN_TROUBLE:
			d = { type = "company_in_trouble", company = GSEventCompanyInTrouble.Convert(ev).GetCompanyID() };
			break;
		case GSEvent.ET_COMPANY_BANKRUPT:
			d = { type = "company_bankrupt", company = GSEventCompanyBankrupt.Convert(ev).GetCompanyID() };
			break;
		case GSEvent.ET_COMPANY_MERGER: {
			local e = GSEventCompanyMerger.Convert(ev);
			d = { type = "company_merger", company = e.GetNewCompanyID(), old_company = e.GetOldCompanyID() };
			break;
		}
		case GSEvent.ET_INDUSTRY_OPEN: {
			local i = GSEventIndustryOpen.Convert(ev).GetIndustryID();
			local tile = GSIndustry.GetLocation(i);
			d = { type = "industry_open", industry = i, industry_type = GSIndustry.GetIndustryType(i), x = GSMap.GetTileX(tile), y = GSMap.GetTileY(tile) };
			break;
		}
		case GSEvent.ET_INDUSTRY_CLOSE:
			d = { type = "industry_close", industry = GSEventIndustryClose.Convert(ev).GetIndustryID() };
			break;
		case GSEvent.ET_STATION_FIRST_VEHICLE: {
			local e = GSEventStationFirstVehicle.Convert(ev);
			d = { type = "station_first_vehicle", station = e.GetStationID(), vehicle = e.GetVehicleID(), company = GSBaseStation.GetOwner(e.GetStationID()) };
			break;
		}
		case GSEvent.ET_TOWN_FOUNDED:
			d = { type = "town_founded", town = GSEventTownFounded.Convert(ev).GetTownID() };
			break;
		case GSEvent.ET_EXCLUSIVE_TRANSPORT_RIGHTS: {
			local e = GSEventExclusiveTransportRights.Convert(ev);
			d = { type = "exclusive_transport_rights", company = e.GetCompanyID(), town = e.GetTownID() };
			break;
		}
		case GSEvent.ET_ROAD_RECONSTRUCTION: {
			local e = GSEventRoadReconstruction.Convert(ev);
			d = { type = "road_reconstruction", company = e.GetCompanyID(), town = e.GetTownID() };
			break;
		}
	}
	if (d != null) this.PushEvent(d);
}

// Stamp an event table with seq and date and put it in the ring buffer.
function AgentBridge::PushEvent(d) {
	this.event_seq++;
	d.seq <- this.event_seq;
	d.date <- this.DateStr(GSDate.GetCurrentDate());
	this.events.append(d);
	if (this.events.len() > MAX_EVENTS) this.events.remove(0);
}

function AgentBridge::DateStr(d) { return GSDate.GetYear(d) + "-" + GSDate.GetMonth(d) + "-" + GSDate.GetDayOfMonth(d); }

function AgentBridge::SubsidyEvent(name, id) {
	local d = { type = name, subsidy = id };
	if (!GSSubsidy.IsValidSubsidy(id)) return d;
	d.cargo <- GSSubsidy.GetCargoType(id);
	d.from_kind <- GSSubsidy.GetSourceType(id) == GSSubsidy.SPT_TOWN ? "town" : "industry";
	d.from_id <- GSSubsidy.GetSourceIndex(id);
	d.to_kind <- GSSubsidy.GetDestinationType(id) == GSSubsidy.SPT_TOWN ? "town" : "industry";
	d.to_id <- GSSubsidy.GetDestinationIndex(id);
	d.expires_year <- GSDate.GetYear(GSSubsidy.GetExpireDate(id));
	if (GSSubsidy.IsAwarded(id)) d.company <- GSSubsidy.GetAwardedTo(id);
	return d;
}

// args: optional since (seq). Events with seq > since, oldest first (the buffer keeps the last MAX_EVENTS).
function AgentBridge::CmdEvents(args) {
	local since = ("since" in args) ? args.since : 0;
	local out = [];
	foreach (d in this.events) {
		if (d.seq > since) out.append(d);
	}
	return out;
}

// ---- Goals ----------------------------------------------------------------------
//
// A game runs one GameScript, so AgentBridge hosts the goals itself. One goal per company:
//   { company, deadline_year, set_date, status ("active" | "done" | "failed"),
//     targets = [{ cargo (id, -1 = company value), label, name, amount, progress, shown, goal (GSGoal id), done }] }
// Cargo progress is what the company delivered since the goal was set. It is read from town
// delivery monitors: every delivery is counted for the town its station belongs to (also
// deliveries to industries, 15.3 cargomonitor.cpp AddCargoDelivery), so the sum over all towns
// counts each delivery once. Company value is the current value, not a sum.
// Everything here runs as deity (no GSCompanyMode): GSGoal commands require it.

function AgentBridge::MonthNow() {
	local d = GSDate.GetCurrentDate();
	return GSDate.GetYear(d) * 12 + GSDate.GetMonth(d);
}

function AgentBridge::CargoByLabel(label) {
	foreach (c, _ in GSCargoList()) {
		if (GSCargo.GetCargoLabel(c) == label) return c;
	}
	return -1;
}

// Deliveries of cargo by company since the last call, summed over all towns. keep = false stops the monitors.
function AgentBridge::ReadDeliveries(company, cargo, keep) {
	local sum = 0;
	foreach (town, _ in GSTownList()) {
		local n = GSCargoMonitor.GetTownDeliveryAmount(company, cargo, town, keep);
		if (n > 0) sum += n;
	}
	return sum;
}

function AgentBridge::GoalIndex(company) {
	for (local i = 0; i < this.goals.len(); i++) {
		if (this.goals[i].company == company) return i;
	}
	return -1;
}

function AgentBridge::GoalText(t, deadline_year) {
	if (t.cargo < 0) return "Reach a company value of " + t.amount + " by the end of " + deadline_year;
	return "Deliver " + t.amount + " " + t.name + " by the end of " + deadline_year;
}

// args: company, deadline_year, targets = [[cargo label or "VALUE", amount], ...]. Replaces the company's goal.
function AgentBridge::CmdGoalSet(args) {
	local company = this.CheckCompany(args);
	if (!("deadline_year" in args) || !("targets" in args) || args.targets.len() == 0) throw "goal_set needs deadline_year and at least one target";
	local today = GSDate.GetCurrentDate();
	if (args.deadline_year < GSDate.GetYear(today)) throw "deadline_year " + args.deadline_year + " is in the past (it is " + GSDate.GetYear(today) + ")";
	// Check every target before changing anything.
	local targets = [];
	foreach (pair in args.targets) {
		local t = { cargo = -1, label = "VALUE", name = "company value", amount = pair[1], progress = 0, shown = -1, goal = -1, done = false };
		if (pair[0] != "VALUE") {
			t.cargo = this.CargoByLabel(pair[0]);
			if (t.cargo < 0) throw "unknown cargo label '" + pair[0] + "'; run: openttd-agent cargos";
			t.label = pair[0];
			t.name = this.Str(GSCargo.GetName(t.cargo));
		}
		if (t.amount <= 0) throw "target amount for " + t.label + " must be above 0";
		foreach (other in targets) {
			if (other.label == t.label) throw "target " + t.label + " is listed twice";
		}
		targets.append(t);
	}
	this.RemoveGoal(company);
	local g = { company = company, deadline_year = args.deadline_year, set_date = this.DateStr(today), status = "active", targets = targets };
	foreach (t in targets) {
		t.goal = GSGoal.New(company, this.GoalText(t, g.deadline_year), GSGoal.GT_COMPANY, company);
		if (!GSGoal.IsValidGoal(t.goal)) GSLog.Warning("AgentBridge: could not create the goal window entry for " + t.label + "; goal_status still tracks it");
		if (t.cargo >= 0) this.ReadDeliveries(company, t.cargo, true); // starts the monitors; counts from zero
	}
	this.goals.append(g);
	this.UpdateGoals();
	return [this.GoalView(g)];
}

// args: company. Removes the company's goal and its goal window entries.
function AgentBridge::CmdGoalClear(args) {
	local company = this.CheckCompany(args);
	return { removed = this.RemoveGoal(company) };
}

function AgentBridge::RemoveGoal(company) {
	local i = this.GoalIndex(company);
	if (i < 0) return false;
	foreach (t in this.goals[i].targets) {
		if (GSGoal.IsValidGoal(t.goal)) GSGoal.Remove(t.goal);
		if (t.cargo >= 0) this.ReadDeliveries(company, t.cargo, false);
	}
	this.goals.remove(i);
	return true;
}

// args: optional company. Fresh progress. One row per goal:
// { company, status, deadline_year, days_left, set_date, targets = [[label, amount, progress, done], ...] }
function AgentBridge::CmdGoalStatus(args) {
	this.UpdateGoals();
	local out = [];
	foreach (g in this.goals) {
		if (("company" in args) && args.company != g.company) continue;
		out.append(this.GoalView(g));
	}
	return out;
}

function AgentBridge::GoalView(g) {
	local rows = [];
	foreach (t in g.targets) rows.append([t.label, t.amount, t.progress, t.done]);
	local left = GSDate.GetDate(g.deadline_year + 1, 1, 1) - GSDate.GetCurrentDate();
	return { company = g.company, status = g.status, deadline_year = g.deadline_year, days_left = left < 0 ? 0 : left, set_date = g.set_date, targets = rows };
}

// Read progress of every active goal, update the goal window, and settle goals that are met or out of time.
// Runs monthly from the main loop and on every goal_set / goal_status.
function AgentBridge::UpdateGoals() {
	this.goal_month = this.MonthNow();
	local year = GSDate.GetYear(GSDate.GetCurrentDate());
	foreach (g in this.goals) {
		if (g.status != "active") continue;
		if (GSCompany.ResolveCompanyID(g.company) == GSCompany.COMPANY_INVALID) {
			g.status = "failed"; // company gone (bankrupt or merged)
			continue;
		}
		local open = 0;
		foreach (t in g.targets) {
			if (t.cargo < 0) {
				t.progress = GSCompany.GetQuarterlyCompanyValue(g.company, GSCompany.CURRENT_QUARTER);
			} else {
				t.progress += this.ReadDeliveries(g.company, t.cargo, true);
			}
			if (!t.done && t.progress >= t.amount) {
				t.done = true;
				GSGoal.SetCompleted(t.goal, true);
			}
			if (!t.done) open++;
			if (t.progress != t.shown) {
				t.shown = t.progress;
				GSGoal.SetProgress(t.goal, t.progress + " / " + t.amount + " (" + (t.progress * 100 / t.amount) + "%)");
			}
		}
		if (open == 0) {
			this.FinishGoal(g, "done");
		} else if (year > g.deadline_year) {
			this.FinishGoal(g, "failed");
		}
	}
}

function AgentBridge::FinishGoal(g, status) {
	g.status = status;
	foreach (t in g.targets) {
		if (t.cargo >= 0) this.ReadDeliveries(g.company, t.cargo, false);
		if (status == "failed" && !t.done) GSGoal.SetProgress(t.goal, "Not reached: " + t.progress + " / " + t.amount);
	}
	this.PushEvent({ type = "goal_" + status, company = g.company, deadline_year = g.deadline_year });
	GSLog.Info("AgentBridge: goal of company " + g.company + " " + status);
}

// Identifies the map: size and where the lowest-numbered town is.
function AgentBridge::WorldStamp() {
	local first = -1;
	foreach (town, _ in GSTownList()) {
		if (first < 0 || town < first) first = town;
	}
	return GSMap.GetMapSizeX() + "x" + GSMap.GetMapSizeY() + ":" + (first < 0 ? -1 : GSTown.GetLocation(first));
}

// Take over the goals from Load(). scenario-prepare copies this script's saved data from another
// game into a scenario, so goals are only kept when they belong to this map and their goal
// window entries still exist.
function AgentBridge::RestoreGoals() {
	this.world_stamp = this.WorldStamp();
	local data = this.loaded;
	this.loaded = null;
	if (data == null || !("goals" in data) || !("world" in data)) return;
	if (data.world != this.world_stamp) {
		if (data.goals.len() > 0) GSLog.Info("AgentBridge: saved goals belong to another map; dropped");
		return;
	}
	foreach (g in data.goals) {
		local ok = true;
		foreach (t in g.targets) {
			if (!GSGoal.IsValidGoal(t.goal)) ok = false;
		}
		if (ok) {
			this.goals.append(g);
		} else {
			GSLog.Warning("AgentBridge: saved goal of company " + g.company + " has no goal window entry in this game; dropped");
		}
	}
	if ("goal_month" in data) this.goal_month = data.goal_month;
	GSLog.Info("AgentBridge: restored " + this.goals.len() + " goal(s)");
}

// ---- Exec: every state-changing step goes through here ---------------------------

// args: company, steps = [[op, ...], ...]; optional dry_run (GSTestMode: costs only, nothing changes),
// keep_going (default: stop at the first failed step unless dry_run), rail_type, road_type.
// Returns [summary, row, row, ...]: one row [ok, cost, error, value] per attempted step.
// Each real step passes BuildGate, so the rate limits apply to all of them.
function AgentBridge::CmdExec(args) {
	local company = this.CheckCompany(args);
	local dry = ("dry_run" in args) && args.dry_run;
	local keep = ("keep_going" in args) ? args.keep_going : dry;
	local mode = GSCompanyMode(company);
	local test = dry ? GSTestMode() : null;
	if ("rail_type" in args) {
		GSRail.SetCurrentRailType(args.rail_type);
	} else {
		local rail_types = GSRailTypeList();
		if (rail_types.Count() > 0) GSRail.SetCurrentRailType(rail_types.Begin());
	}
	GSRoad.SetCurrentRoadType(("road_type" in args) ? args.road_type : GSRoad.ROADTYPE_ROAD);
	local rows = [];
	local total = 0;
	local failed = 0;
	local stopped = "";
	foreach (st in args.steps) {
		if (!dry) {
			local gate = this.BuildGate(company);
			if (gate != null) {
				stopped = gate;
				break;
			}
		}
		local costs = GSAccounting();
		local res = null;
		try {
			res = this.ExecStep(company, st, dry);
		} catch (e) {
			res = [false, 0, "" + e];
		}
		local cost = costs.GetCosts();
		local err = res[0] ? "" : (res.len() > 2 ? res[2] : this.Str(GSError.GetLastErrorString()));
		total += cost;
		rows.append([res[0], cost, err, res[1]]);
		if (!res[0]) {
			failed++;
			if (!keep) {
				stopped = "step " + (rows.len() - 1) + " failed";
				break;
			}
		}
	}
	rows.insert(0, { dry_run = dry, attempted = rows.len(), failed = failed, cost = total, stopped = stopped, money = GSCompany.GetBankBalance(company) });
	return rows;
}

// One step. Returns [ok, value] or [false, 0, "own error text"]; when the third item is
// missing the caller reports GSError.GetLastErrorString(). value: new vehicle/group id, else 0.
function AgentBridge::ExecStep(company, s, dry) {
	switch (s[0]) {
		// -- groups: [op, vehicle_type, name, parent (-1 none)] / [op, group, name] / [op, group] / [op, group (-1 default), vehicle]
		case "group_create": {
			local g = GSGroup.CreateGroup(s[1], s[3] < 0 ? GSGroup.GROUP_INVALID : s[3]);
			if (g == GSGroup.GROUP_INVALID) return [false, 0];
			if (!dry && s[2] != "") GSGroup.SetName(g, s[2]);
			return [true, g];
		}
		case "group_rename": return [GSGroup.SetName(s[1], s[2]), 0];
		case "group_delete": return [GSGroup.DeleteGroup(s[1]), 0];
		case "group_move": return [GSGroup.MoveVehicle(s[1] < 0 ? GSGroup.GROUP_DEFAULT : s[1], s[2]), 0];
		// [op, group (-1 all), old_engine, new_engine (-1 = stop replacing old_engine)]
		case "autoreplace": {
			local g = s[1] < 0 ? GSGroup.GROUP_ALL : s[1];
			if (s[3] < 0) return [GSGroup.StopAutoReplace(g, s[2]), 0];
			return [GSGroup.SetAutoReplace(g, s[2], s[3]), 0];
		}
		// [op, enabled or null, months or null, money or null]
		case "autorenew": {
			local ok = true;
			if (s[1] != null) ok = GSCompany.SetAutoRenewStatus(s[1]) && ok;
			if (s[2] != null) ok = GSCompany.SetAutoRenewMonths(s[2]) && ok;
			if (s[3] != null) ok = GSCompany.SetAutoRenewMoney(s[3]) && ok;
			return [ok, 0];
		}
		// -- loan (v8): [op, "set", loan] / [op, "add", delta (negative = repay)] / [op, "max", 0].
		// The target is rounded up to a multiple of GetLoanInterval(). value: the target loan.
		case "loan": return this.LoanStep(company, s[1], s[2]);
		// -- orders: [op, vehicle, x, y, flags, position (-1 append)]
		case "order_add": {
			local tile = GSMap.GetTileIndex(s[2], s[3]);
			if (s[5] < 0) return [GSOrder.AppendOrder(s[1], tile, s[4]), 0];
			return [GSOrder.InsertOrder(s[1], s[5], tile, s[4]), 0];
		}
		case "order_remove": return [GSOrder.RemoveOrder(s[1], s[2]), 0];
		case "order_flags": return [GSOrder.SetOrderFlags(s[1], s[2], s[3]), 0];
		case "order_skip": return [GSOrder.SkipToOrder(s[1], s[2]), 0];
		case "order_move": return [GSOrder.MoveOrder(s[1], s[2], s[3]), 0];
		// [op, vehicle, source_vehicle, share]
		case "orders_copy": return [s[3] ? GSOrder.ShareOrders(s[1], s[2]) : GSOrder.CopyOrders(s[1], s[2]), 0];
		case "orders_unshare": return [GSOrder.UnshareOrders(s[1]), 0];
		// -- vehicles: [op, depot_x, depot_y, engine, refit_cargo (-1 none), attach_to_train (-1 none)]
		case "veh_buy": {
			local depot = GSMap.GetTileIndex(s[1], s[2]);
			local v = s[4] < 0 ? GSVehicle.BuildVehicle(depot, s[3]) : GSVehicle.BuildVehicleWithRefit(depot, s[3], s[4]);
			if (v == GSVehicle.VEHICLE_INVALID) return [false, 0];
			if (!dry && s[5] >= 0) {
				if (!GSVehicle.MoveWagonChain(v, 0, s[5], GSVehicle.GetNumWagons(s[5]) - 1)) return [false, v, "bought vehicle " + v + " but could not attach it to train " + s[5] + ": " + this.Str(GSError.GetLastErrorString())];
			}
			return [true, v];
		}
		// [op, depot_x, depot_y, vehicle, share_orders]
		case "veh_clone": {
			local v = GSVehicle.CloneVehicle(GSMap.GetTileIndex(s[1], s[2]), s[3], s[4]);
			return [v != GSVehicle.VEHICLE_INVALID, v];
		}
		// [op, vehicle, want (1 running, 0 stopped, -1 toggle)]
		case "veh_start_stop": {
			if (!GSVehicle.IsValidVehicle(s[1])) return [false, 0, "vehicle " + s[1] + " does not exist or is not yours"];
			local stopped = GSVehicle.GetState(s[1]) == GSVehicle.VS_STOPPED || GSVehicle.IsStoppedInDepot(s[1]);
			if (s[2] == (stopped ? 0 : 1)) return [true, 0];
			return [GSVehicle.StartStopVehicle(s[1]), 0];
		}
		// [op, vehicle, service_only]
		case "veh_depot": return [s[2] ? GSVehicle.SendVehicleToDepotForServicing(s[1]) : GSVehicle.SendVehicleToDepot(s[1]), 0];
		case "veh_sell": return [GSVehicle.SellVehicle(s[1]), 0];
		case "veh_refit": return [GSVehicle.RefitVehicle(s[1], s[2]), 0];
		case "veh_rename": return [GSVehicle.SetName(s[1], s[2]), 0];
		// [op, source_vehicle, source_wagon, dest_vehicle, dest_wagon]
		case "veh_move_wagon": return [GSVehicle.MoveWagonChain(s[1], s[2], s[3], s[4]), 0];
		// -- rail: [op, from_x, from_y, tile_x, tile_y, to_x, to_y] builds on tile..(to - 1), connecting towards from and to
		case "rail": return [this.OrBuilt(GSRail.BuildRail(this.T(s[1], s[2]), this.T(s[3], s[4]), this.T(s[5], s[6]))), 0];
		case "rail_remove": return [GSRail.RemoveRail(this.T(s[1], s[2]), this.T(s[3], s[4]), this.T(s[5], s[6])), 0];
		// [op, x, y, front_x, front_y, signal_type]: the signal faces trains coming from front (GSRail.SIGNALTYPE_*)
		case "signal": return [GSRail.BuildSignal(this.T(s[1], s[2]), this.T(s[3], s[4]), s[5]), 0];
		case "signal_remove": return [GSRail.RemoveSignal(this.T(s[1], s[2]), this.T(s[3], s[4])), 0];
		// [op, x, y, along_y (false = platforms along x), platforms, length, station (-1 new, -2 join adjacent, else id)]
		case "rail_station":
			return [GSRail.BuildRailStation(this.T(s[1], s[2]), s[3] ? GSRail.RAILTRACK_NW_SE : GSRail.RAILTRACK_NE_SW, s[4], s[5], this.StationArg(s[6])), 0];
		// [op, x, y, front_x, front_y]
		case "rail_depot": return [GSRail.BuildRailDepot(this.T(s[1], s[2]), this.T(s[3], s[4])), 0];
		// -- road: [op, x1, y1, x2, y2] straight
		case "road": return [this.OrBuilt(GSRoad.BuildRoad(this.T(s[1], s[2]), this.T(s[3], s[4]))), 0];
		case "road_remove": return [GSRoad.RemoveRoad(this.T(s[1], s[2]), this.T(s[3], s[4])), 0];
		// [op, x, y, front_x, front_y, truck, drive_through, station]
		case "road_station": {
			local kind = s[5] ? GSRoad.ROADVEHTYPE_TRUCK : GSRoad.ROADVEHTYPE_BUS;
			if (s[6]) return [GSRoad.BuildDriveThroughRoadStation(this.T(s[1], s[2]), this.T(s[3], s[4]), kind, this.StationArg(s[7])), 0];
			return [GSRoad.BuildRoadStation(this.T(s[1], s[2]), this.T(s[3], s[4]), kind, this.StationArg(s[7])), 0];
		}
		case "road_depot": return [GSRoad.BuildRoadDepot(this.T(s[1], s[2]), this.T(s[3], s[4])), 0];
		// -- bridges and tunnels: [op, vehicle_type, x1, y1, x2, y2, bridge_type (-1 cheapest, -2 fastest)] / [op, vehicle_type, x, y]
		case "bridge": {
			local a = this.T(s[2], s[3]);
			local b = this.T(s[4], s[5]);
			local kind = s[6] >= 0 ? s[6] : this.PickBridge(GSMap.DistanceManhattan(a, b) + 1, s[6] == -2);
			if (kind < 0) return [false, 0, "no bridge type can span " + (GSMap.DistanceManhattan(a, b) + 1) + " tiles; run: openttd-agent bridge-types"];
			return [GSBridge.BuildBridge(s[1], kind, a, b), kind];
		}
		case "tunnel": return [GSTunnel.BuildTunnel(s[1], this.T(s[2], s[3])), 0];
		// -- water and air: [op, x, y, station] / [op, x, y] / [op, x, y, front_x, front_y] / [op, x, y, airport_type, station]
		case "dock": return [GSMarine.BuildDock(this.T(s[1], s[2]), this.StationArg(s[3])), 0];
		case "buoy": return [GSMarine.BuildBuoy(this.T(s[1], s[2])), 0];
		case "water_depot": return [GSMarine.BuildWaterDepot(this.T(s[1], s[2]), this.T(s[3], s[4])), 0];
		case "airport": return [GSAirport.BuildAirport(this.T(s[1], s[2]), s[3], this.StationArg(s[4])), 0];
		// -- land: [op, x0, y0, x1, y1, allow_houses]; refuses the whole rectangle if any tile is protected
		case "demolish": {
			for (local y = s[2]; y <= s[4]; y++) {
				for (local x = s[1]; x <= s[3]; x++) {
					local why = this.DemolishRefusal(company, this.T(x, y), s[5]);
					if (why != null) return [false, 0, "refused: tile " + x + "," + y + " " + why + "; nothing was demolished"];
				}
			}
			local done = 0;
			for (local y = s[2]; y <= s[4]; y++) {
				for (local x = s[1]; x <= s[3]; x++) {
					if (!GSTile.DemolishTile(this.T(x, y))) return [false, done, "tile " + x + "," + y + ": " + this.Str(GSError.GetLastErrorString()) + " (" + done + " tiles cleared before it)"];
					done++;
				}
			}
			return [true, done];
		}
		// [op, x0, y0, x1, y1]: corner points; everything is levelled to the height of the north corner of x0,y0
		case "level": return [GSTile.LevelTiles(this.T(s[1], s[2]), this.T(s[3], s[4])), 0];
		// [op, x, y, corners]: bitmask 1 west, 2 south, 4 east, 8 north (15 = whole tile)
		case "raise": return [GSTile.RaiseTile(this.T(s[1], s[2]), s[3]), 0];
		case "lower": return [GSTile.LowerTile(this.T(s[1], s[2]), s[3]), 0];
	}
	return [false, 0, "unknown exec op: " + s[0]];
}

// Runs inside CmdExec's GSCompanyMode, so GetLoanAmount/GetMaxLoanAmount read this company.
// Own refusals first: SetLoanAmount's preconditions fail with a bare ERR_PRECONDITION_FAILED.
function AgentBridge::LoanStep(company, kind, n) {
	local cur = GSCompany.GetLoanAmount();
	local max = GSCompany.GetMaxLoanAmount();
	local step = GSCompany.GetLoanInterval();
	local want = n;
	if (kind == "max") {
		want = max;
	} else if (kind == "add") {
		want = cur + n;
	} else if (kind != "set") {
		return [false, 0, "unknown loan kind: " + kind + " (set, add, max)"];
	}
	if (want < 0) return [false, 0, "refused: loan would be " + want + ", below 0 (current loan " + cur + ")"];
	if (want % step != 0) want += step - want % step;
	if (want > max) return [false, want, "refused: loan " + want + " is over max_loan " + max + " (loan interval " + step + ")"];
	local cash = GSCompany.GetBankBalance(company);
	if (want - cur + cash < 0) return [false, want, "refused: repaying " + (cur - want) + " needs that much cash; bank balance is " + cash];
	if (!GSCompany.SetLoanAmount(want)) return [false, want];
	return [true, want];
}

// ---- Construct helpers ----------------------------------------------------------

function AgentBridge::T(x, y) { return GSMap.GetTileIndex(x, y); }

// Building something that is already there counts as success (paths may reuse track/road).
function AgentBridge::OrBuilt(ok) { return ok || GSError.GetLastError() == GSError.ERR_ALREADY_BUILT; }

function AgentBridge::StationArg(v) {
	if (v == -1) return GSBaseStation.STATION_NEW;
	if (v == -2) return GSBaseStation.STATION_JOIN_ADJACENT;
	return v;
}

// Cheapest (or fastest) bridge type for a length in tiles including both ends; -1 if none.
function AgentBridge::PickBridge(length, fastest) {
	local best = -1;
	local best_score = 0;
	foreach (b, _ in GSBridgeList_Length(length)) {
		local score = fastest ? -GSBridge.GetMaxSpeed(b) : GSBridge.GetPrice(b, length);
		if (best < 0 || score < best_score) {
			best = b;
			best_score = score;
		}
	}
	return best;
}

// Why the company may not demolish this tile, or null if it may. The game itself still applies
// its own rules (town rating, money) on top.
function AgentBridge::DemolishRefusal(company, tile, allow_houses) {
	if (!GSMap.IsValidTile(tile)) return "is outside the map";
	if (GSIndustry.IsValidIndustry(GSIndustry.GetIndustryID(tile))) return "is part of an industry";
	if (GSTile.IsHouseTile(tile)) return allow_houses ? null : "is a town building (allow_houses=true permits it; the town's opinion of you drops)";
	local owner = GSTile.GetOwner(tile);
	if (owner != GSCompany.COMPANY_INVALID && owner != company) return "belongs to company " + owner;
	if (owner == GSCompany.COMPANY_INVALID && (GSRoad.IsRoadTile(tile) || GSTile.IsStationTile(tile) || GSBridge.IsBridgeTile(tile) || GSTunnel.IsTunnelTile(tile))) return "is town or public infrastructure";
	return null;
}

// args: company. Rail types the company can build. Rows: [id, name, max_speed (0 = no limit), track_cost_per_tile]
function AgentBridge::CmdRailTypes(args) {
	local mode = GSCompanyMode(this.CheckCompany(args));
	local out = [];
	foreach (rt, _ in GSRailTypeList()) {
		out.append([rt, this.Str(GSRail.GetName(rt)), GSRail.GetMaxSpeed(rt), GSRail.GetBuildCost(rt, GSRail.BT_TRACK)]);
	}
	return out;
}

// args: length (tiles including both ends), vehicle_type (0 rail, 1 road).
// Rows: [id, name, max_speed, price, min_length, max_length]
function AgentBridge::CmdBridgeTypes(args) {
	local out = [];
	foreach (b, _ in GSBridgeList_Length(args.length)) {
		out.append([b, this.Str(GSBridge.GetName(b, args.vehicle_type)), GSBridge.GetMaxSpeed(b), GSBridge.GetPrice(b, args.length),
			GSBridge.GetMinLength(b), GSBridge.GetMaxLength(b)]);
	}
	return out;
}
