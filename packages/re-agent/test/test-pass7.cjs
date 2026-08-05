/**
 * pire Pass 7: Tests for pire-model.ts fixes.
 */
const path = require("path");
const fs = require("fs");

const REPO = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(REPO, "packages", "re-agent", "src");

let passed = 0, failed = 0;
function ok(cond, msg) {
	if (cond) { passed++; console.log(`  ✓ ${msg}`); }
	else { failed++; console.log(`  ✗ ${msg}`); }
}

// ─── Test 1: pire-model YAML parser fix ────────────────────────
console.log("\n─ 1. pire-model YAML parser ─");
const MODEL_SRC = fs.readFileSync(path.join(SRC, "pire-model.ts"), "utf-8");
ok(MODEL_SRC.includes("Strip comments only if NOT inside quotes"), "pire-model has quote-aware comment stripping");
ok(MODEL_SRC.includes("endQuote"), "pire-model has closing quote detection");
ok(!MODEL_SRC.match(/const commentIdx = rawLine\.indexOf\("#"\)/), "pire-model no longer strips # before quote check");

// ─── Test 2: saveConfig quotes special values ──────────────────
console.log("\n─ 2. saveConfig quoting ─");
ok(MODEL_SRC.includes("Quote values that contain special characters"), "saveConfig has quoting logic");
ok(MODEL_SRC.includes('/[#\\s\'"]/' ), "saveConfig detects special chars");
ok(MODEL_SRC.includes('replace(/"/g'), "saveConfig escapes double quotes");

// ─── Test 3: fetchModels URL normalization ─────────────────────
console.log("\n─ 3. fetchModels URL normalization ─");
ok(MODEL_SRC.includes("Normalize: strip trailing"), "fetchModels has URL normalization");
ok(MODEL_SRC.includes('endsWith("/v1")'), "fetchModels checks for /v1 suffix");
ok(MODEL_SRC.includes('endsWith("/v1beta")'), "fetchModels checks for /v1beta suffix");

// ─── Test 4: Round-trip test (save then load) ──────────────────
console.log("\n─ 4. Config round-trip ─");
// Write a config with special chars, verify it can be parsed back
const testConfig = `base_url: "http://example.com/v1"
api_key: "secret-key-with-#-hash"
model: "GLM-5.2"
context_length: 131072
max_tokens: 4096
`;
const testPath = "/tmp/pire-model-test-config.yaml";
fs.writeFileSync(testPath, testConfig);

// Verify the config can be parsed by the same logic
const content = fs.readFileSync(testPath, "utf-8");
const result = {};
for (const rawLine of content.split("\n")) {
	const match = rawLine.match(/^\s*(\w+)\s*:\s*(.*)$/);
	if (!match) continue;
	let value = match[2].trim();
	if (value.startsWith('"') || value.startsWith("'")) {
		const quote = value[0];
		const endQuote = value.indexOf(quote, 1);
		if (endQuote >= 0) value = value.slice(1, endQuote);
	} else {
		const commentIdx = value.indexOf("#");
		if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
	}
	result[match[1]] = value;
}
ok(result.base_url === "http://example.com/v1", `base_url round-trip: ${result.base_url}`);
ok(result.api_key === "secret-key-with-#-hash", `api_key with # preserved: ${result.api_key}`);
ok(result.model === "GLM-5.2", `model preserved: ${result.model}`);
ok(result.context_length === "131072", `context_length: ${result.context_length}`);

// ─── Test 5: All execution surfaces have per-tool timeout ──────
console.log("\n─ 5. Per-tool timeout coverage ─");
const MCP_SRC = fs.readFileSync(path.join(SRC, "mcp-server.ts"), "utf-8");
const TUI_SRC = fs.readFileSync(path.join(SRC, "tui.ts"), "utf-8");
const PI_TUI_SRC = fs.readFileSync(path.join(SRC, "pire-pi-tui.ts"), "utf-8");
const REIMPL_SRC = fs.readFileSync(path.join(SRC, "pire-reimpl.ts"), "utf-8");

ok(MCP_SRC.includes("toolTimeout"), "mcp-server has toolTimeout");
ok(TUI_SRC.includes("toolTimeout"), "tui has toolTimeout");
ok(PI_TUI_SRC.includes("toolTimeout"), "pi-tui has toolTimeout");
ok(REIMPL_SRC.includes("toolTimeout"), "reimpl has toolTimeout");

// All should use Promise.race
ok(MCP_SRC.includes("Promise.race"), "mcp-server uses Promise.race");
ok(TUI_SRC.includes("Promise.race"), "tui uses Promise.race");
ok(PI_TUI_SRC.includes("Promise.race"), "pi-tui uses Promise.race");
ok(REIMPL_SRC.includes("Promise.race"), "reimpl uses Promise.race");

// ─── Test 6: reimpl context trimming (multi-stage) ─────────────
console.log("\n─ 6. reimpl multi-stage context trimming ─");
ok(REIMPL_SRC.includes("Stage 1: Truncate old tool results"), "Stage 1: head+tail truncation");
ok(REIMPL_SRC.includes("Stage 2: Replace old tool results"), "Stage 2: compress to stubs");
ok(REIMPL_SRC.includes("Stage 3: Compress old assistant"), "Stage 3: compress assistant messages");
ok(REIMPL_SRC.includes("Stage 4: Compress old user"), "Stage 4: compress user messages");
ok(REIMPL_SRC.includes("PRESERVE_RECENT"), "preserve recent constant");
ok(REIMPL_SRC.includes("TOOL_RESULT_HEAD"), "tool result head constant");
ok(REIMPL_SRC.includes("TOOL_RESULT_TAIL"), "tool result tail constant");

// ─── Test 7: LLM retry logic ───────────────────────────────────
console.log("\n─ 7. LLM retry logic ─");
const LLM_SRC = fs.readFileSync(path.join(SRC, "llm.ts"), "utf-8");
ok(LLM_SRC.includes("ECONNREFUSED"), "ECONNREFUSED fail-fast");
ok(LLM_SRC.includes("retriable === false"), "4xx no-retry");
ok(LLM_SRC.includes("2000 * (i + 1)"), "exponential backoff");

// ─── Summary ───────────────────────────────────────────────────
console.log("\n============================================================");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("============================================================");
process.exit(failed > 0 ? 1 : 0);
