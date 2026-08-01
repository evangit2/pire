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
		join(process.env.HOME || "/home/evan", ".hermes/config.yaml"),
		join(process.env.HOME || "/home/evan", ".hermes/profiles/default/config.yaml"),
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
1. **Triage**: Run filetype, strings, readelf/objdump to understand the binary
2. **Deep Analysis**: Disassemble key functions, understand the algorithm
3. **Document**: Write your findings to a file called analysis.md
4. **Reimplement**: Write a C source file that replicates the binary's behavior
5. **Test**: Compile your reimplementation and compare its output against the original binary
6. **Iterate**: If tests fail, fix your code and retest

## Key Rules
- You have a shell tool — use it to run wine, gcc, diff, etc.
- You have a write_file tool — use it to save source code
- You have a decompile tool — use it for r2 pseudo-C decompilation (pdc) at any address
- The original binary can be run with: WINEPREFIX=/home/evan/.wine64 wine ${binaryPath} <args>
- Your reimplementation should be compiled with: gcc -o reimpl reimpl.c
- Compare outputs: run both the original and your reimplementation with the same inputs
- Be thorough — understand every check and branch before writing code
- Available tools: ${toolsAvail}

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
5. Compile it with gcc and test it against the original (using WINEPREFIX=/home/evan/.wine64 wine for the original)
6. Test with multiple inputs — both valid and invalid
7. Iterate until your reimplementation matches the original's behavior

Go!`;

	const messages: ChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];

	const MAX_TURNS = 50;

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		console.log(`\n--- Turn ${turn + 1}/${MAX_TURNS} ---`);

		let resp;
		try {
			resp = await callLLM(config, messages, toolSchemas);
		} catch (e) {
			console.error(`LLM error: ${e instanceof Error ? e.message : e}`);
			break;
		}

		if (resp.tool_calls && resp.tool_calls.length > 0) {
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
	const reimplPath = join(dirname(binaryPath), "reimpl.c");
	const analysisPath = join(dirname(binaryPath), "analysis.md");
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
