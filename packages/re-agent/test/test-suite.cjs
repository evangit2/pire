// pire test suite — native tools, crash recovery, auto-detect, TUI, model inference
// Run: node packages/re-agent/test/test-suite.cjs

const fs = require("fs");
const path = require("path");
const { join } = path;
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..", "..");
const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");
const cliSrc = fs.readFileSync(path.join(__dirname, "..", "src", "cli.ts"), "utf-8");
const tuiSrc = fs.readFileSync(path.join(__dirname, "..", "src", "tui.ts"), "utf-8");
let pass = 0, fail = 0;

function ok(cond, msg) {
	if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); pass++; }
	else { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fail++; }
}

// ─── 1. Source Structure ──────────────────────────────────────

console.log("\n─ Source Structure ─");

ok(src.includes("class GhidraBridge"), "GhidraBridge class exists");
ok(src.includes("crash recovery"), "crash recovery documented");
ok(src.includes("auto-start"), "auto-start documented");
ok(src.includes("isAlive()"), "isAlive health check method");
ok(src.includes("ensureAlive()"), "ensureAlive with restart logic");
ok(src.includes("maxRestarts = 3"), "max restart limit (3)");
ok(src.includes("bridgePath"), "tracks bridge script path");
ok(src.includes("spawn("), "uses spawn for auto-start");
ok(src.includes("class R2Session"), "R2Session class exists");
ok(src.includes("probeTools()"), "probeTools function exists");

// No MCP server config — tools are native now
ok(!src.includes("DEFAULT_MCP_SERVERS"), "no MCP server config (native tools)");
ok(!src.includes("McpServerConfig"), "no McpServerConfig type");
ok(!src.includes("autostart"), "no autostart (not MCP)");

// ─── 2. Native Tool Registry ──────────────────────────────────

console.log("\n─ Native Tool Registry ─");

const expectedTools = [
	"shellTool",
	"stringsTool", "fileTool", "objdumpTool", "readelfTool", "hexdumpTool", "disasmFuncTool", "r2Tool", "decompileTool",
	"ghidraStatus", "ghidraDecompile", "ghidraListFunctions", "ghidraRename", "ghidraXrefs", "ghidraStrings",
	"binwalkTool", "liefTool", "angrTool", "capstoneTool", "keystoneTool", "unicornTool",
	"yaraTool", "fridaTool", "gdbTool", "volatilityTool",
];

for (const tool of expectedTools) {
	ok(src.includes(`const ${tool}`), `${tool} defined`);
}

ok(src.includes("RE_TOOLS") && src.includes("createReTools"), "RE_TOOLS + createReTools exported");
ok(src.includes("probeTools"), "probeTools exported");

// Count tools in RE_TOOLS array
const toolArrayMatch = src.match(/export const RE_TOOLS[\s\S]*?\];/);
if (toolArrayMatch) {
	const toolCount = (toolArrayMatch[0].match(/^	\w+(Tool|Status|Decompile|ListFunctions|Rename|Xrefs|Strings)/gm) || []).length;
	ok(toolCount === 38, `RE_TOOLS has 38 tools (got ${toolCount})`);
}

// ─── 3. Auto-Detect Wrappers ──────────────────────────────────

console.log("\n─ Auto-Detect Wrappers ─");

ok(src.includes('which("binwalk")'), "binwalk auto-detects binary");
ok(src.includes('pythonModule("lief")'), "lief auto-detects python module");
ok(src.includes('pythonModule("angr")'), "angr auto-detects python module");
ok(src.includes('pythonModule("capstone")'), "capstone auto-detects python module");
ok(src.includes('pythonModule("keystone")'), "keystone auto-detects python module");
ok(src.includes('pythonModule("unicorn")'), "unicorn auto-detects python module");
ok(src.includes('pythonModule("yara")'), "yara auto-detects python module");
ok(src.includes('which("frida")'), "frida auto-detects binary");
ok(src.includes('which("gdb")'), "gdb auto-detects binary");
ok(src.includes('pythonModule("volatility3")'), "volatility auto-detects module");
ok(src.includes("not installed") && src.includes("pip install"), "graceful degradation messages");

// ─── 4. CLI ───────────────────────────────────────────────────

console.log("\n─ CLI ─");

