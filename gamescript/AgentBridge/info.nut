// AgentBridge: relays JSON requests from the admin port to the GS API and
// replies with GSAdmin.Send. Protocol: see docs/PROTOCOL.md in the package.
// Installed by `openttd-agent install-gamescript`. Only the HOST needs it.
class AgentBridge extends GSInfo {
	function GetAuthor()      { return "openttd-agent"; }
	function GetName()        { return "AgentBridge"; }
	function GetDescription() { return "Lets coding agents query the world and build for their company over the admin port."; }
	function GetVersion()     { return 2; }
	function GetDate()        { return "2026-11-24"; }
	function CreateInstance() { return "AgentBridge"; }
	function GetShortName()   { return "AGBR"; }
	function GetAPIVersion()  { return "15"; }
	function GetURL()         { return "https://github.com/mmmnorthmark/openttd-agent"; }
	function IsDeveloperOnly() { return false; }

	function GetSettings() {
		AddSetting({ name = "command_delay_ticks",
			description = "Extra ticks to wait after every build command (0 = full speed)",
			min_value = 0, max_value = 74, default_value = 0, step_size = 1,
			flags = CONFIG_INGAME });
		AddSetting({ name = "max_builds_per_day",
			description = "Max build commands per company per game day (0 = unlimited)",
			min_value = 0, max_value = 1000, default_value = 0, step_size = 5,
			flags = CONFIG_INGAME });
	}
}
RegisterGS(AgentBridge());
