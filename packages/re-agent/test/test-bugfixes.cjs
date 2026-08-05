#!/usr/bin/env node
/**
 * pire bugfix tests — covers bugs found and fixed in v0.89.0
 *
 * Bugs tested:
 *   1. textResult truncation limit (was 200K, now 500K)
 *   2. Agent loop tool result truncation (was 16K, now 100K)
 *   3. session.save saves full conversation history (not just user message)
 *   4. Version is read from package.json (not hardcoded)
 *   5. No inline dynamic imports in mcp-server.ts
 *   6. Decompile tool description warns against function indices
 *   7. r2 tool description mentions aflj for JSON output
 *   8. System prompt mentions write_file and aflj
 *
 * Run: node packages/re-agent/test/test-bugfixes.cjs
 */

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");
const mcpSrc = fs.readFileSync(path.join(__dirname, "..", "src", "mcp-server.ts"), "utf-8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf-8"));

let pass = 0, fail = 0;

function ok(cond, msg) {
	if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); pass++; }
	else { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fail++; }
}

// ─── 1. textResult truncation limit ──────────────────────────

console.log("\n─ textResult Truncation ─");

const textResultMatch = src.match(/function textResult[\s\S]*?const limit = (\d+)/);
ok(textResultMatch !== null, "textResult function found in source");
if (textResultMatch) {
	const limit = parseInt(textResultMatch[1], 10);
	ok(limit >= 500000, `textResult limit is >= 500000 (got ${limit})`);
	ok(limit > 200000, `textResult limit increased from old 200000 (got ${limit})`);
}

// ─── 2. Agent loop tool result truncation ─────────────────────

console.log("\n─ Agent Loop Tool Result Truncation ─");

const toolTruncMatch = mcpSrc.match(/text\.length > (\d+) \? text\.slice/);
ok(toolTruncMatch !== null, "tool result truncation found in agent loop");
if (toolTruncMatch) {
	const truncLimit = parseInt(toolTruncMatch[1], 10);
	ok(truncLimit >= 100000, `tool result truncation >= 100000 (got ${truncLimit})`);
	ok(truncLimit > 16000, `tool result truncation increased from old 16000 (got ${truncLimit})`);
}

// ─── 3. session.save saves full conversation ─────────────────

console.log("\n─ session.save Full History ─");

ok(
	mcpSrc.includes("session.messages.push") && mcpSrc.includes("role: \"assistant\""),
	"agent loop pushes assistant messages to session.messages"
);
ok(
	mcpSrc.includes("session.messages.push") && mcpSrc.includes("role: \"tool\""),
	"agent loop pushes tool results to session.messages"
);
// Count occurrences of session.messages.push
const sessionPushCount = (mcpSrc.match(/session\.messages\.push/g) || []).length;
ok(sessionPushCount >= 5, `agent loop pushes to session.messages in >= 5 places (got ${sessionPushCount})`);

// ─── 4. Version from package.json ────────────────────────────

console.log("\n─ Dynamic Version ─");

ok(mcpSrc.includes("VERSION"), "mcp-server.ts has VERSION variable");
ok(!mcpSrc.includes('"0.88.6"'), "old hardcoded version 0.88.6 removed");
ok(mcpSrc.includes("package.json"), "VERSION reads from package.json");
ok(mcpSrc.includes("readFileSync"), "VERSION uses readFileSync (top-level import)");

// ─── 5. No inline dynamic imports ────────────────────────────

console.log("\n─ No Inline Dynamic Imports ─");

const dynamicImports = mcpSrc.match(/await\s+import\(/g) || [];
ok(dynamicImports.length === 0, `no inline dynamic imports in mcp-server.ts (found ${dynamicImports.length})`);
ok(mcpSrc.includes("writeFileSync") && mcpSrc.includes("mkdirSync") && mcpSrc.includes('from "node:fs"'), "writeFileSync/mkdirSync are top-level imports from node:fs");
ok(mcpSrc.includes('import { dirname, join }'), "dirname/join are top-level imports");

// ─── 6. Decompile tool description ───────────────────────────

console.log("\n─ Decompile Tool Description ─");

ok(
	src.includes("Do NOT pass function indices"),
	"decompile tool warns against function indices"
);
ok(
	src.includes("hex addr") && src.includes("symbol name"),
	"decompile tool mentions hex addr and symbol name"
);

// ─── 7. r2 tool description mentions aflj ────────────────────

console.log("\n─ r2 Tool aflj Guidance ─");

ok(
	src.includes("aflj") && src.includes("JSON output"),
	"r2 tool description mentions aflj for JSON output"
);

// ─── 8. System prompt mentions write_file and aflj ───────────

console.log("\n─ System Prompt Guidance ─");

ok(
	mcpSrc.includes("write_file") && mcpSrc.includes("write_file tool"),
	"agent loop system prompt mentions write_file tool"
);
ok(
	!mcpSrc.includes("echo 'content'"),
	"agent loop no longer suggests echo for file writing"
);
ok(
	src.includes("aflj") || mcpSrc.includes("aflj"),
	"system prompt or tools mention aflj"
);

// ─── 9. MCP initialize returns dynamic version ───────────────

console.log("\n─ MCP Initialize Version ─");

ok(
	mcpSrc.includes("version: VERSION"),
	"initialize response uses dynamic VERSION"
);
ok(
	mcpSrc.includes("version: VERSION") && !mcpSrc.includes('version: "0.88'),
	"no hardcoded version strings in initialize"
);

// ─── 10. session.save version field ──────────────────────────

console.log("\n─ session.save Version ─");

ok(
	mcpSrc.includes("version: VERSION") && mcpSrc.includes("target: session.target"),
	"session.save includes version and target"
);

// ─── Summary ─────────────────────────────────────────────────

console.log("\n" + "─".repeat(50));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