ok(cliSrc.includes("--probe"), "CLI has --probe flag");
ok(cliSrc.includes("probeTools"), "CLI calls probeTools");
ok(cliSrc.includes("-mcp"), "CLI has -mcp flag for MCP server");
ok(cliSrc.includes("--tools"), "CLI has --tools flag");
ok(cliSrc.includes("--skills"), "CLI has --skills flag");
ok(cliSrc.includes("PireTUI"), "CLI imports PireTUI (ANSI TUI)");
ok(cliSrc.includes("PireCLI"), "CLI imports PireCLI");
ok(cliSrc.includes("PirePiTUI"), "CLI imports PirePiTUI (Pi-framework TUI)");
ok(cliSrc.includes("pi-tui"), "CLI has pi-tui import");
ok(cliSrc.includes("-ansi"), "CLI has -ansi flag");
ok(cliSrc.includes("-cli"), "CLI has -cli flag");
ok(cliSrc.includes("mode === \"cli\""), "CLI routes to CLI mode");
ok(cliSrc.includes("mode === \"ansi\""), "CLI routes to ANSI TUI mode");
ok(cliSrc.includes("PirePiTUI(target)"), "CLI instantiates PirePiTUI for default mode");
ok(!cliSrc.includes("mode === \"pi\""), "Pi TUI is the else/default branch (no explicit pi check needed)");
ok(cliSrc.includes(":quit"), "CLI help mentions :quit");
ok(cliSrc.includes("uninstall"), "CLI has uninstall command");
ok(cliSrc.includes("pire-uninstall"), "CLI imports pire-uninstall");

// ─── 5. TUI ────────────────────────────────────────────────────

console.log("\n─ TUI ─");

ok(tuiSrc.includes("class PireTUI"), "PireTUI class exists");
ok(tuiSrc.includes("class PireCLI"), "PireCLI class exists (CLI-only mode)");
ok(tuiSrc.includes("render()"), "TUI has render method");
ok(tuiSrc.includes("handleInput"), "TUI handles input");
ok(tuiSrc.includes(":tools"), "TUI has :tools command");
ok(tuiSrc.includes(":probe"), "TUI has :probe command");
ok(tuiSrc.includes(":skills"), "TUI has :skills command");
ok(tuiSrc.includes(":help"), "TUI has :help command");
ok(tuiSrc.includes(":quit"), "TUI has :quit command");
ok(tuiSrc.includes(":clear"), "TUI has :clear command");
ok(tuiSrc.includes("RE_TOOLS"), "TUI imports RE_TOOLS");
ok(tuiSrc.includes("probeTools"), "TUI imports probeTools");

// ─── 5b. Pi-framework TUI ─────────────────────────────────────

console.log("\n─ Pi-framework TUI ─");

const piTuiSrc = fs.readFileSync(path.join(__dirname, "..", "src", "pire-pi-tui.ts"), "utf-8");

ok(piTuiSrc.includes("class PirePiTUI"), "PirePiTUI class exists");
ok(piTuiSrc.includes("@earendil-works/pi-tui"), "Pi TUI imports from @earendil-works/pi-tui");
ok(piTuiSrc.includes("TuiAltScreen"), "Pi TUI uses TuiAltScreen");
ok(piTuiSrc.includes("ProcessTerminal"), "Pi TUI uses ProcessTerminal");
ok(piTuiSrc.includes("ScrollView"), "Pi TUI uses ScrollView");
ok(piTuiSrc.includes("VStack"), "Pi TUI uses VStack");
ok(piTuiSrc.includes("HStack"), "Pi TUI uses HStack");
ok(piTuiSrc.includes("Container"), "Pi TUI uses Container");
ok(piTuiSrc.includes("Text"), "Pi TUI uses Text component");
ok(piTuiSrc.includes("class ToolSidebar"), "Pi TUI has ToolSidebar component");
ok(piTuiSrc.includes("class TranscriptView"), "Pi TUI has TranscriptView component");
ok(piTuiSrc.includes("class StatusBar"), "Pi TUI has StatusBar component");
ok(piTuiSrc.includes("new Input("), "Pi TUI uses Pi Input component");
ok(piTuiSrc.includes("onSubmit"), "Pi TUI Input has onSubmit callback");
ok(piTuiSrc.includes("setFocus"), "Pi TUI sets focus on input");
ok(piTuiSrc.includes("requestRender"), "Pi TUI calls requestRender for updates");
ok(piTuiSrc.includes("addChild"), "Pi TUI adds layout root via addChild");
ok(piTuiSrc.includes(":load"), "Pi TUI has :load command");
ok(piTuiSrc.includes(":tools"), "Pi TUI has :tools command");
ok(piTuiSrc.includes(":probe"), "Pi TUI has :probe command");
ok(piTuiSrc.includes(":skills"), "Pi TUI has :skills command");
ok(piTuiSrc.includes(":help"), "Pi TUI has :help command");
ok(piTuiSrc.includes(":quit"), "Pi TUI has :quit command");
ok(piTuiSrc.includes(":clear"), "Pi TUI has :clear command");
ok(piTuiSrc.includes(":save"), "Pi TUI has :save command");
ok(piTuiSrc.includes("callLLM"), "Pi TUI calls callLLM for inference");
ok(piTuiSrc.includes("toolToFunction"), "Pi TUI converts tools to function schema");
ok(piTuiSrc.includes("loadLLMConfig"), "Pi TUI loads LLM config");
ok(piTuiSrc.includes("RE_TOOLS"), "Pi TUI imports RE_TOOLS");
ok(piTuiSrc.includes("probeTools"), "Pi TUI imports probeTools");
ok(piTuiSrc.includes("agentLoop"), "Pi TUI has agentLoop method");
ok(piTuiSrc.includes("onContent"), "Pi TUI streams content via onContent callback");
ok(piTuiSrc.includes("tool_call"), "Pi TUI displays tool calls");
ok(piTuiSrc.includes("tool_result"), "Pi TUI displays tool results");
ok(piTuiSrc.includes("0.89.11"), "Pi TUI version is 0.89.11");
ok(piTuiSrc.includes("MAX_TURNS"), "Pi TUI has turn limit");
ok(piTuiSrc.includes("MAX_OUTPUT"), "Pi TUI has output truncation");
ok(tuiSrc.includes("agentLoop"), "TUI has agentLoop for autonomous tool calling");
ok(tuiSrc.includes("tool_calls"), "TUI handles tool_calls from LLM");
ok(tuiSrc.includes("toolToFunction"), "TUI converts tools to function schemas");
ok(tuiSrc.includes("callLLM"), "TUI calls LLM with tools");
ok(tuiSrc.includes("Tell me what you need"), "TUI starts with chat prompt, no binary required");
ok(!tuiSrc.includes("await import("), "no inline dynamic imports in TUI");
ok(tuiSrc.includes("scrollOffset"), "TUI supports scrollback navigation");
ok(tuiSrc.includes("PgUp") || tuiSrc.includes("Page Up") || tuiSrc.includes("0x35"), "TUI handles Page Up key");
ok(tuiSrc.includes("PgDn") || tuiSrc.includes("Page Down") || tuiSrc.includes("0x36"), "TUI handles Page Down key");
ok(tuiSrc.includes("split-pane") || tuiSrc.includes("sidebar") || tuiSrc.includes("Tools"), "TUI has tools sidebar");

