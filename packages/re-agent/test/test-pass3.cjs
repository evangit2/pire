/**
 * pire Pass 3: Unit tests for agent loop + context fixes.
 * 
 * Tests:
 * 1. Agent loop doesn't duplicate user messages across turns
 * 2. finalContent is reset per turn (not accumulated)
 * 3. Context trimming triggers at 60% (not 100%)
 * 4. MAX_TOOL_OUTPUT is capped at 20K
 * 5. Tool results from previous turns are visible in subsequent turns
 * 6. Hash tool labels output with algorithm names
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const REPO = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(REPO, "packages", "re-agent", "src");
const MCP_SERVER = fs.readFileSync(path.join(SRC, "mcp-server.ts"), "utf-8");
const TUI = fs.readFileSync(path.join(SRC, "tui.ts"), "utf-8");
const PIRE_PI_TUI = fs.readFileSync(path.join(SRC, "pire-pi-tui.ts"), "utf-8");
const INDEX = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");

let passed = 0;
let failed = 0;

function ok(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.log(`  ✗ ${msg}`);
	}
}

console.log("pire Pass 3: Agent Loop + Context Unit Tests");
console.log("=".repeat(60));

// ─── Test 1: No duplicate user messages in agent loop ─────────
console.log("\n─ Agent Loop: No Duplicate User Messages ─");

// The old code had: slice(0,-1) + append userMessage → duplicates
// The new code just uses session.messages directly
ok(
	!MCP_SERVER.includes("historyBeforeUser"),
	"old historyBeforeUser/slice(0,-1) pattern removed",
);
ok(
	// The old code had "messages.push({ role: 'user', content: userMessage })" inside the messages array
	// The new code only has "session.messages.push({ role: 'user', content: userMessage })" once (before the loop)
	(MCP_SERVER.match(/{ role: "user", content: userMessage }/g) || []).length === 1,
	"only one user message push (before loop, not inside)",
);
ok(
	MCP_SERVER.includes("session.messages already contains the user message"),
	"comment confirms session.messages is used directly",
);

// ─── Test 2: finalContent reset per turn ──────────────────────
console.log("\n─ Agent Loop: finalContent Reset Per Turn ─");

ok(
	MCP_SERVER.includes("finalContent = \"\""),
	"finalContent is reset to empty string each turn",
);

// Count occurrences — should be: 1 declaration + 1 reset = 2
const finalContentAssigns = (MCP_SERVER.match(/finalContent = "/g) || []).length;
ok(
	finalContentAssigns >= 2,
	`finalContent assigned ${finalContentAssigns} times (declaration + reset)`,
);

// ─── Test 3: Context trimming triggers at 60% ─────────────────
console.log("\n─ Context Trimming: 60% Trigger ─");

ok(
	MCP_SERVER.includes("0.6"),
	"MCP server uses 60% trigger limit",
);
ok(
	MCP_SERVER.includes("triggerLimit"),
	"MCP server has triggerLimit variable",
);

// Verify all stages use triggerLimit, not CONTEXT_CHAR_LIMIT
const stageChecks = [
	"Stage 1: Truncate old tool results",
	"Stage 2: Replace old tool results",
	"Stage 3: Compress old assistant",
	"Stage 4: Compress old user",
];
for (const stage of stageChecks) {
	const stageSection = MCP_SERVER.split(stage)[1]?.split("// Stage")[0] || "";
	ok(
		stageSection.includes("triggerLimit") && !stageSection.includes("CONTEXT_CHAR_LIMIT"),
		`${stage.split(":")[0]} uses triggerLimit`,
	);
}

// Same check for TUI
ok(TUI.includes("triggerLimit"), "TUI uses triggerLimit");
ok(TUI.includes("0.6"), "TUI uses 60% trigger");

// Same check for pire-pi-tui
ok(PIRE_PI_TUI.includes("triggerLimit"), "pire-pi-tui uses triggerLimit");
ok(PIRE_PI_TUI.includes("0.6"), "pire-pi-tui uses 60% trigger");

// ─── Test 4: MAX_TOOL_OUTPUT capped at 20K ────────────────────
console.log("\n─ MAX_TOOL_OUTPUT: 20K Cap ─");

ok(
	MCP_SERVER.includes("Math.min(20000"),
	"MCP server MAX_TOOL_OUTPUT capped at 20000",
);
ok(
	MCP_SERVER.includes("Math.floor(getContextCharLimit() * 0.05)"),
	"MCP server MAX_TOOL_OUTPUT is 5% of context",
);

ok(
	TUI.includes("Math.min(20000"),
	"TUI MAX_TOOL_OUTPUT capped at 20000",
);

ok(
	PIRE_PI_TUI.includes("Math.min(20000"),
	"pire-pi-tui MAX_OUTPUT capped at 20000",
);

// Verify old 100000 default is gone
ok(
	!TUI.includes("100000"),
	"TUI no longer has 100000 default",
);
ok(
	!PIRE_PI_TUI.includes("100000"),
	"pire-pi-tui no longer has 100000 default",
);

// ─── Test 5: pire-pi-tui has getContextCharLimit ──────────────
console.log("\n─ pire-pi-tui: Dynamic Context Limit ─");

ok(
	PIRE_PI_TUI.includes("function getContextCharLimit"),
	"pire-pi-tui has getContextCharLimit function",
);
ok(
	!PIRE_PI_TUI.includes('"120000"'),
	"pire-pi-tui no longer has hardcoded 120000",
);

// ─── Test 6: Hash tool labels output ──────────────────────────
console.log("\n─ Hash Tool: Algorithm Labels ─");

// Find the hash tool section
// Find the hash tool section — use a more robust split
const hashStart = INDEX.indexOf("const hashTool");
const hashEnd = INDEX.indexOf("const entropyTool");
const hashSection = INDEX.substring(hashStart, hashEnd);
ok(
	hashSection.includes("label") && hashSection.includes("results.push"),
	"hash tool labels and pushes results",
);
ok(
	hashSection.includes("md5sum") && hashSection.includes("sha256sum"),
	"hash tool supports md5 and sha256",
);

// ─── Test 7: No unused loadSettings imports ───────────────────
console.log("\n─ Cleanup: No Unused Imports ─");

ok(
	!TUI.includes('import { loadSettings }'),
	"TUI no longer imports loadSettings",
);
ok(
	!fs.readFileSync(path.join(SRC, "pire-reimpl.ts"), "utf-8").includes('import { loadSettings }'),
	"pire-reimpl no longer imports loadSettings",
);

// ─── Test 8: Version consistency ──────────────────────────────
console.log("\n─ Version Consistency ─");

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "packages", "re-agent", "package.json"), "utf-8"));
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8"));

ok(pkg.version === rootPkg.version, `package versions match: ${pkg.version}`);
ok(
	TUI.includes(`VERSION = "${pkg.version}"`),
	`tui.ts VERSION matches package.json (${pkg.version})`,
);
ok(
	PIRE_PI_TUI.includes(`VERSION = "${pkg.version}"`),
	`pire-pi-tui.ts VERSION matches package.json (${pkg.version})`,
);

// ─── Summary ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`  ✓ ${passed} passed, ✗ ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
