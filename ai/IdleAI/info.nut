// IdleAI: owns a company and does nothing. Used only so a dedicated server
// without human clients has a company for the AgentBridge GameScript to act as.
class IdleAI extends AIInfo {
	function GetAuthor()      { return "openttd-agent"; }
	function GetName()        { return "IdleAI"; }
	function GetDescription() { return "Does nothing; lets a GameScript build for this company."; }
	function GetVersion()     { return 1; }
	function GetDate()        { return "2026-11-24"; }
	function CreateInstance() { return "IdleAI"; }
	function GetShortName()   { return "IDLE"; }
	function GetAPIVersion()  { return "15"; }
}
RegisterAI(IdleAI());
