#!/usr/bin/env node
/**
 * pire-reimpl.ts — Full RE + Reimplementation pipeline
 *
 * Gives pire a binary and asks it to:
 * 1. Reverse engineer it completely (filetype, strings, disasm, decompile)
 * 2. Write a reimplementation in C
 * 3. Compile and test it
 *
 * The agent runs autonomously with up to 40 tool-call turns.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as https from "node:https";
import * as http from "node:http";
import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools, type AgentTool } from "./index.js";
import { Type } from "typebox";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── LLM Config (same as TUI) ──────────────────────────────────

interface LLMConfig { baseUrl: string; apiKey: string; model: string }

function loadLLMConfig(): LLMConfig | null {
	const candidates = [
		process.env.HERMES_CONFIG,
		join(process.env.HOME || "/tmp", ".hermes/config.yaml"),
		join(process.env.HOME || "/tmp", ".hermes/profiles/default/config.yaml"),
	];
	for (const path of candidates) {
		if (!path || !existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf-8");
			const baseUrl = content.match(/base_url:\s*(.+)/)?.[1]?.trim();
			const apiKey = content.match(/api_key:\s*(.+)/)?.[1]?.trim();
			const model = content.match(/^\s*default:\s*(.+)/m)?.[1]?.trim();
			if (baseUrl && apiKey && model) return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
		} catch {}
	}
	if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
		return { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-4" };
	}
	return null;
}

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

function toolToFunction(tool: AgentTool<any>) {
	const schema = tool.parameters as any;
	const props = schema?.properties ?? {};
	const required = schema?.required ?? Object.keys(props);
	return {
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: { type: "object", properties: props, required },
		},
	};
}

async function callLLM(config: LLMConfig, messages: ChatMessage[], tools?: object[]): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
	const url = new URL(config.baseUrl.replace(/\/$/, "") + "/chat/completions");
	const body = JSON.stringify({
		model: config.model,
		messages,
		tools: tools?.length ? tools : undefined,
		max_tokens: 8192,
		stream: true,
	});

	const options: http.RequestOptions = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${config.apiKey}`,
		},
	};

	const doRequest = (): Promise<{ content: string | null; tool_calls?: ToolCall[] }> => new Promise((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		const req = client.request(url, options, (res) => {
			if (res.statusCode && res.statusCode >= 500) { reject(new Error(`HTTP ${res.statusCode}`)); return; }

			let content = "";
			let toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
			let buffer = "";

			res.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) continue;
					const data = trimmed.slice(6);
					if (data === "[DONE]") continue;

					try {
						const json = JSON.parse(data);
						const delta = json.choices?.[0]?.delta;
						if (!delta) continue;

						if (delta.content) content += delta.content;
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								const idx = tc.index ?? 0;
								if (!toolCalls[idx]) {
									toolCalls[idx] = { id: tc.id || "", type: "function" as const, function: { name: "", arguments: "" } };
								}
								if (tc.id) toolCalls[idx].id = tc.id;
								if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
								if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
							}
						}
					} catch { /* skip malformed */ }
				}
			});

			res.on("end", () => {
				resolve({
					content: content || null,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				});
			});
		});
		req.on("error", reject);
		req.setTimeout(180000, () => req.destroy(new Error("Timeout")));
		req.write(body);
		req.end();
	});

	let lastErr: Error | null = null;
	for (let i = 0; i < 3; i++) {
		try { return await doRequest(); }
		catch (e) { lastErr = e instanceof Error ? e : new Error(String(e)); if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
	}
	throw lastErr;
}

// ─── Write file tool (lets agent save reimplementation) ────────

