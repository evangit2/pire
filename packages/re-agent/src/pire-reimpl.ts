#!/usr/bin/env node
/**
 * pire-reimpl.ts — Autonomous RE pipeline
 *
 * Gives pire a binary and a task, then lets it run autonomously with
 * tool-call deadlines. Defaults to full RE + reimplementation, but
 * accepts custom task prompts for any RE workflow:
 *
 *   pire-reimpl <binary>                      — full RE + reimplement in C
 *   pire-reimpl <binary> --task "extract all strings and find C2 URLs"
 *   pire-reimpl <binary> --task "document the crypto algorithm in analysis.md"
 *   pire-reimpl <binary> --task "identify the packing mechanism and unpack it"
 *   pire-reimpl <binary> --turns 40                           — shorter budget
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { type AgentTool, probeTools, RE_SYSTEM_PROMPT, RE_TOOLS } from "./index.js";
import { type ChatMessage, callLLM, loadLLMConfig, toolToFunction } from "./llm.js";
import { loadSettings } from "./pire-config.js";

// Tool output truncation: use settings.max_output (default 100000)
const _settings = loadSettings();
const MAX_TOOL_OUTPUT = _settings.max_output || 100000;

// ─── Write file tool (lets agent save files) ──────────────────

const writeFileTool: AgentTool<{ path: string; content: string }> = {
	name: "write_file",
	description: "Write content to a file. Use to save source code, analysis, notes, etc.",
	parameters: Type.Object({
		path: Type.String({ description: "File path to write" }),
		content: Type.String({ description: "File content" }),
	}),
	async execute(_id, params) {
		mkdirSync(dirname(params.path), { recursive: true });
		writeFileSync(params.path, params.content);
		return { content: [{ type: "text" as const, text: `Wrote ${params.content.length} bytes to ${params.path}` }] };
	},
};

// ─── Default task: full RE + reimplementation ─────────────────

const DEFAULT_TASK = `Reverse engineer the binary at {BINARY} and create a working open-source reimplementation.

1. Analyze the binary (filetype, strings, disassembly)
2. Understand the complete algorithm
3. Write your analysis to {DIR}/analysis.md
4. Write a C reimplementation to {DIR}/reimpl.c
5. Compile it with gcc and test it against the original (using WINEPREFIX={WINEPREFIX} wine for the original)
6. Test with multiple inputs — both valid and invalid
7. Iterate until your reimplementation matches the original's behavior

Go!`;

const DEFAULT_SYSTEM = `You are an expert reverse engineer. Your goal is to FULLY reverse engineer a binary and produce a working open-source reimplementation.

## Workflow
1. **Triage** (turns 1-5): Run filetype, strings, r2 to understand the binary
2. **Black-box testing** (turns 5-15): Run the binary with various inputs, observe outputs
3. **Deep Analysis** (turns 10-25): Disassemble key functions, understand the algorithm
4. **Write analysis.md** (by turn 25): Document your findings
5. **Write reimpl.c** (by turn 30): Write a C source file that replicates the binary's behavior
6. **Test** (turns 30+): Compile with gcc and compare outputs against the original binary
7. **Iterate** (remaining turns): Fix and retest

## CRITICAL: Time Management
- You MUST write analysis.md by turn 25 and reimpl.c by turn 30
- Do NOT spend more than 15 turns on black-box testing
- Start writing code early — you can always fix it later with more testing
- A working reimplementation with minor bugs is better than perfect analysis with no code

## Key Rules
- You have a shell tool — use it to run wine, gcc, diff, etc.
- You have a write_file tool — use it to save source code
- You have a decompile tool — use it for r2 pseudo-C decompilation (pdc) at any address
- The original binary can be run with: WINEPREFIX={WINEPREFIX} wine {BINARY} <args>
- Your reimplementation should be compiled with: gcc -o reimpl reimpl.c
- Compare outputs: run both the original and your reimplementation with the same inputs
- Available tools: {TOOLS}

## Output Format Matching
- Windows binaries typically output CRLF (\\\\r\\\\n) line endings
- Always check: pipe both original and reimpl output through xxd | head -5
- If the original uses CRLF, your reimpl must too (use \\\\r\\\\n in printf/fprintf)
- Match exit codes exactly (test with: echo "exit:$?")
- Match error messages exactly (case, punctuation, spacing)

## SIMD/SSE Warning
- If you see xmm/movdqu/punpck instructions, the compiler auto-vectorized a loop
- Don't try to reverse individual SSE shuffles — instead:
  1. Identify the high-level operation (it's usually a loop over bytes/ints)
  2. Write a simple C loop version and test it against the binary
  3. Use black-box testing (input→output) to verify, not instruction-level tracing
- Focus on behavior, not instruction-for-instruction matching

## Output
Write your reimplementation to: {DIR}/reimpl.c
Write your analysis to: {DIR}/analysis.md`;

// ─── Custom task system prompt (no deadlines, flexible) ──────

const CUSTOM_SYSTEM = `You are an expert reverse engineer. The user has given you a binary and a specific task.

## Rules
- You have a shell tool — use it to run wine, gcc, diff, etc.
- You have a write_file tool — use it to save any output files
- You have a decompile tool — use it for r2 pseudo-C decompilation (pdc) at any address
- The original binary can be run with: WINEPREFIX={WINEPREFIX} wine {BINARY} <args>
- Available tools: {TOOLS}
- Adapt your approach to the task — don't follow a fixed workflow
- Be thorough but focused on what the task asks for

## Output
Write any output files to: {DIR}/`;

// ─── Parse args ───────────────────────────────────────────────

interface Args {
	binaryPath: string;
	task: string;
	customSystem: boolean;
	maxTurns: number;
}

function parseArgs(argv: string[]): Args {
	const args = argv.slice(2);
	let binaryPath = "";
	let task = "";
	let customSystem = false;
	let maxTurns = 80;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--task" || args[i] === "-t") {
			task = args[++i] ?? "";
			customSystem = true;
		} else if (args[i] === "--turns" || args[i] === "-n") {
			maxTurns = parseInt(args[++i] ?? "80", 10) || 80;
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`pire — Autonomous RE pipeline

Usage:
  pire-reimpl <binary>                      Full RE + reimplementation
  pire-reimpl <binary> --task "..."         Custom task prompt
  pire-reimpl <binary> --turns 40           Set turn budget (default 80)

Options:
  --task, -t "prompt"   Custom task for the agent
  --turns, -n N         Max tool-call turns (default 80)
  --help, -h            Show this help

Examples:
  pire-reimpl malware.exe
  pire-reimpl malware.exe --task "extract all strings and find C2 URLs"
  pire-reimpl firmware.bin --task "identify the packing mechanism and unpack it"
  pire-reimpl app.exe --task "document the crypto algorithm in analysis.md" --turns 40
`);
			process.exit(0);
		} else if (!args[i].startsWith("-")) {
			binaryPath = args[i];
		}
	}

	if (!binaryPath) {
		console.error('Usage: pire-reimpl <binary> [--task "..."] [--turns N]');
		process.exit(1);
	}

	if (!existsSync(binaryPath)) {
		console.error(`Binary not found: ${binaryPath}`);
		process.exit(1);
	}

	return { binaryPath, task, customSystem, maxTurns };
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
	const { binaryPath, task, customSystem, maxTurns } = parseArgs(process.argv);

	const config = loadLLMConfig();
	if (!config) {
		console.error("No LLM config found.");
		process.exit(1);
	}

	const model = process.env.PIRE_MODEL || config.model;
	config.model = model;

	const winePrefix = process.env.WINEPREFIX || "$HOME/.wine";
	const dir = dirname(binaryPath);
	const toolsAvail = Object.entries(probeTools())
		.filter(([, v]) => v)
		.map(([k]) => k)
		.join(", ");

	// Build task prompt
	const taskPrompt = (task || DEFAULT_TASK)
		.replace("{BINARY}", binaryPath)
		.replace("{DIR}", dir)
		.replace("{WINEPREFIX}", winePrefix);

	// Build system prompt
	const systemTemplate = customSystem ? CUSTOM_SYSTEM : DEFAULT_SYSTEM;
	const systemPrompt = `${RE_SYSTEM_PROMPT}

${systemTemplate
	.replace("{BINARY}", binaryPath)
	.replace("{DIR}", dir)
	.replace("{WINEPREFIX}", winePrefix)
	.replace("{TOOLS}", toolsAvail)}`;

	console.log(`pire — Autonomous RE pipeline`);
	console.log(`Target: ${binaryPath}`);
	console.log(
		`Task: ${customSystem ? task.slice(0, 80) + (task.length > 80 ? "..." : "") : "Full RE + reimplementation"}`,
	);
	console.log(`LLM: ${config.model}`);
	console.log(`Turns: ${maxTurns}`);
	console.log(`Tools: ${RE_TOOLS.length + 1} (including write_file)`);
	console.log("");

	const tools = [...RE_TOOLS, writeFileTool];
	const toolMap = new Map<string, AgentTool<any>>();
	for (const tool of tools) toolMap.set(tool.name, tool);
	const toolSchemas = tools.map(toolToFunction);

	const messages: ChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: taskPrompt },
	];

	const reimplPath = join(dir, "reimpl.c");
	const analysisPath = join(dir, "analysis.md");

	for (let turn = 0; turn < maxTurns; turn++) {
		console.log(`\n--- Turn ${turn + 1}/${maxTurns} ---`);

		let resp;
		try {
			resp = await callLLM(config, messages, toolSchemas);
		} catch (e) {
			console.error(`LLM error: ${e instanceof Error ? e.message : e}`);
			break;
		}

		// ─── Deadline enforcement (only for default reimpl task) ──
		if (!customSystem) {
			const analysisExists = existsSync(analysisPath);
			const reimplExists = existsSync(reimplPath);
			if (turn === 24 && !analysisExists) {
				const msg =
					"⚠️ DEADLINE: You are at turn 25. You MUST write analysis.md NOW using write_file. Stop testing and write your analysis immediately.";
				messages.push({ role: "user", content: msg });
				console.log(`  ${msg}`);
			}
			if (turn === 29 && !reimplExists) {
				const msg =
					"⚠️ DEADLINE: You are at turn 30. You MUST write reimpl.c NOW using write_file. Write your best C reimplementation immediately — you can test and fix it in remaining turns.";
				messages.push({ role: "user", content: msg });
				console.log(`  ${msg}`);
			}
			if (turn === 39 && !reimplExists) {
				const msg =
					"⚠️ URGENT: You are at turn 40. You have NOT written reimpl.c yet. Write it NOW. Do not run any more shell commands. Call write_file with your C source code immediately.";
				messages.push({ role: "user", content: msg });
				console.log(`  ${msg}`);
			}
			if (turn === 49 && !reimplExists) {
				const msg =
					"⚠️ FINAL DEADLINE: You are at turn 50. Write reimpl.c IMMEDIATELY. Even if imperfect, a partial reimplementation is better than none. Use write_file now.";
				messages.push({ role: "user", content: msg });
				console.log(`  ${msg}`);
			}
			if (turn === 69 && !reimplExists) {
				const msg = "⚠️ LAST CHANCE: Turn 70. Write reimpl.c RIGHT NOW with write_file. Do not call any other tool.";
				messages.push({ role: "user", content: msg });
				console.log(`  ${msg}`);
			}
		}

		if (resp.tool_calls && resp.tool_calls.length > 0) {
			// ─── Hard deadline: block non-write_file calls past turn 40 (reimpl only) ──
			if (!customSystem && turn >= 39 && !existsSync(reimplPath)) {
				const nonWriteCalls = resp.tool_calls.filter((tc) => tc.function.name !== "write_file");
				if (nonWriteCalls.length > 0) {
					for (const tc of nonWriteCalls) {
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content:
								"BLOCKED: You are past the write deadline (turn 40). You MUST call write_file to write reimpl.c before doing anything else. No other tools are allowed.",
						});
					}
					const writeCalls = resp.tool_calls.filter((tc) => tc.function.name === "write_file");
					if (writeCalls.length === 0) {
						messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls });
						console.log("  ⚠️ Blocked non-write_file calls (past deadline)");
						continue;
					}
					resp.tool_calls = writeCalls;
				}
			}

			for (const tc of resp.tool_calls) {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {}
				const argStr = Object.entries(args)
					.map(([k, v]) => {
						const val = String(v);
						return val.length > 100 ? `${k}=${val.slice(0, 100)}...` : `${k}=${val}`;
					})
					.join(" ");
				console.log(`  ⚙ ${tc.function.name}(${argStr})`);
			}

			messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls });

			for (const tc of resp.tool_calls) {
				const tool = toolMap.get(tc.function.name);
				if (!tool) {
					messages.push({
						role: "tool",
						tool_call_id: tc.id,
						content: `Error: unknown tool "${tc.function.name}"`,
					});
					continue;
				}
				let params: Record<string, unknown>;
				try {
					params = JSON.parse(tc.function.arguments);
				} catch {
					params = {};
				}

				try {
					const result = await tool.execute("reimpl", params);
					const text = result.content.map((c: { text: string }) => c.text).join("\n");
					const truncated =
						text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n... (truncated)" : text;
					messages.push({ role: "tool", tool_call_id: tc.id, content: truncated });

					const preview = text.slice(0, 200).replace(/\n/g, "\n  ");
					console.log(`  → ${preview}${text.length > 200 ? "..." : ""}`);
				} catch (e) {
					const errMsg = e instanceof Error ? e.message : String(e);
					messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${errMsg}` });
					console.log(`  ! ${errMsg.slice(0, 200)}`);
				}
			}
			continue;
		}

		if (resp.content) {
			console.log(`\n${resp.content}`);
			messages.push({ role: "assistant", content: resp.content });
		}
		break;
	}

	// Check results
	console.log("\n=== Results ===");
	if (customSystem) {
		console.log(`Task completed (${maxTurns} turn budget).`);
	} else {
		console.log(`Analysis: ${existsSync(analysisPath) ? "✓ " + analysisPath : "✗ not written"}`);
		console.log(`Reimplementation: ${existsSync(reimplPath) ? "✓ " + reimplPath : "✗ not written"}`);

		if (existsSync(reimplPath)) {
			console.log(`\nReimpl size: ${readFileSync(reimplPath, "utf-8").length} bytes`);
		}
		if (existsSync(analysisPath)) {
			console.log(`Analysis size: ${readFileSync(analysisPath, "utf-8").length} bytes`);
		}
	}
}

main().catch(console.error);