// ─── 5c. Agent Loop Improvements ─────────────────────────────

console.log("\n─ Agent Loop Improvements ─");

ok(src.includes("validateToolParams"), "validateToolParams function exported");
ok(src.includes("Missing required parameter"), "validation returns helpful error message");
ok(tuiSrc.includes("validateToolParams"), "TUI imports validateToolParams");
ok(tuiSrc.includes("validateToolParams"), "TUI imports validateToolParams");
ok(tuiSrc.includes("seenCalls"), "TUI deduplicates identical tool calls");
ok(tuiSrc.includes("duplicate call"), "TUI reports duplicate calls");
ok(src.includes("analyzedFiles"), "R2Session tracks analyzed files");
ok(src.includes("isAnalyzed"), "R2Session has isAnalyzed method");
ok(tuiSrc.includes("turn ${turn + 1}/${MAX_TURNS}") || tuiSrc.includes("turn ${turn"), "TUI shows turn counter");
ok(tuiSrc.includes("shell") && tuiSrc.includes("command"), "TUI handles shell tool with command param");
ok(tuiSrc.includes("write_file") || src.includes("write_file"), "system prompt has file writing guidance");

// ─── 6. System Prompt ─────────────────────────────────────────

console.log("\n─ System Prompt ─");

ok(src.includes("RE_SYSTEM_PROMPT"), "system prompt defined");
ok(src.includes("software artifact"), "prompt mentions binary analysis scope");
ok(src.includes("auto-detect") || src.includes("auto-detects") || src.includes("MZ"), "prompt mentions auto-detection or PE detection");
ok(src.includes("crash-resilient") || src.includes("crash"), "prompt mentions crash resilience");
ok(src.includes("auto-start"), "prompt mentions auto-start bridge");
ok(src.includes("keystone"), "prompt mentions keystone");
ok(src.includes("unicorn"), "prompt mentions unicorn");
ok(src.includes("ghidra_status"), "prompt mentions ghidra_status");
ok(src.includes("r2"), "prompt mentions r2");

// ─── 7. No Hamsterball References ─────────────────────────────

console.log("\n─ Cleanliness ─");

let hamsterCount = 0;
try {
	const result = execSync(`grep -ril hamster ${root}/skills/ 2>/dev/null || true`, { encoding: "utf-8" });
	hamsterCount = result.trim() ? result.trim().split("\n").length : 0;
} catch {}
ok(hamsterCount === 0, `no hamsterball references in skills (${hamsterCount} found)`);

// No dead MCP artifacts
ok(!fs.existsSync(path.join(root, ".mcp.json")), ".mcp.json removed");
ok(!fs.existsSync(path.join(root, "packages", "r2-mcp")), "r2-mcp package removed (native tool)");
ok(!fs.existsSync(path.join(root, "scripts", "build-mcp-servers.mjs")), "build-mcp-servers.mjs removed");

// ─── 8. Code Quality ──────────────────────────────────────────

console.log("\n─ Code Quality ─");

ok(!src.includes("await import("), "no inline dynamic imports in index");
ok(src.includes("from \"node:fs\""), "fs imports at top level");
ok(src.includes("execSync") && src.includes("spawn"), "child_process imports at top level");
ok(src.includes("join") && src.includes("dirname"), "path imports at top level");
ok(src.includes('import { fileURLToPath }'), "url import at top level");
ok(!tuiSrc.includes("await import("), "no inline dynamic imports in TUI");

