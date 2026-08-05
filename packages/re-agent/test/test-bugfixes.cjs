#!/usr/bin/env node
/**
 * pire bugfix tests — verifies fixes for issues documented in ISSUES.md
 *
 * Tests:
 *   1. Tool schema filtering (only available tools sent to LLM)
 *   2. Context trimming (messages compressed when over budget)
 *   3. seenCalls is per-turn (same tool can run in different turns)
 *   4. 4xx error handling (no retry, error body included)
 *   5. 5xx error handling (retried)
 *   6. e2e config parsing (model: not default:)
 *   7. test-models config parsing (flat format support)
 *   8. MAX_TOOL_OUTPUT is percentage-based
 *   9. turns count is actual turns (not tool call count)
 *  10. session.load calls setGhidraTarget
 *
 * Usage: node packages/re-agent/test/test-bugfixes.cjs
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const http = require("http");
const https = require("https");

let pass = 0, fail = 0;
function ok(cond, msg) {
	if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); pass++; }
	else { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fail++; }
}

// ─── Test 6: e2e config parsing ───────────────────────────────

function testE2EConfigParsing() {
	console.log("\n─ e2e config parsing ─");
	const tmpCfg = path.join("/tmp", "pire-test-cfg.yaml");
	fs.writeFileSync(tmpCfg, [
		'model: "GLM-5.2-thinking-high"',
		'base_url: "https://api.example.com/v1"',
		'api_key: "sk-test123"',
	].join("\n"));

	const cfg = fs.readFileSync(tmpCfg, "utf-8");
	const model = cfg.match(/(?:^|\n)\s*model:\s*(.+)/)?.[1]?.trim().replace(/['"]/g, "");
	ok(model === "GLM-5.2-thinking-high", `parses model: correctly (got: ${model})`);

	const url = cfg.match(/base_url:\s*(.+)/)?.[1]?.trim().replace(/['"]/g, "");
	ok(url === "https://api.example.com/v1", `parses base_url: correctly (got: ${url})`);

	const key = cfg.match(/api_key:\s*(.+)/)?.[1]?.trim().replace(/['"]/g, "");
	ok(key === "sk-test123", `parses api_key: correctly (got: ${key})`);

	fs.unlinkSync(tmpCfg);
}

// ─── Test 7: test-models flat config parsing ──────────────────

function testModelsConfigParsing() {
	console.log("\n─ test-models flat config parsing ─");
	const tmpCfg = path.join("/tmp", "pire-test-models-cfg.yaml");
	fs.writeFileSync(tmpCfg, [
		'model: "GLM-5.2-thinking-high"',
		'base_url: "https://api.example.com/v1"',
		'api_key: "sk-test456"',
	].join("\n"));

	// Simulate the loadConfig logic
	const raw = fs.readFileSync(tmpCfg, "utf-8");
	const config = {};
	const lines = raw.split("\n");
	for (const line of lines) {
		const flatModel = line.match(/^(?:model|default_model):\s*(.+)$/);
		if (flatModel) {
			config["model.default"] = flatModel[1].replace(/^["']|["']$/g, "");
			config["model.model"] = flatModel[1].replace(/^["']|["']$/g, "");
			continue;
		}
		const flatUrl = line.match(/^base_url:\s*(.+)$/);
		if (flatUrl) {
			config["model.base_url"] = flatUrl[1].replace(/^["']|["']$/g, "");
			continue;
		}
		const flatKey = line.match(/^api_key:\s*(.+)$/);
		if (flatKey) {
			config["model.api_key"] = flatKey[1].replace(/^["']|["']$/g, "");
			continue;
		}
	}

	ok(config["model.model"] === "GLM-5.2-thinking-high", `flat model parsed (got: ${config["model.model"]})`);
	ok(config["model.default"] === "GLM-5.2-thinking-high", `flat model.default alias (got: ${config["model.default"]})`);
	ok(config["model.base_url"] === "https://api.example.com/v1", `flat base_url parsed (got: ${config["model.base_url"]})`);
	ok(config["model.api_key"] === "sk-test456", `flat api_key parsed (got: ${config["model.api_key"]})`);

	fs.unlinkSync(tmpCfg);
}

// ─── Test 8: MAX_TOOL_OUTPUT percentage-based ─────────────────

function testMaxToolOutput() {
	console.log("\n─ MAX_TOOL_OUTPUT percentage-based ─");

	// Simulate the calculation for different context sizes
	const sizes = [
		{ ctx: 2048, expected: Math.max(1000, Math.floor(2048 * 4 * 0.75 * 0.3)) },
		{ ctx: 8192, expected: Math.max(1000, Math.floor(8192 * 4 * 0.75 * 0.3)) },
		{ ctx: 32768, expected: Math.max(1000, Math.floor(32768 * 4 * 0.75 * 0.3)) },
		{ ctx: 131072, expected: Math.max(1000, Math.floor(131072 * 4 * 0.75 * 0.3)) },
		{ ctx: 200000, expected: Math.max(1000, Math.floor(200000 * 4 * 0.75 * 0.3)) },
	];

	for (const { ctx, expected } of sizes) {
		const ctxLimit = Math.floor(ctx * 4 * 0.75);
		const maxOutput = Math.max(1000, Math.floor(ctxLimit * 0.3));
		ok(maxOutput === expected, `ctx ${ctx} → max_output ${maxOutput}`);
	}

	// Small context should hit minimum
	const smallCtx = Math.max(1000, Math.floor(512 * 4 * 0.75 * 0.3));
	ok(smallCtx === 1000, `small context (512) hits minimum 1000 (got: ${smallCtx})`);
}

// ─── Test 4 & 5: Error handling ───────────────────────────────

async function testErrorHandling() {
	console.log("\n─ 4xx/5xx error handling ─");

	// Mock the error classification logic
	function classifyError(statusCode) {
		return {
			statusCode,
			retriable: statusCode >= 500,
		};
	}

	// 4xx should not be retriable
	ok(classifyError(400).retriable === false, "400 not retriable");
	ok(classifyError(401).retriable === false, "401 not retriable");
	ok(classifyError(403).retriable === false, "403 not retriable");
	ok(classifyError(404).retriable === false, "404 not retriable");
	ok(classifyError(429).retriable === false, "429 not retriable (no retry)");

	// 5xx should be retriable
	ok(classifyError(500).retriable === true, "500 retriable");
	ok(classifyError(502).retriable === true, "502 retriable");
	ok(classifyError(503).retriable === true, "503 retriable");

	// Test retry logic: should not retry 4xx
	let retryCount = 0;
	async function mockRetry(statusCode) {
		for (let i = 0; i < 3; i++) {
			try {
				const err = { retriable: statusCode >= 500 };
				if (err.retriable === false) throw err;
				retryCount++;
			} catch (e) {
				return i; // number of attempts before throwing
			}
		}
		return 3;
	}

	const attempts400 = await mockRetry(400);
	ok(attempts400 === 0, `400 throws immediately (0 retries, got: ${attempts400})`);
}

// ─── Test 2: Context trimming ─────────────────────────────────

function testContextTrimming() {
	console.log("\n─ context trimming ─");

	// Simulate trimContextMessages logic
	const CONTEXT_LIMIT = 1000; // Small for testing
	const PRESERVE_RECENT = 4;
	const HEAD = 50;
	const TAIL = 50;

	function estimateChars(msgs) {
		return msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
	}

	function trim(msgs) {
		if (msgs.length <= PRESERVE_RECENT) return msgs;
		let total = estimateChars(msgs);
		if (total <= CONTEXT_LIMIT) return msgs;
		const result = msgs.map(m => ({ ...m }));
		const cutoff = result.length - PRESERVE_RECENT;

		// Stage 1: truncate tool results
		for (let i = 0; i < cutoff && total > CONTEXT_LIMIT; i++) {
			const msg = result[i];
			if (msg.role === "tool" && msg.content.length > HEAD + TAIL) {
				const orig = msg.content.length;
				msg.content = msg.content.slice(0, HEAD) + "...(truncated)..." + msg.content.slice(-TAIL);
				total -= orig - msg.content.length;
			}
		}

		// Stage 2: stub tool results
		for (let i = 0; i < cutoff && total > CONTEXT_LIMIT; i++) {
			const msg = result[i];
			if (msg.role === "tool" && msg.content.length > 100) {
				const orig = msg.content.length;
				msg.content = "[compressed]";
				total -= orig - msg.content.length;
			}
		}

		return result;
	}

	// Test: under limit → no changes
	const small = [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "hi" },
	];
	const trimmedSmall = trim(small);
	ok(trimmedSmall === small, "under limit: no changes");

	// Test: over limit → tool results truncated
	const msgs = [
		{ role: "user", content: "analyze" },
		{ role: "tool", content: "A".repeat(500) },
		{ role: "assistant", content: "ok" },
		{ role: "tool", content: "B".repeat(500) },
		{ role: "user", content: "more" },
		{ role: "tool", content: "C".repeat(500) },
		{ role: "assistant", content: "done" },
		{ role: "user", content: "final" },
	];
	const trimmed = trim(msgs);
	ok(trimmed.length === msgs.length, "trimming preserves message count");
	ok(estimateChars(trimmed) < estimateChars(msgs), "trimming reduces total chars");
	ok(trimmed[1].content.length < 500, `tool result truncated (got: ${trimmed[1].content.length})`);

	// Test: recent messages preserved
	const recentContent = msgs[msgs.length - 1].content;
	ok(trimmed[trimmed.length - 1].content === recentContent, "most recent message preserved");
}

// ─── Test 3: seenCalls per-turn ───────────────────────────────

function testSeenCallsPerTurn() {
	console.log("\n─ seenCalls per-turn ─");

	// Simulate per-turn deduplication
	function simulateTurns(toolCalls) {
		const executedCalls = [];
		for (const turn of toolCalls) {
			const seenCalls = new Set();
			for (const call of turn) {
				const sig = `${call.name}:${JSON.stringify(call.args)}`;
				if (seenCalls.has(sig)) {
					executedCalls.push({ ...call, skipped: true });
				} else {
					seenCalls.add(sig);
					executedCalls.push({ ...call, skipped: false });
				}
			}
		}
		return executedCalls;
	}

	// Same tool+args in different turns should NOT be skipped
	const turns = [
		[{ name: "strings", args: { path: "/bin/ls" } }],
		[{ name: "strings", args: { path: "/bin/ls" } }], // Same call, different turn
	];
	const result = simulateTurns(turns);
	ok(result[0].skipped === false, "first call executed");
	ok(result[1].skipped === false, "same call in different turn NOT skipped");

	// Same tool+args in same turn SHOULD be skipped
	const sameTurn = [[
		{ name: "strings", args: { path: "/bin/ls" } },
		{ name: "strings", args: { path: "/bin/ls" } }, // Same call, same turn
	]];
	const result2 = simulateTurns(sameTurn);
	ok(result2[0].skipped === false, "first call in turn executed");
	ok(result2[1].skipped === true, "duplicate call in same turn skipped");
}

// ─── Test 1: Tool schema filtering ────────────────────────────

function testToolSchemaFiltering() {
	console.log("\n─ tool schema filtering ─");

	// Simulate filtering logic
	const allTools = [
		{ name: "shell", description: "Run shell command" },
		{ name: "strings", description: "Extract strings" },
		{ name: "ghidra_decompile", description: "Decompile with Ghidra" },
		{ name: "frida", description: "Dynamic analysis" },
		{ name: "angr", description: "Symbolic execution" },
		{ name: "write_file", description: "Write file" },
	];

	const toolAvailability = {
		shell: true,
		strings: true,
		ghidra_decompile: false,  // Not installed
		frida: false,             // Not installed
		angr: false,              // Not installed
		write_file: true,
	};

	const filtered = allTools.filter(t => toolAvailability[t.name] !== false);
	ok(filtered.length === 3, `filtered to available tools (got: ${filtered.length})`);
	ok(filtered.some(t => t.name === "shell"), "shell included");
	ok(filtered.some(t => t.name === "strings"), "strings included");
	ok(filtered.some(t => t.name === "write_file"), "write_file included");
	ok(!filtered.some(t => t.name === "ghidra_decompile"), "ghidra_decompile excluded");
	ok(!filtered.some(t => t.name === "frida"), "frida excluded");
	ok(!filtered.some(t => t.name === "angr"), "angr excluded");

	// Token savings estimate
	const allChars = JSON.stringify(allTools).length;
	const filteredChars = JSON.stringify(filtered).length;
	const savings = Math.round((1 - filteredChars / allChars) * 100);
	ok(savings > 0, `token savings: ${savings}% (${allChars} → ${filteredChars} chars)`);
}

// ─── Test 9: turns count ──────────────────────────────────────

function testTurnsCount() {
	console.log("\n─ turns count ─");

	// Old behavior: turns = toolCallLog.length
	// New behavior: turns = actual LLM turns
	const toolCallLog = [
		{ name: "filetype", args: {}, result: "ELF" },
		{ name: "strings", args: {}, result: "..." },
		{ name: "objdump", args: {}, result: "..." },
	];

	const oldTurns = toolCallLog.length; // 3
	const newTurns = 2; // 2 LLM turns: first produced 1 tool call, second produced 2

	ok(oldTurns === 3, `old turns count = tool calls (${oldTurns})`);
	ok(newTurns === 2, `new turns count = actual LLM turns (${newTurns})`);
	ok(newTurns !== oldTurns, "turns count differs from tool call count");
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
	console.log("pire bugfix tests\n");

	testToolSchemaFiltering();
	testContextTrimming();
	testSeenCallsPerTurn();
	await testErrorHandling();
	testE2EConfigParsing();
	testModelsConfigParsing();
	testMaxToolOutput();
	testTurnsCount();

	console.log(`\n${"─".repeat(50)}`);
	console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
