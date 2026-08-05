/**
 * pire Pass 8: Security hardening tests.
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

// ─── 1. Sandbox bypass patterns ────────────────────────────────
console.log("\n─ 1. Sandbox bypass patterns ─");
const INDEX_SRC = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
ok(INDEX_SRC.includes("python3?\\s+.*-c.*import\\s+(urllib|requests|socket|http)"), "Python import urllib blocked");
ok(INDEX_SRC.includes("python3?\\s+.*-c.*from\\s+(urllib|requests|socket|http)"), "Python from urllib blocked");
ok(INDEX_SRC.includes("\\/dev\\/(tcp|udp)\\/" ), "/dev/tcp and /dev/udp blocked");
ok(INDEX_SRC.includes("fork bomb"), "fork bomb still blocked");

// ─── 2. write_file path protection ─────────────────────────────
console.log("\n─ 2. write_file path protection ─");
ok(INDEX_SRC.includes("protected system path"), "write_file blocks system paths");
ok(INDEX_SRC.includes('"/etc", "/usr", "/bin"'), "write_file blocks /etc, /usr, /bin");
ok(INDEX_SRC.includes("authorized_keys"), "write_file blocks SSH authorized_keys");
ok(INDEX_SRC.includes("resolve(params.path)"), "write_file resolves path");

// ─── 3. read_file sensitive file protection ────────────────────
console.log("\n─ 3. read_file sensitive file protection ─");
ok(INDEX_SRC.includes("sensitive system file"), "read_file blocks sensitive files");
ok(INDEX_SRC.includes("/etc/shadow"), "read_file blocks /etc/shadow");
ok(INDEX_SRC.includes("/.ssh/id_"), "read_file blocks SSH private keys");
ok(INDEX_SRC.includes("SSH credentials"), "read_file blocks SSH credentials");

// ─── 4. HTTP server robustness ─────────────────────────────────
console.log("\n─ 4. HTTP server robustness ─");
const MCP_SRC = fs.readFileSync(path.join(SRC, "mcp-server.ts"), "utf-8");
ok(MCP_SRC.includes("MAX_BODY"), "HTTP body size limit");
ok(MCP_SRC.includes("10 * 1024 * 1024"), "10MB limit");
ok(MCP_SRC.includes("413"), "HTTP 413 response for too large");
ok(MCP_SRC.includes("Array.isArray(rpcReq)"), "JSON-RPC batch request support");
ok(MCP_SRC.includes("Promise.all(rpcReq.map"), "batch requests run in parallel");
ok(MCP_SRC.includes("req.on(\"error\""), "request error handler");

// ─── 5. reimpl parallel execution ──────────────────────────────
console.log("\n─ 5. reimpl parallel execution ─");
const REIMPL_SRC = fs.readFileSync(path.join(SRC, "pire-reimpl.ts"), "utf-8");
ok(REIMPL_SRC.includes("parallelTCs"), "reimpl splits parallel tool calls");
ok(REIMPL_SRC.includes("sequentialTCs"), "reimpl splits sequential tool calls");
ok(REIMPL_SRC.includes("Promise.all("), "reimpl uses Promise.all");
ok(REIMPL_SRC.includes("executionMode"), "reimpl checks executionMode");

// ─── 6. All surfaces have per-tool timeout ─────────────────────
console.log("\n─ 6. Per-tool timeout coverage ─");
const TUI_SRC = fs.readFileSync(path.join(SRC, "tui.ts"), "utf-8");
const PI_TUI_SRC = fs.readFileSync(path.join(SRC, "pire-pi-tui.ts"), "utf-8");
ok(MCP_SRC.includes("toolTimeout"), "mcp-server has toolTimeout");
ok(TUI_SRC.includes("toolTimeout"), "tui has toolTimeout");
ok(PI_TUI_SRC.includes("toolTimeout"), "pi-tui has toolTimeout");
ok(REIMPL_SRC.includes("toolTimeout"), "reimpl has toolTimeout");

// ─── 7. All surfaces have parallel execution ───────────────────
console.log("\n─ 7. Parallel execution coverage ─");
ok(MCP_SRC.includes("parallelCalls"), "mcp-server has parallel execution");
ok(REIMPL_SRC.includes("parallelTCs"), "reimpl has parallel execution");

// ─── 8. Context trimming everywhere ────────────────────────────
console.log("\n─ 8. Context trimming ─");
ok(TUI_SRC.includes("function trimContext"), "TUI has trimContext");
ok(REIMPL_SRC.includes("function trimContext"), "reimpl has trimContext");
ok(REIMPL_SRC.includes("Stage 1:"), "reimpl has multi-stage trimming");
ok(REIMPL_SRC.includes("Stage 4:"), "reimpl has 4 stages");

// ─── Summary ───────────────────────────────────────────────────
console.log("\n============================================================");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("============================================================");
process.exit(failed > 0 ? 1 : 0);