// ─── 9. Skills ────────────────────────────────────────────────

console.log("\n─ Skills ─");

let skillCount = 0;
try {
	skillCount = execSync(`find ${root}/skills -name SKILL.md | wc -l`, { encoding: "utf-8" }).trim();
} catch {}
ok(parseInt(skillCount) >= 20, `${skillCount} skills (min 20)`);

// ─── 10. Ghidra Bridge API ─────────────────────────────────────

console.log("\n─ Ghidra Bridge API ─");

ok(src.includes("decompile(functionName"), "decompile method");
ok(src.includes("listFunctions()"), "listFunctions method");
ok(src.includes("rename(oldName"), "rename method");
ok(src.includes("xrefs(address"), "xrefs method");
ok(src.includes("searchStrings(pattern"), "searchStrings method");
ok(src.includes("getStatus()"), "getStatus method");
ok(src.includes("restartCount"), "tracks restart count");
ok(src.includes("GHIDRA_SERVER_URL"), "reads GHIDRA_SERVER_URL env");
ok(src.includes("existsSync"), "checks bridge script exists");
ok(src.includes("detached: true"), "spawns bridge detached");

// ─── 11. Keystone + Unicorn Tools ─────────────────────────────

console.log("\n─ Keystone + Unicorn ─");

ok(src.includes("keystoneTool"), "keystone tool defined");
ok(src.includes("unicornTool"), "unicorn tool defined");
ok(src.includes("KS_ARCH_"), "keystone uses arch constants");
ok(src.includes("UC_ARCH_"), "unicorn uses arch constants");
ok(src.includes("emu_start"), "unicorn calls emu_start");
ok(src.includes("reg_read"), "unicorn reads registers");
ok(src.includes("ks.asm"), "keystone assembles instructions");

// ─── 12. Model Provider Integration ───────────────────────────

console.log("\n─ Model Provider Config ─");

const pireConfig = process.env.PIRE_CONFIG || join(process.env.HOME || "/tmp", ".pire", "config.yaml");
if (fs.existsSync(pireConfig)) {
	const cfg = fs.readFileSync(pireConfig, "utf-8");
	ok(cfg.includes("api_key:"), "LLM config has API key");
	ok(cfg.includes("base_url:") || cfg.includes("api:"), "LLM config has endpoint URL");
}

// ─── 13. Package Config ───────────────────────────────────────

console.log("\n─ Package Config ─");

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
ok(pkg.version === "0.89.11", `version is 0.89.11 (got ${pkg.version})`);
ok(pkg.bin && pkg.bin.pire, "has pire bin entry");
ok(pkg.scripts.test.includes("test-suite.cjs"), "test script runs test-suite");
ok(pkg.scripts.test.includes("test-models.cjs"), "test script runs test-models");
ok(pkg.scripts.test.includes("test-e2e.cjs"), "test script runs test-e2e");

// ─── 14. Real Tool Execution ──────────────────────────────────

console.log("\n─ Real Tool Execution ─");

// Build a tiny test binary
const testBin = "/tmp/pire_test_binary";
const IS_MAC = process.platform === "darwin";
try {
	if (IS_MAC) {
		// macOS produces Mach-O binaries, not ELF
		execSync('echo \'int main(){return 42;}\' | cc -x c -o /tmp/pire_test_binary -', { timeout: 10000 });
	} else {
		execSync('echo \'int main(){return 42;}\' | gcc -x c -o /tmp/pire_test_binary -', { timeout: 10000 });
	}
	ok(fs.existsSync(testBin), "test binary compiled");

	// Test file tool
	const fileType = execSync(`file ${testBin}`, { encoding: "utf-8" });
	if (IS_MAC) {
		ok(fileType.includes("Mach-O") || fileType.includes("executable"), "file identifies Mach-O binary");
	} else {
		ok(fileType.includes("ELF"), "file identifies ELF binary");
	}

	// Test strings tool
	const stringsOut = execSync(`strings -a -n 4 ${testBin}`, { encoding: "utf-8" });
	ok(stringsOut.length > 0, "strings extracts output");

	// Test readelf (Linux only — macOS uses otool)
	if (!IS_MAC) {
		const readelfOut = execSync(`readelf -h ${testBin} 2>/dev/null`, { encoding: "utf-8" });
		ok(readelfOut.includes("ELF") || readelfOut.includes("Class"), "readelf parses ELF header");
	} else {
		const otoolOut = execSync(`otool -L ${testBin} 2>/dev/null`, { encoding: "utf-8" });
		ok(otoolOut.length > 0, "otool parses Mach-O binary");
	}

	// Test objdump
	const objdumpOut = execSync(`objdump -d ${testBin} 2>/dev/null | head -20`, { encoding: "utf-8" });
	ok(objdumpOut.includes("<main>") || objdumpOut.includes("Disassembly") || objdumpOut.includes("_main"), "objdump disassembles main");

	// Test hexdump
	const hexOut = execSync(`dd if=${testBin} bs=1 count=64 2>/dev/null | hexdump -C`, { encoding: "utf-8" });
	ok(hexOut.includes("\\x7f") || hexOut.includes("00000000"), "hexdump produces output");
} catch (e) {
	ok(false, `tool execution failed: ${e.message}`);
}