const writeFileTool: AgentTool<{ path: string; content: string }> = {
	name: "write_file",
	description: "Write content to a file. Use to save reimplementation source code, notes, etc.",
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

// ─── Main ──────────────────────────────────────────────────────

async function main() {
	const binaryPath = process.argv[2];
	if (!binaryPath) {
		console.error("Usage: pire-reimpl <binary.exe>");
		process.exit(1);
	}

	if (!existsSync(binaryPath)) {
		console.error(`Binary not found: ${binaryPath}`);
		process.exit(1);
	}

	const config = loadLLMConfig();
	if (!config) {
		console.error("No LLM config found.");
		process.exit(1);
	}

	// Use non-thinking model for speed (thinking model takes too long per turn)
	const model = process.env.PIRE_MODEL || "GLM-5.2-non-thinking";
	config.model = model;

	console.log(`pire-reimpl — Full RE + Reimplementation`);
	console.log(`Target: ${binaryPath}`);
	console.log(`LLM: ${config.model}`);
	console.log(`Tools: ${RE_TOOLS.length + 1} (including write_file)`);
	console.log("");

	const tools = [...RE_TOOLS, writeFileTool];
	const toolMap = new Map<string, AgentTool<any>>();
	for (const tool of tools) toolMap.set(tool.name, tool);
	const toolSchemas = tools.map(toolToFunction);

	const toolsAvail = Object.entries(probeTools()).filter(([,v]) => v).map(([k]) => k).join(", ");

	const systemPrompt = `${RE_SYSTEM_PROMPT}

You are an expert reverse engineer. Your goal is to FULLY reverse engineer a binary and produce a working open-source reimplementation.

## Workflow
1. **Triage** (turns 1-5): Run filetype, strings, r2 to understand the binary
2. **Black-box testing** (turns 5-15): Run the binary with various inputs, observe outputs
3. **Deep Analysis** (turns 10-25): Disassemble key functions, understand the algorithm
4. **Write analysis.md** (by turn 25): Document your findings
5. **Write reimpl.c** (by turn 30): Write a C source file that replicates the binary's behavior
6. **Test** (turns 30+): Compile and compare outputs against the original binary
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
- The original binary can be run with: WINEPREFIX=${process.env.WINEPREFIX || "$HOME/.wine"} wine ${binaryPath} <args>
- Your reimplementation should be compiled with: gcc -o reimpl reimpl.c
- Compare outputs: run both the original and your reimplementation with the same inputs
- Available tools: ${toolsAvail}

## Output Format Matching
- Windows binaries typically output CRLF (\\r\\n) line endings
- Always check: pipe both original and reimpl output through xxd | head -5
- If the original uses CRLF, your reimpl must too (use \\r\\n in printf/fprintf)
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
Write your reimplementation to: ${join(dirname(binaryPath), "reimpl.c")}
Write your analysis to: ${join(dirname(binaryPath), "analysis.md")}
`;

	const userMessage = `Reverse engineer the binary at ${binaryPath} and create a working open-source reimplementation.

Steps:
1. Analyze the binary (filetype, strings, disassembly)
2. Understand the complete algorithm
3. Write your analysis to ${join(dirname(binaryPath), "analysis.md")}
4. Write a C reimplementation to ${join(dirname(binaryPath), "reimpl.c")}
5. Compile it with gcc and test it against the original (using WINEPREFIX=${process.env.WINEPREFIX || "$HOME/.wine"} wine for the original)
6. Test with multiple inputs — both valid and invalid
7. Iterate until your reimplementation matches the original's behavior

Go!`;

	const messages: ChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];

	const MAX_TURNS = 80;
	const reimplPath = join(dirname(binaryPath), "reimpl.c");
	const analysisPath = join(dirname(binaryPath), "analysis.md");

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		console.log(`\n--- Turn ${turn + 1}/${MAX_TURNS} ---`);

		let resp;
		try {
			resp = await callLLM(config, messages, toolSchemas);
		} catch (e) {
			console.error(`LLM error: ${e instanceof Error ? e.message : e}`);
			break;
		}

		// ─── Deadline enforcement ───────────────────────────────
		// Inject reminders to force the agent to start writing
		// (runs every turn, before tool processing, so it actually fires)
		const analysisExists = existsSync(analysisPath);
		const reimplExists = existsSync(reimplPath);
		if (turn === 24 && !analysisExists) {
			const msg = "⚠️ DEADLINE: You are at turn 25. You MUST write analysis.md NOW using write_file. Stop testing and write your analysis immediately.";
			messages.push({ role: "user", content: msg });
			console.log(`  ${msg}`);
		}
		if (turn === 29 && !reimplExists) {
			const msg = "⚠️ DEADLINE: You are at turn 30. You MUST write reimpl.c NOW using write_file. Write your best C reimplementation immediately — you can test and fix it in remaining turns.";
			messages.push({ role: "user", content: msg });
			console.log(`  ${msg}`);
		}
		if (turn === 39 && !reimplExists) {
			const msg = "⚠️ URGENT: You are at turn 40. You have NOT written reimpl.c yet. Write it NOW. Do not run any more shell commands. Call write_file with your C source code immediately.";
			messages.push({ role: "user", content: msg });
			console.log(`  ${msg}`);
		}
		if (turn === 49 && !reimplExists) {
			const msg = "⚠️ FINAL DEADLINE: You are at turn 50. Write reimpl.c IMMEDIATELY. Even if imperfect, a partial reimplementation is better than none. Use write_file now.";
			messages.push({ role: "user", content: msg });
			console.log(`  ${msg}`);
		}
		if (turn === 69 && !reimplExists) {
			const msg = "⚠️ LAST CHANCE: Turn 70. Write reimpl.c RIGHT NOW with write_file. Do not call any other tool.";
			messages.push({ role: "user", content: msg });
			console.log(`  ${msg}`);
		}

		if (resp.tool_calls && resp.tool_calls.length > 0) {
			// ─── Hard deadline: block non-write_file calls past turn 40 ──
			if (turn >= 39 && !reimplExists) {
				const nonWriteCalls = resp.tool_calls.filter((tc: any) => tc.function.name !== "write_file");
				if (nonWriteCalls.length > 0) {
					for (const tc of nonWriteCalls) {
						messages.push({ role: "tool", tool_call_id: tc.id, content: "BLOCKED: You are past the write deadline (turn 40). You MUST call write_file to write reimpl.c before doing anything else. No other tools are allowed." });
					}
					// Still allow write_file calls through
					const writeCalls = resp.tool_calls.filter((tc: any) => tc.function.name === "write_file");
					if (writeCalls.length === 0) {
						messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls });
						console.log("  ⚠️ Blocked non-write_file calls (past deadline)");
						continue;
					}
					// Process only the write_file calls
					resp.tool_calls = writeCalls;
				}
			}

			for (const tc of resp.tool_calls) {
				let args: Record<string, unknown> = {};
				try { args = JSON.parse(tc.function.arguments); } catch {}
				const argStr = Object.entries(args).map(([k,v]) => {
					const val = String(v);
					return val.length > 100 ? `${k}=${val.slice(0,100)}...` : `${k}=${val}`;
				}).join(" ");
				console.log(`  ⚙ ${tc.function.name}(${argStr})`);
			}

			messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls });

			for (const tc of resp.tool_calls) {
				const tool = toolMap.get(tc.function.name);
				if (!tool) {
					messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: unknown tool "${tc.function.name}"` });
					continue;
				}
				let params: Record<string, unknown>;
				try { params = JSON.parse(tc.function.arguments); }
				catch { params = {}; }

				try {
					const result = await tool.execute("reimpl", params);
					const text = result.content.map((c: { text: string }) => c.text).join("\n");
					const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n... (truncated)" : text;
					messages.push({ role: "tool", tool_call_id: tc.id, content: truncated });

					// Show brief output
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
	console.log(`Analysis: ${existsSync(analysisPath) ? "✓ " + analysisPath : "✗ not written"}`);
	console.log(`Reimplementation: ${existsSync(reimplPath) ? "✓ " + reimplPath : "✗ not written"}`);

	if (existsSync(reimplPath)) {
		console.log(`\nReimpl size: ${readFileSync(reimplPath, "utf-8").length} bytes`);
	}
	if (existsSync(analysisPath)) {
		console.log(`Analysis size: ${readFileSync(analysisPath, "utf-8").length} bytes`);
	}
}

main().catch(console.error);
