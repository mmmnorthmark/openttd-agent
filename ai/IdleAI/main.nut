class IdleAI extends AIController {
	function Start() {
		AICompany.SetName("Agent Test Co");
		while (true) { this.Sleep(740); }
	}
	function Save() { return {}; }
	function Load(version, data) {}
}