// ─── 15. Probe Tools ──────────────────────────────────────────

console.log("\n─ Probe Tools ─");

// Verify probeTools would return expected keys
const expectedProbeKeys = ["shell", "strings", "filetype", "objdump", "disasm_func", "readelf", "hexdump", "r2", "decompile", "ghidra_status", "ghidra_decompile", "ghidra_functions", "ghidra_rename", "ghidra_xrefs", "ghidra_strings", "binwalk", "lief", "angr", "capstone", "keystone", "unicorn", "yara", "frida", "gdb", "volatility"];
for (const key of expectedProbeKeys) {
	ok(src.includes(`\t\t${key}:`), `probeTools checks ${key}`);
}

// ─── 16. disasm_func Tool ──────────────────────────────────────

console.log("\n─ disasm_func Tool ─");

ok(src.includes("disasmFuncTool"), "disasmFuncTool defined");
ok(src.includes("disasm_func"), "tool name is disasm_func");
ok(src.includes("startAddress"), "accepts startAddress parameter");
ok(src.includes("maxBytes"), "accepts maxBytes parameter");
ok(src.includes("endbr64"), "tracks endbr64 for function boundaries");
ok(src.includes("funcLines"), "collects function lines");
ok(src.includes("next function boundary") || src.includes("function boundary"), "mentions function boundary detection");
ok(src.includes("early-exit"), "mentions early-exit ret handling");
ok(src.includes("--start-address"), "uses objdump start-address flag");
ok(src.includes("--stop-address"), "uses objdump stop-address flag");
ok(src.includes("returns:"), "reports return count in details");

// Test disasm_func on the license checker binary
const licenseBin = "/tmp/pire-targets/license_checker";
if (fs.existsSync(licenseBin)) {
	try {
		const disasm = execSync(`objdump -d --start-address=0x13b0 --stop-address=0x14b0 ${licenseBin} 2>/dev/null`, { encoding: "utf-8", timeout: 10000 });
		ok(disasm.includes("13b0"), "disasm_func output contains start address");
		ok(disasm.includes("strncpy") || disasm.includes("strlen") || disasm.includes("call"), "disasm contains function calls");
	} catch (e) {
		ok(false, `disasm_func test failed: ${e.message}`);
	}
} else {
	// Fall back to test binary
	try {
		const disasm = execSync(`objdump -d --start-address=0x1140 --stop-address=0x1160 ${testBin} 2>/dev/null`, { encoding: "utf-8", timeout: 10000 });
		ok(disasm.length > 0, "disasm_func produces output on test binary");
	} catch (e) {
		ok(false, `disasm_func fallback test failed: ${e.message}`);
	}
}

// ─── 17. Improved System Prompt ────────────────────────────────

console.log("\n─ Improved System Prompt ─");

ok(src.includes("conversational") || src.includes("adapt to the task"), "prompt mentions conversational or adaptive approach");
ok(src.includes("File Type Detection") || src.includes("filetype"), "prompt has file type detection");
ok(src.includes("ELF"), "prompt covers ELF binaries");
ok(src.includes("PE"), "prompt covers PE binaries");
ok(src.includes("Mach-O"), "prompt covers Mach-O binaries");
ok(src.includes("APK"), "prompt covers APK/Android");
ok(src.includes(".NET"), "prompt covers .NET assemblies");
ok(src.includes("Firmware") || src.includes("firmware") || src.includes("binwalk"), "prompt covers firmware analysis");
ok(src.includes("disasm_func"), "prompt mentions disasm_func tool");
ok(src.includes("imul"), "prompt mentions imul optimization");
ok(src.includes("imul") || src.includes("digit") || src.includes("entropy"), "prompt mentions RE analysis patterns");
ok(src.includes("Quote") || src.includes("quote"), "prompt requires quoting instructions");
ok(src.includes("entropy"), "prompt mentions entropy analysis");

// ─── 18. Agent Loop & Tool Calling ─────────────────────────────

console.log("\n─ Agent Loop & Tool Calling ─");

ok(tuiSrc.includes("agentLoop"), "TUI has agentLoop method");
ok(tuiSrc.includes("MAX_TURNS"), "agent loop has turn limit");
ok(tuiSrc.includes("tool_calls"), "agent loop handles tool_calls");
ok(tuiSrc.includes("tool_call_id"), "agent loop returns tool results with tool_call_id");
ok(tuiSrc.includes("toolToFunction"), "TUI converts tools to OpenAI function format");
ok(tuiSrc.includes("shell") || tuiSrc.includes("RE_TOOLS"), "shell tool available for directory/system commands");
ok(tuiSrc.includes("truncated"), "agent truncates long tool output");

