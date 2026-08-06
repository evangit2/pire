/**
 * pire Pass 11: Ghidra reliability — stale process cleanup, lock file removal,
 * corrupt project detection, path parameter on Ghidra tools.
 */
const path = require("path");
const fs = require("fs");

const REPO = path.resolve(__dirname, "..", "..", "..");
const INDEX_SRC = fs.readFileSync(path.join(REPO, "packages", "re-agent", "src", "index.ts"), "utf-8");

let passed = 0;
let failed = 0;

function ok(cond, msg) {
	if (cond) {
		console.log(`✓ ${msg}`);
		passed++;
	} else {
		console.log(`✗ ${msg}`);
		failed++;
	}
}

// 1. Stale process kill in startHeadless
ok(INDEX_SRC.includes("fuser -k 8089/tcp"), "startHeadless kills stale process on port 8089");

// 2. Lock file cleanup
ok(INDEX_SRC.includes('lockPath') && INDEX_SRC.includes('unlinkSync(lockPath)'), "Lock file cleanup in startHeadless");

// 3. Project existence check uses .rep directory, not .gpr file size
ok(INDEX_SRC.includes('repPath') && INDEX_SRC.includes('projectExists'), "Project existence check uses .rep directory");

// 4. ensureAlive kills stale server when program not loaded
ok(INDEX_SRC.includes("Case 2: Server alive but program NOT loaded"), "ensureAlive kills server when program not loaded");

// 5. restartCount resets on success
ok(INDEX_SRC.includes("this.restartCount = 0; // Reset on success"), "restartCount resets on successful startup");

// 6. Ghidra tools accept optional path parameter
ok(INDEX_SRC.includes('ghidraDecompile: AgentTool<{ function: string; path?: string }>'), "ghidra_decompile accepts optional path");
ok(INDEX_SRC.includes('ghidraListFunctions: AgentTool<{ path?: string }>'), "ghidra_functions accepts optional path");
ok(INDEX_SRC.includes('ghidraRename: AgentTool<{ oldName: string; newName: string; path?: string }>'), "ghidra_rename accepts optional path");
ok(INDEX_SRC.includes('ghidraXrefs: AgentTool<{ address: string; path?: string }>'), "ghidra_xrefs accepts optional path");
ok(INDEX_SRC.includes('ghidraStrings: AgentTool<{ pattern?: string; path?: string }>'), "ghidra_strings accepts optional path");

// 7. r2 tool calls setGhidraTarget
ok(INDEX_SRC.includes("setGhidraTarget(params.path)"), "Tools call setGhidraTarget with path");

// 8. System prompt mentions Ghidra preference
ok(INDEX_SRC.includes("Always prefer ghidra_decompile"), "System prompt prefers Ghidra for decompilation");

// 9. System prompt mentions path parameter
ok(INDEX_SRC.includes('"function":"entry","path":"/tmp/binary.exe"'), "System prompt documents path parameter");

// 10. Ghidra tool descriptions mention auto-load
ok(INDEX_SRC.includes("auto-loads") || INDEX_SRC.includes("auto-load") || INDEX_SRC.includes("uses the binary from the last"), "Ghidra tool descriptions mention auto-load behavior");

console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
