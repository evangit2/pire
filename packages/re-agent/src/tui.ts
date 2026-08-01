/**
 * pire TUI — Autonomous RE agent chat
 *
 * Just start chatting. The agent can run tools itself.
 * Say "analyze /bin/ls" and it calls filetype, strings, etc. autonomously.
 * Point it at a directory, a binary, a URL — it figures out what to do.
 *
 * Commands:
 *  :tools         — List all tools
 *  :probe         — Probe system
 *  :skills        — List skills
 *  :help          — Show commands
 *  :quit          — Exit
 */

import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as https from "node:https";
import * as http from "node:http";
import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools, type AgentTool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.3.0";

// ANSI
const C = {
	reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
	red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
	blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

// ─── LLM Config ────────────────────────────────────────────────

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

// ─── LLM types ─────────────────────────────────────────────────

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

// ─── Tool schema conversion ────────────────────────────────────

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

// ─── LLM call with tool support ────────────────────────────────

interface LLMResponse {
	content: string | null;
	tool_calls?: ToolCall[];
}

async function callLLM(config: LLMConfig, messages: ChatMessage[], tools?: object[]): Promise<LLMResponse> {
	const url = new URL(config.baseUrl.replace(/\/$/, "") + "/chat/completions");
	const body = JSON.stringify({
		model: config.model,
		messages,
		tools: tools?.length ? tools : undefined,
		max_tokens: 8000,
		stream: false,
	});

	const options: http.RequestOptions = {
		method: "POST",
		headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
	};

	const doRequest = (): Promise<LLMResponse> => new Promise((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		const req = client.request(url, options, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				if (res.statusCode && res.statusCode >= 500) {
					reject(new Error(`HTTP ${res.statusCode}`));
					return;
				}
				try {
					const json = JSON.parse(data);
					const msg = json.choices?.[0]?.message;
					resolve({
						content: msg?.content ?? msg?.reasoning ?? null,
						tool_calls: msg?.tool_calls,
					});
				} catch {
					reject(new Error(`Parse error: ${data.slice(0, 200)}`));
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(90000, () => req.destroy(new Error("Timeout")));
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

// ─── TUI ───────────────────────────────────────────────────────

export class PireTUI {
	private rl: readline.Interface;
	private llm: LLMConfig | null = null;
	private tools: Record<string, boolean> = {};
	private messages: ChatMessage[] = [];
	private toolMap: Map<string, AgentTool<any>> = new Map();
	private running = false;

	constructor(target?: string) {
		this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		if (target) {
			// If target was passed as CLI arg, inject it into the first user message
			this.messages.push({ role: "user", content: `I want to analyze: ${target}` });
		}
	}

	async start() {
		this.print("info", `pire v${VERSION} — Reverse Engineering Agent`);
		this.print("info", `Just tell me what to analyze. I'll run the tools myself.`);

		this.llm = loadLLMConfig();
		if (this.llm) {
			this.print("info", `LLM: ${this.llm.model}`);
		} else {
			this.print("err", "No LLM config. Set HERMES_CONFIG or OPENAI_API_KEY/OPENAI_BASE_URL.");
		}

		this.print("info", "Probing system...");
		this.tools = probeTools();
		const avail = Object.values(this.tools).filter(Boolean).length;
		this.print("info", `${avail}/${Object.keys(this.tools).length} tools available`);

		// Build tool map
		for (const tool of RE_TOOLS) this.toolMap.set(tool.name, tool);

		// If target was passed, kick off analysis automatically
		if (this.messages.length > 0) {
			this.render();
			await this.agentLoop(this.messages[0].content!);
			this.messages = []; // consumed
		}

		this.render();
		this.rl.setPrompt("");
		this.rl.on("line", (line) => { this.inputQueue.push(line); this.processQueue(); });
		this.rl.on("close", () => this.stop());
	}

	private inputQueue: string[] = [];
	private processing = false;

	private async processQueue() {
		if (this.processing) return;
		this.processing = true;
		while (this.inputQueue.length > 0) {
			const line = this.inputQueue.shift()!;
			await this.handleInput(line);
		}
		this.processing = false;
	}

	// ─── Agent loop: call LLM, execute tools, repeat ──────────

	private async agentLoop(userMessage: string) {
		if (!this.llm) {
			this.print("err", "No LLM configured.");
			return;
		}

		// Build system prompt with tool availability
		const availTools = Object.entries(this.tools).filter(([,v]) => v).map(([k]) => k).join(", ");
		const systemPrompt = `${RE_SYSTEM_PROMPT}

You have ${RE_TOOLS.length} tools available. Available on this system: ${availTools}.

When the user mentions a path, binary, or directory — run tools on it yourself. Don't ask them to type commands.
If given a directory, list its contents first (use shell), identify interesting files, then analyze them.
If given a binary, start with filetype + strings + readelf, then dig deeper.
Be proactive — run multiple tools in sequence to build a complete picture.`;

		const messages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...this.messages,
			{ role: "user", content: userMessage },
		];

		// Add to conversation history
		this.messages.push({ role: "user", content: userMessage });

		const toolSchemas = RE_TOOLS.map(toolToFunction);
		const MAX_TURNS = 15;

		for (let turn = 0; turn < MAX_TURNS; turn++) {
			let resp: LLMResponse;
			try {
				resp = await callLLM(this.llm, messages, toolSchemas);
			} catch (e) {
				this.print("err", `LLM error: ${e instanceof Error ? e.message : e}`);
				return;
			}

			// If there are tool calls, execute them
			if (resp.tool_calls && resp.tool_calls.length > 0) {
				// Show what the agent is doing
				for (const tc of resp.tool_calls) {
					const args = JSON.parse(tc.function.arguments);
					const argStr = Object.entries(args).map(([k,v]) => `${k}=${v}`).join(" ");
					this.print("tool", `⚙ ${tc.function.name}(${argStr})`);
				}

				// Add assistant message with tool_calls to conversation
				const assistantMsg: ChatMessage = {
					role: "assistant",
					content: resp.content,
					tool_calls: resp.tool_calls,
				};
				messages.push(assistantMsg);

				// Execute each tool call
				for (const tc of resp.tool_calls) {
					const tool = this.toolMap.get(tc.function.name);
					if (!tool) {
						messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: unknown tool "${tc.function.name}"` });
						continue;
					}
					let params: Record<string, unknown>;
					try { params = JSON.parse(tc.function.arguments); }
					catch { params = {}; }

					try {
						const result = await tool.execute("pire", params);
						const text = result.content.map((c: { text: string }) => c.text).join("\n");
						// Truncate very long output to keep context manageable
						const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n... (truncated)" : text;
						messages.push({ role: "tool", tool_call_id: tc.id, content: truncated });
					} catch (e) {
						messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${e instanceof Error ? e.message : e}` });
					}
				}
				this.render();
				continue; // Let the LLM see tool results and continue
			}

			// No tool calls — this is the final response
			if (resp.content) {
				this.print("chat", resp.content);
				this.messages.push({ role: "assistant", content: resp.content });
			}
			break;
		}

		this.render();
	}

	// ─── Input handling ───────────────────────────────────────

	private async handleInput(line: string) {
		const cmd = line.trim();
		if (!cmd) { this.render(); return; }

		if (cmd === ":quit" || cmd === ":q" || cmd === "exit") { this.stop(); return; }

		if (cmd === ":help" || cmd === ":h") {
			this.print("info", "Just type naturally — the agent will run tools for you.");
			this.print("info", "Examples:");
			this.print("info", "  analyze /bin/ls");
			this.print("info", "  what's in /opt/game/?");
			this.print("info", "  disassemble the main function in ./crackme");
			this.print("info", "");
			this.print("info", "Commands: :tools :probe :skills :help :quit");
			this.render();
			return;
		}

		if (cmd === ":tools") {
			for (const tool of RE_TOOLS) this.print("info", `  ${tool.name.padEnd(20)} ${tool.description.split(".")[0]}`);
			this.print("info", `${RE_TOOLS.length} tools registered`);
			this.render();
			return;
		}

		if (cmd === ":probe") {
			this.tools = probeTools();
			for (const [name, avail] of Object.entries(this.tools)) this.print("info", `  ${avail ? "✓" : "✗"} ${name}`);
			this.render();
			return;
		}

		if (cmd === ":skills") {
			try {
				let skillsDir = join(__dirname, "..", "..", "skills");
				try { readdirSync(skillsDir); } catch { skillsDir = join(__dirname, "..", "..", "..", "skills"); }
				const skills = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
				for (const s of skills) {
					try {
						const c = readFileSync(join(skillsDir, s.name, "SKILL.md"), "utf-8");
						const m = c.match(/^description:\s*(.+)$/m);
						this.print("info", `  ${s.name.padEnd(40)} ${m?.[1]?.trim() ?? ""}`);
					} catch {}
				}
				this.print("info", `${skills.length} skills`);
			} catch { this.print("err", "Skills directory not found"); }
			this.render();
			return;
		}

		// Everything else → agent loop
		this.print("chat", cmd);
		this.render();
		await this.agentLoop(cmd);
	}

	// ─── Output ───────────────────────────────────────────────

	private buffer: { text: string; kind: string }[] = [];

	private print(kind: string, text: string) {
		for (const line of text.split("\n")) this.buffer.push({ text: line, kind });
	}

	private render() {
		const prefixes: Record<string, string> = {
			err: `${C.red}! ${C.reset}`,
			info: `${C.blue}• ${C.reset}`,
			tool: `${C.green}⚙ ${C.reset}`,
			chat: `${C.bold}> ${C.reset}`,
		};
		for (const line of this.buffer) {
			const prefix = prefixes[line.kind] ?? "";
			process.stdout.write(prefix + line.text + C.reset + "\n");
		}
		this.buffer = [];
		process.stdout.write(`${C.bold}${C.green}pire${C.reset} > `);
	}

	stop() {
		this.running = false;
		this.rl.close();
		process.stdout.write(C.reset + "\n");
		process.exit(0);
	}
}