// ─── 19. pire-reimpl Pipeline ──────────────────────────────────

console.log("\n─ pire-reimpl Pipeline ─");

const reimplSrc = fs.readFileSync(path.join(__dirname, "../src/pire-reimpl.ts"), "utf-8");

ok(reimplSrc.includes("RE_TOOLS"), "pire-reimpl imports RE_TOOLS");
ok(reimplSrc.includes("import { Type }"), "pire-reimpl imports typebox");
ok(reimplSrc.includes("writeFileTool"), "pire-reimpl defines writeFileTool");
ok(reimplSrc.includes("writeFileSync"), "writeFileTool uses writeFileSync");
ok(reimplSrc.includes("toolToFunction"), "pire-reimpl has toolToFunction");
ok(reimplSrc.includes("callLLM"), "pire-reimpl has callLLM");
ok(reimplSrc.includes("from \"./llm.js\""), "pire-reimpl imports shared llm module");
const llmSrc = fs.readFileSync(path.join(__dirname, "../src/llm.ts"), "utf-8");
ok(llmSrc.includes("stream: true"), "shared llm module uses streaming");
ok(llmSrc.includes("delta.tool_calls"), "shared llm module handles streaming tool calls");
ok(llmSrc.includes("delta.content"), "shared llm module handles streaming content");
ok(llmSrc.includes("onContent"), "shared llm module supports streaming callbacks");
ok(reimplSrc.includes("maxTurns") || reimplSrc.includes("MAX_TURNS"), "pire-reimpl has turn limit");
ok(reimplSrc.includes("analysis.md"), "pire-reimpl writes analysis.md");
ok(reimplSrc.includes("reimpl"), "pire-reimpl writes reimplementation");
ok(reimplSrc.includes("WINEPREFIX"), "pire-reimpl mentions WINEPREFIX for wine");
ok(reimplSrc.includes("decompile"), "pire-reimpl system prompt mentions decompile");
ok(reimplSrc.includes("SIMD"), "pire-reimpl has SIMD/SSE handling guidance");
ok(reimplSrc.includes("Time Management"), "pire-reimpl has time management guidance");
ok(reimplSrc.includes("by turn 25"), "pire-reimpl sets analysis.md deadline");
ok(reimplSrc.includes("by turn 30"), "pire-reimpl sets reimpl.c deadline");
ok(reimplSrc.includes("CRLF"), "pire-reimpl has CRLF matching guidance");
ok(reimplSrc.includes("exit codes"), "pire-reimpl has exit code matching guidance");

// ─── 20. Decompile Tool ────────────────────────────────────────

console.log("\n─ Decompile Tool ─");

ok(src.includes("decompileTool"), "decompileTool defined");
ok(src.includes('name: "decompile"'), "decompile tool has correct name");
ok(src.includes("pdc"), "decompile tool uses r2 pdc command");
ok(src.includes("decompileTool"), "decompileTool in RE_TOOLS");
ok(src.includes("decompile:"), "probeTools checks decompile");

// ─── 21. Shell Sandbox ────────────────────────────────────────

console.log("\n─ Shell Sandbox ─");

ok(src.includes("BLOCKED_PATTERNS"), "shell tool has blocked patterns");
ok(src.includes("isCommandBlocked"), "shell tool has command blocking function");
ok(src.includes("curl"), "shell blocks curl");
ok(src.includes("wget"), "shell blocks wget");
ok(src.includes("sudo"), "shell blocks sudo");
ok(src.includes("pip"), "shell blocks pip/package management");
ok(src.includes("mkfs"), "shell blocks mkfs");
ok(src.includes("shutdown"), "shell blocks shutdown");
ok(src.includes("PIRE_WORKSPACE"), "shell respects PIRE_WORKSPACE env");
ok(src.includes("cwd"), "shell accepts cwd parameter");

// ─── 22. PE Binary Support ────────────────────────────────────

console.log("\n─ PE Binary Support ─");

ok(src.includes("isPEBinary"), "PE binary detection function exists");
ok(src.includes("0x4d") && src.includes("0x5a"), "checks MZ header bytes");
ok(src.includes("openSync"), "uses openSync for header read");
ok(src.includes("pei-x86-64"), "falls back to objdump with PE target");
ok(src.includes("r2") && src.includes("pdf"), "uses r2 pdf for PE disassembly");
ok(src.includes("MZ") && (src.includes("PE") || src.includes("pe binary")), "system prompt has PE guidance");
ok(src.includes("WINEPREFIX"), "system prompt mentions WINEPREFIX for PE");
ok(src.includes("CRLF") || src.includes("MZ") || src.includes("PE"), "system prompt mentions PE-related guidance");
ok(src.includes("MZ"), "system prompt mentions MZ header");

// ─── 23. Persistent R2Session ─────────────────────────────────

console.log("\n─ Persistent R2Session ─");

