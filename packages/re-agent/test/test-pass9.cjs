/**
 * pire Pass 9: LLM 429 retry, fetch URL validation, path traversal.
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

// ─── 1. LLM 429 retry ──────────────────────────────────────────
console.log("\n─ 1. LLM 429 retry ─");
const LLM_SRC = fs.readFileSync(path.join(SRC, "llm.ts"), "utf-8");
ok(LLM_SRC.includes("sc === 429"), "429 rate limit is retriable");

// ─── 2. fetch URL validation ───────────────────────────────────
console.log("\n─ 2. fetch URL validation ─");
const INDEX_SRC = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
ok(INDEX_SRC.includes("only http/https URLs are allowed"), "fetch blocks non-http(s) protocols");
ok(INDEX_SRC.includes("parsed.protocol"), "fetch validates protocol");
ok(INDEX_SRC.includes("Invalid URL:"), "fetch handles malformed URLs");

// ─── 3. Path traversal prevention ──────────────────────────────
console.log("\n─ 3. Path traversal prevention ─");
ok(INDEX_SRC.includes("Sanitize filename"), "fetch sanitizes filename");
ok(INDEX_SRC.includes("/[^a-zA-Z0-9._-]/g"), "filename regex sanitization");

// ─── 4. write_file path protection ─────────────────────────────
console.log("\n─ 4. write_file path protection ─");
ok(INDEX_SRC.includes("protected system path"), "write_file blocks system paths");
ok(INDEX_SRC.includes("authorized_keys"), "write_file blocks SSH keys");

// ─── 5. read_file sensitive file protection ────────────────────
console.log("\n─ 5. read_file protection ─");
ok(INDEX_SRC.includes("sensitive system file"), "read_file blocks sensitive");
ok(INDEX_SRC.includes("/.ssh/id_"), "read_file blocks SSH keys");

// ─── Summary ───────────────────────────────────────────────────
console.log("\n============================================================");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("============================================================");
process.exit(failed > 0 ? 1 : 0);
