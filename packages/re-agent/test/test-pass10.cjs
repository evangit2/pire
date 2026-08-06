/**
 * pire Pass 10: Sandbox false positive fix, Ghidra auto-load, JSON repair, decompile truncation.
 */
const path = require("path");
const fs = require("fs");

const REPO = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(REPO, "packages", "re-agent", "src");

let passed = 0, failed = 0;
function ok(cond, name) {
	if (cond) { passed++; console.log(`  ✓ ${name}`); }
	else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("\n─ 1. Sandbox false positive fix ─");
const INDEX_SRC = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
ok(INDEX_SRC.includes("(?:^|;|\\||&&|\\|\\|)\\s*(?:curl|wget|nc|netcat)\\s"), "Sandbox only blocks curl/wget at command position");
ok(INDEX_SRC.includes("^(?:curl|wget|nc|netcat)\\s"), "Sandbox blocks standalone network commands");
ok(!INDEX_SRC.includes("/\\bcurl\\s/"), "Old broad curl pattern removed");

console.log("\n─ 2. Ghidra auto-load from r2/decompile ─");
ok(INDEX_SRC.includes("setGhidraTarget(params.path)"), "r2 or decompile calls setGhidraTarget");
const R2_SECTION = INDEX_SRC.slice(INDEX_SRC.indexOf("const r2Tool"), INDEX_SRC.indexOf("const r2Tool") + 2000);
ok(R2_SECTION.includes("setGhidraTarget"), "r2 tool calls setGhidraTarget");
const DECOMPILE_SECTION = INDEX_SRC.slice(INDEX_SRC.indexOf("const decompileTool"), INDEX_SRC.indexOf("const decompileTool") + 2000);
ok(DECOMPILE_SECTION.includes("setGhidraTarget"), "decompile tool calls setGhidraTarget");

console.log("\n─ 3. JSON argument repair in LLM client ─");
const LLM_SRC = fs.readFileSync(path.join(SRC, "llm.ts"), "utf-8");
ok(LLM_SRC.includes("Sanitize tool calls"), "LLM client has tool call sanitization");
ok(LLM_SRC.includes("Unterminated string") || LLM_SRC.includes("unterminated") || LLM_SRC.includes("Close any open string"), "Truncated JSON repair logic present");
ok(LLM_SRC.includes('tc.function.arguments = "{}"'), "Fallback to empty object for broken JSON");

console.log("\n─ 4. Decompile truncation detection ─");
ok(INDEX_SRC.includes("isTruncated"), "Decompile checks for truncated output");
ok(INDEX_SRC.includes('cleaned.length < 80') || INDEX_SRC.includes('length < 80'), "Truncation threshold is 80 chars");
ok(INDEX_SRC.includes('!cleaned.includes("}")'), "Truncation checks for missing closing brace");

console.log("\n─ 5. isProtectedPath helper ─");
ok(INDEX_SRC.includes("function isProtectedPath"), "isProtectedPath helper exists");
ok(INDEX_SRC.includes("/.ssh/"), "SSH directory blocked in isProtectedPath");

console.log("\n─ 6. fetch URL validation ─");
const FETCH_SECTION = INDEX_SRC.slice(INDEX_SRC.indexOf("const fetchTool"), INDEX_SRC.indexOf("const fetchTool") + 800);
ok(FETCH_SECTION.includes("new URL") || FETCH_SECTION.includes("URL("), "fetch validates URL");
ok(FETCH_SECTION.includes("http:") && FETCH_SECTION.includes("https:"), "fetch only allows http/https");

console.log("\n─ 7. 429 retry ─");
ok(LLM_SRC.includes("429"), "LLM client handles 429 rate limit");
ok(LLM_SRC.includes("retriable = sc >= 500 || sc === 429"), "429 is retriable");

console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");
process.exit(failed > 0 ? 1 : 0);