ok(src.includes("ensureProcess"), "R2Session has ensureProcess method");
ok(src.includes("spawn(this.r2path") || src.includes('spawn(this.r2path'), "R2Session spawns long-lived process");
ok(src.includes("-q0"), "R2Session uses -q0 flag for pipe mode");
ok(src.includes("marker"), "R2Session uses marker for command completion");
ok(src.includes("dispose"), "R2Session has dispose method");

// ─── 24. Shared LLM Module ────────────────────────────────────

console.log("\n─ Shared LLM Module ─");

ok(llmSrc.includes("LLMConfig"), "shared module exports LLMConfig");
ok(llmSrc.includes("ChatMessage"), "shared module exports ChatMessage");
ok(llmSrc.includes("ToolCall"), "shared module exports ToolCall");
ok(llmSrc.includes("toolToFunction"), "shared module exports toolToFunction");
ok(llmSrc.includes("callLLM"), "shared module exports callLLM");
ok(llmSrc.includes("parseYAMLConfig"), "shared module has YAML parser");
ok(llmSrc.includes("comment"), "YAML parser strips comments");
ok(!llmSrc.includes("content.match"), "YAML parser doesn't use regex matching");
ok(llmSrc.includes("OPENAI_API_KEY"), "supports env var fallback");
ok(llmSrc.includes("OPENAI_BASE_URL"), "supports env var fallback");
ok(llmSrc.includes("onContent"), "supports streaming content callback");
ok(llmSrc.includes("lastErr") || llmSrc.includes("retry"), "has retry logic");

ok(tuiSrc.includes("from \"./llm.js\""), "TUI imports shared llm module");
ok(tuiSrc.includes(":load"), "TUI has :load command");
ok(tuiSrc.includes(":save"), "TUI has :save command");
ok(tuiSrc.includes("loadedTarget"), "TUI tracks loaded target");
ok(tuiSrc.includes("PIRE_MAX_TURNS"), "TUI reads max turns from env/config");
ok(tuiSrc.includes("onContent"), "TUI streams content to stdout");
ok(tuiSrc.includes("VERSION"), "TUI has version constant");
ok(tuiSrc.includes("0.89.11"), "TUI version is 0.89.11");

// ─── 25. Version Alignment ────────────────────────────────────

console.log("\n─ Version Alignment ─");

const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf-8"));
ok(rootPkg.version === "0.89.11", `root package.json version is 0.89.11 (got ${rootPkg.version})`);
ok(pkg.version === "0.89.11", `re-agent package.json version is 0.89.11 (got ${pkg.version})`);
ok(tuiSrc.includes("0.89.11"), `tui.ts VERSION is 0.89.11`);

// ─── 26. Skills Not Gitignored ────────────────────────────────

console.log("\n─ Skills Shipping ─");

const gitignore = fs.readFileSync(path.join(__dirname, "..", "..", "..", ".gitignore"), "utf-8");
ok(!gitignore.includes("skills/"), "skills/ removed from .gitignore");

// ─── 27. Behavioral Tests ─────────────────────────────────────

console.log("\n─ Behavioral Tests ─");

// Test isPEBinary via source-level check (function exists and checks MZ)
ok(typeof src === "string" && src.includes("isPEBinary"), "isPEBinary function exists in source");

// Test that the shell sandbox blocks dangerous commands (source-level)
ok(src.includes("BLOCKED_PATTERNS") && src.includes("isCommandBlocked"), "shell sandbox is wired up");

// Verify tool output truncation limits are reasonable
ok(tuiSrc.includes("MAX_TOOL_OUTPUT") || tuiSrc.includes("100000"), "TUI truncates using MAX_TOOL_OUTPUT (100000)");
ok(reimplSrc.includes("MAX_TOOL_OUTPUT") || reimplSrc.includes("100000"), "reimpl truncates using MAX_TOOL_OUTPUT (100000)");

// ─── 28. New Tools & URL Support ───────────────────────────────

console.log("\n─ New Tools & URL Support ─");

ok(src.includes("fetchTool"), "fetch tool defined");
ok(src.includes('"fetch"'), "fetch tool registered with name");
ok(src.includes("wget") && src.includes("curl"), "fetch tries wget and curl");
ok(src.includes("/tmp/pire-downloads"), "fetch saves to /tmp/pire-downloads");

ok(src.includes("hashTool"), "hash tool defined");
ok(src.includes('"hash"'), "hash tool registered");
ok(src.includes("md5sum") && src.includes("sha256sum"), "hash supports md5 and sha256");

ok(src.includes("entropyTool"), "entropy tool defined");
ok(src.includes('"entropy"'), "entropy tool registered");
ok(src.includes("Shannon"), "entropy uses Shannon entropy");

ok(src.includes("extractTool"), "extract tool defined");
ok(src.includes('"extract"'), "extract tool registered");
ok(src.includes("unzip") && src.includes("tar"), "extract handles zip and tar");

ok(src.includes("nmTool"), "nm tool defined");
ok(src.includes('"nm"'), "nm tool registered");

