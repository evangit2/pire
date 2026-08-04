/**
 * pire TUI — Autonomous RE agent chat
 *
 * Just start chatting. The agent can run tools itself.
 * Say "analyze /bin/ls" or "reverse engineer https://example.com/app.exe" — it figures out what to do.
 * Point it at a directory, a binary, a URL — it auto-detects file type and routes accordingly.
 *
 * Commands:
 *  :load <path|URL> — Load a binary or download from URL for analysis
 *  :tools           — List all tools
 *  :probe           — Probe system
 *  :skills          — List skills
 *  :save [path]     — Save conversation history
 *  :help            — Show commands
 *  :quit            — Exit
 */

import * as readline from "node:readline";
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools, fetchTool, type AgentTool } from "./index.js";
import { loadLLMConfig, toolToFunction, callLLM, type ChatMessage } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.83.0";

// ANSI
const C = {
	reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
	red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
	blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

// ─── TUI ───────────────────────────────────────────────────────

export class PireTUI {
	private rl: readline.Interface;
	private llm = loadLLMConfig();
	private tools: Record<string, boolean> = {};
	private messages: ChatMessage[] = [];
	private toolMap: Map<string, AgentTool<any>> = new Map();
	private loadedTarget: string | null = null;
	private pendingUrl: string | null = null;
	private inputQueue: string[] = [];
	private processing = false;

	constructor(target?: string) {
		this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		if (target) {
			if (/^https?:\/\//i.test(target)) {
				this.pendingUrl = target;
			} else {
				this.loadedTarget = target;
				this.messages.push({ role: "user", content: `I want to analyze: ${target}` });
			}
		}
	}

	async start() {
		this.print("info", `pire v${VERSION} — Reverse Engineering Agent`);
		this.print("info", `Just tell me what to analyze. I'll run the tools myself.`);

		if (this.llm) {
			this.print("info", `LLM: ${this.llm.model}`);
		} else {
			this.print("err", "No LLM config. Set PIRE_CONFIG or OPENAI_API_KEY/OPENAI_BASE_URL.");
		}

		this.print("info", "Probing system...");
		this.tools = probeTools();
		const avail = Object.values(this.tools).filter(Boolean).length;
		this.print("info", `${avail}/${Object.keys(this.tools).length} tools available`);

		for (const tool of RE_TOOLS) this.toolMap.set(tool.name, tool);

		if (this.messages.length > 0) {
			this.render();
			await this.agentLoop(this.messages[0].content!);
			this.messages = [];
		} else if (this.pendingUrl) {
			this.render();
			// Download URL before entering agent loop
			this.print("info", `Downloading from ${this.pendingUrl}...`);
			this.render();
			const fetchResult = await fetchTool.execute("pire", { url: this.pendingUrl });
			const text = fetchResult.content.map((c: { text: string }) => c.text).join("\n");
			this.print("tool", `fetch(${this.pendingUrl})`);
			const pathMatch = text.match(/Downloaded to: (.+)/);
			const localPath = pathMatch?.[1] || fetchResult.details?.path as string;
			if (localPath && existsSync(localPath)) {
				this.loadedTarget = localPath;
				this.print("info", text);
				this.render();
				await this.agentLoop(`Analyze this binary: ${localPath}`);
			} else {
				this.print("err", `Download failed: ${text}`);
				this.render();
			}
			this.pendingUrl = null;
		}

		this.render();
		this.rl.setPrompt("");
		this.rl.on("line", (line) => { this.inputQueue.push(line); this.processQueue(); });
		this.rl.on("close", () => { /* don't exit while processing */ });
	}

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

		const availTools = Object.entries(this.tools).filter(([,v]) => v).map(([k]) => k).join(", ");
		const targetInfo = this.loadedTarget ? `\n\nCurrently loaded target: ${this.loadedTarget}` : "";
		const systemPrompt = `${RE_SYSTEM_PROMPT}

You have ${RE_TOOLS.length} tools available. Available on this system: ${availTools}.${targetInfo}

When the user mentions a path, binary, or directory — run tools on it yourself. Don't ask them to type commands.
When the user provides a URL — use the fetch tool to download it first, then analyze.
If given a directory, list its contents first (use shell), identify interesting files, then analyze them.
If given a binary, start with filetype + strings + readelf, then dig deeper.
Be proactive — run multiple tools in sequence to build a complete picture.`;

		const messages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...this.messages,
			{ role: "user", content: userMessage },
		];

		this.messages.push({ role: "user", content: userMessage });

		const toolSchemas = RE_TOOLS.map(toolToFunction);
		const MAX_TURNS = 40;

		for (let turn = 0; turn < MAX_TURNS; turn++) {
			let resp;
			try {
				resp = await callLLM(this.llm, messages, toolSchemas, {
					onContent: (chunk) => { process.stdout.write(chunk); },
				});
			} catch (e) {
				this.print("err", `LLM error: ${e instanceof Error ? e.message : e}`);
				return;
			}

			// Newline after streaming content
			if (resp.content) process.stdout.write("\n");

			if (resp.tool_calls && resp.tool_calls.length > 0) {
				for (const tc of resp.tool_calls) {
					let args: Record<string, unknown> = {};
					try { args = JSON.parse(tc.function.arguments); } catch {}
					const argStr = Object.entries(args).map(([k,v]) => {
						const val = String(v);
						return val.length > 100 ? `${k}=${val.slice(0,100)}...` : `${k}=${val}`;
					}).join(" ");
					this.print("tool", `${tc.function.name}(${argStr})`);
				}

				messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls });

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
						const truncated = text.length > 16000 ? text.slice(0, 16000) + "\n... (truncated)" : text;
						messages.push({ role: "tool", tool_call_id: tc.id, content: truncated });
					} catch (e) {
						messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${e instanceof Error ? e.message : e}` });
					}
				}
				this.render();
				continue;
			}

			if (resp.content) {
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
			this.print("info", "  reverse engineer https://example.com/suspicious.exe");
			this.print("info", "  what's in /opt/game/?");
			this.print("info", "  disassemble the main function in ./crackme");
			this.print("info", "  download and analyze https://example.com/app.apk");
			this.print("info", "");
			this.print("info", "Commands: :load <path|URL> :tools :probe :skills :save [path] :help :quit");
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

		if (cmd.startsWith(":load")) {
			const path = cmd.slice(5).trim();
			if (!path) {
				this.print("err", "Usage: :load <path or URL>");
				this.render();
				return;
			}
			// URL detection — download first
			if (/^https?:\/\//i.test(path)) {
				this.print("info", `Downloading from ${path}...`);
				this.render();
				const fetchResult = await fetchTool.execute("pire", { url: path });
				const text = fetchResult.content.map((c: { text: string }) => c.text).join("\n");
				this.print("tool", `fetch(${path})`);
				this.render();
				// Extract the downloaded path from the result text
				const pathMatch = text.match(/Downloaded to: (.+)/);
				const localPath = pathMatch?.[1] || fetchResult.details?.path as string;
				if (localPath && existsSync(localPath)) {
					this.loadedTarget = localPath;
					this.print("info", text);
					this.render();
					await this.agentLoop(`Analyze this binary: ${localPath}`);
				} else {
					this.print("err", `Download failed: ${text}`);
					this.render();
				}
				return;
			}
			if (!existsSync(path)) {
				this.print("err", `Not found: ${path}`);
				this.render();
				return;
			}
			this.loadedTarget = path;
			this.print("info", `Loaded: ${path}`);
			this.render();
			await this.agentLoop(`Analyze this binary: ${path}`);
			return;
		}

		if (cmd.startsWith(":save")) {
			const savePath = cmd.slice(4).trim() || join(process.cwd(), `pire-session-${Date.now()}.json`);
			try {
				const data = JSON.stringify({ version: VERSION, target: this.loadedTarget, messages: this.messages }, null, 2);
				mkdirSync(dirname(savePath), { recursive: true });
				writeFileSync(savePath, data);
				this.print("info", `Saved ${this.messages.length} messages to ${savePath}`);
			} catch (e) {
				this.print("err", `Save failed: ${e instanceof Error ? e.message : e}`);
			}
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
		this.rl.close();
		process.stdout.write(C.reset + "\n");
		process.exit(0);
	}
}