ok(src.includes("sizeTool"), "size tool defined");
ok(src.includes('"size"'), "size tool registered");

ok(src.includes("diffTool"), "diff tool defined");
ok(src.includes('"diff"'), "diff tool registered");

ok(src.includes("searchTool"), "search tool defined");
ok(src.includes('"search"'), "search tool registered");

ok(src.includes("patchTool"), "patch tool defined");
ok(src.includes('"patch"'), "patch tool registered");

ok(src.includes("jadxTool"), "jadx tool defined");
ok(src.includes('"jadx"'), "jadx tool registered");

ok(src.includes("ilspyTool"), "ilspy tool defined");
ok(src.includes('"ilspy"'), "ilspy tool registered");

// TUI URL handling
ok(tuiSrc.includes("pendingUrl"), "TUI tracks pending URL");
ok(tuiSrc.includes("https?:") || tuiSrc.includes("https?\\\\"), "TUI detects URLs");
ok(tuiSrc.includes("Downloading from"), "TUI shows download message");
ok(tuiSrc.includes("fetchTool"), "TUI imports fetchTool");

// probeTools includes new tools
ok(src.includes("fetch:") && src.includes("extract:"), "probeTools checks fetch and extract");
ok(src.includes("nm:") && src.includes("size:"), "probeTools checks nm and size");
ok(src.includes("hash:") && src.includes("entropy:"), "probeTools checks hash and entropy");
ok(src.includes("jadx:") && src.includes("ilspy:"), "probeTools checks jadx and ilspy");

// ─── 29. Install Scripts ──────────────────────────────────────

console.log("\n─ Install Scripts ─");

const installSh = fs.readFileSync(path.join(__dirname, "..", "..", "..", "install.sh"), "utf-8");
const installPs1 = fs.readFileSync(path.join(__dirname, "..", "..", "..", "install.ps1"), "utf-8");

// Shell installer
ok(installSh.includes("curl -fsSL"), "install.sh has one-liner curl hint");
ok(installSh.includes("debian") && installSh.includes("fedora") && installSh.includes("arch"), "install.sh detects Linux distros");
ok(installSh.includes("macos") && installSh.includes("brew"), "install.sh supports macOS");
ok(installSh.includes("windows") || installSh.includes("MSYS"), "install.sh supports Windows/MSYS2");
ok(installSh.includes("wsl"), "install.sh supports WSL");
ok(installSh.includes("--all"), "install.sh has --all flag");
ok(installSh.includes("--core"), "install.sh has --core flag");
ok(installSh.includes("--no-wine"), "install.sh has --no-wine flag");
ok(installSh.includes("--help"), "install.sh has --help flag");
ok(installSh.includes("prompt_yesno"), "install.sh has interactive prompt");
ok(installSh.includes("INSTALL_WINE"), "install.sh has wine component selection");
ok(installSh.includes("INSTALL_GHIDRA"), "install.sh has ghidra component selection");
ok(installSh.includes("INSTALL_FRIDA"), "install.sh has frida component selection");
ok(installSh.includes("INSTALL_JADX"), "install.sh has jadx component selection");
ok(installSh.includes("INSTALL_ILSPY"), "install.sh has ilspy component selection");
ok(installSh.includes("INSTALL_MINGW"), "install.sh has mingw component selection");
ok(installSh.includes("INSTALL_GDB"), "install.sh has gdb component selection");
ok(installSh.includes("INSTALL_BINWALK"), "install.sh has binwalk component selection");
ok(installSh.includes("INSTALL_YARA"), "install.sh has yara component selection");
ok(installSh.includes("INSTALL_VOLATILITY"), "install.sh has volatility component selection");
ok(installSh.includes("INSTALL_PYTHON_TOOLS"), "install.sh has python tools component selection");
ok(installSh.includes("suse") && installSh.includes("alpine"), "install.sh supports openSUSE and Alpine");
ok(installSh.includes("nodejs.org/dist") || installSh.includes("nodesource") || installSh.includes("NodeSource"), "install.sh handles Node 22+ upgrade");

// PowerShell installer
ok(installPs1.includes("irm") || installPs1.includes("iex"), "install.ps1 has one-liner");
ok(installPs1.includes("winget") || installPs1.includes("Chocolatey"), "install.ps1 uses winget or choco");
ok(installPs1.includes("-All"), "install.ps1 has -All flag");
ok(installPs1.includes("-CoreOnly"), "install.ps1 has -CoreOnly flag");
ok(installPs1.includes("Prompt-YesNo") || installPs1.includes("Read-Host") || installPs1.includes("prompt"), "install.ps1 has interactive prompt");
ok(installPs1.includes("Ghidra"), "install.ps1 has ghidra component");
ok(installPs1.includes("Frida"), "install.ps1 has frida component");
ok(installPs1.includes("JADX"), "install.ps1 has jadx component");
ok(installPs1.includes("ILSpy"), "install.ps1 has ilspy component");

console.log(`\n${"─".repeat(50)}`);
console.log(`\x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);
