/**
 * pire TUI — Rich split-pane RE agent dashboard
 *
 * Layout:
 *  ┌──────────────────────────────────────────────────┐
 *  │ pire v0.86.2  │  target: /bin/ls  │  22 tools  │
 *  ├──────────────┬───────────────────────────────────┤
 *  │ Tools        │  Chat / Output                    │
 *  │ ✓ strings    │                                   │
 *  │ ✓ filetype   │  ⚙ filetype(/bin/ls)              │
 *  │ ✓ r2         │  ELF 64-bit LSB shared object     │
 *  │ ✗ binwalk    │                                   │
 *  │ ✓ capstone   │  > analyze this binary            │
 *  │              │  Based on the ELF header...       │
 *  │              │                                   │
 *  ├──────────────┴───────────────────────────────────┤
 *  │ > analyze /bin/ls                               │
 *  └──────────────────────────────────────────────────┘
 *
 * Commands:
 *  :load <path|URL> — Load a target into context
 *  :tools           — List all tools
 *  :probe           — Probe system
 *  :skills          — List skills
 *  :save [path]     — Save conversation history
 *  :clear           — Clear output
 *  :help            — Show commands
 *  :quit            — Exit
 */

import * as readline from "node:readline";
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools, fetchTool, type AgentTool } from "./index.js";
import { loadLLMConfig, toolToFunction, callLLM, type ChatMessage } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.86.2";

// ANSI
const C = {
	reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
	red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
	blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
	bg: "\x1b[48;5;236m",
	clear: "\x1b[2J\x1b[H",
	clearLine: "\x1b[2K",
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
};

// ─── Double Ctrl+C to quit ─────────────────────────────────────
function setupGracefulQuit(onQuit: () => void, onFirstPress?: () => void): void {
	let pressed = false;
	let timer: NodeJS.Timeout | undefined;

	process.on("SIGINT", () => {
		if (pressed) {
			if (timer) clearTimeout(timer);
			onQuit();
			process.exit(0);
		}
		pressed = true;
		onFirstPress?.();
		timer = setTimeout(() => { pressed = false; }, 15000);
	});

	process.on("SIGTERM", () => {
		if (timer) clearTimeout(timer);
		onQuit();
		process.exit(0);
	});
}

interface OutputLine { text: string; kind: "cmd" | "out" | "err" | "info" | "tool" | "chat" | "stream" }

// ─── TUI ───────────────────────────────────────────────────────

export class PireTUI {
	private rl: readline.Interface;
	private llm = loadLLMConfig();
	private tools: Record<string, boolean> = {};
	private messages: ChatMessage[] = [];
	private toolMap: Map<string, AgentTool<any>> = new Map();
	private loadedTarget: string | null = null;
	private pendingUrl: string | null = null;
	private output: OutputLine[] = [];
	private input = "";
	private processing = false;
	private inputQueue: string[] = [];
	private scrollOffset = 0;
	private isActive = false;

	constructor(target?: string) {
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		if (target) {
			if (/^https?:\/\//i.test(target)) {
				this.pendingUrl = target;
			} else {
				this.loadedTarget = target;
			}
		}
	}

	async start() {
		this.isActive = true;
		this.push("info", `       ,--.               `);
		this.push("info", ` ,---. '--',--.--. ,---.  `);
		this.push("info", `| .-. |,--.|  .--'| .-. : `);
		this.push("info", `| '-' '|  ||  |   \\   --. `);
		this.push("info", `|  |-' '--'--'    '----'  v${VERSION}`);
		this.push("info", `'--'                      `);
		this.push("info", ``);
		this.push("info", `Tell me what you need. I'll run the tools myself.`);

		if (this.llm) {
			this.push("info", `LLM: ${this.llm.model}`);
		} else {
			this.push("err", "No LLM config. Run: pire model");
		}

		this.push("info", "Probing system...");
		this.tools = probeTools();
		const avail = Object.values(this.tools).filter(Boolean).length;
		this.push("info", `${avail}/${Object.keys(this.tools).length} tools available`);

		for (const tool of RE_TOOLS) this.toolMap.set(tool.name, tool);

		// Handle pending URL download
		if (this.pendingUrl) {
			this.render();
			this.push("info", `Downloading from ${this.pendingUrl}...`);
			this.render();
			const fetchResult = await fetchTool.execute("pire", { url: this.pendingUrl });
			const text = fetchResult.content.map((c: { text: string }) => c.text).join("\n");
			this.push("tool", `fetch(${this.pendingUrl})`);
			const pathMatch = text.match(/Downloaded to: (.+)/);
			const localPath = pathMatch?.[1] || fetchResult.details?.path as string;
			if (localPath && existsSync(localPath)) {
				this.loadedTarget = localPath;
				this.push("info", `Loaded: ${localPath}`);
			} else {
				this.push("err", `Download failed: ${text}`);
			}
			this.pendingUrl = null;
		}

		if (this.loadedTarget) {
			this.push("info", `Target loaded: ${this.loadedTarget}`);
		}

		this.render();
		this.rl.setPrompt("");
		this.rl.on("line", (line) => { this.inputQueue.push(line); this.processQueue(); });
		this.rl.on("close", () => { /* don't exit while processing */ });

		// Handle raw keypresses for scrollback
		if (process.stdin.isTTY) {
			process.stdin.on("data", (data: Buffer) => {
				// Page Up / Page Down for scrolling
				if (data.length === 3 && data[0] === 0x1b && data[1] === 0x5b) {
					if (data[2] === 0x35) { // Page Up
						this.scrollOffset = Math.min(this.scrollOffset + 10, this.output.length);
						this.render();
					} else if (data[2] === 0x36) { // Page Down
						this.scrollOffset = Math.max(this.scrollOffset - 10, 0);
						this.render();
					}
				}
			});
		}

		// Double Ctrl+C to quit
		setupGracefulQuit(
			() => { this.isActive = false; this.rl.close(); process.stdout.write(C.showCursor + C.reset + "\n"); },
			() => { this.push("info", `${C.yellow}${C.bold}Press Ctrl+C again to quit.${C.reset}`); this.render(); },
		);
	}

	private async processQueue() {
		if (this.processing) return;
		this.processing = true;
		while (this.inputQueue.length > 0) {
			const line = this.inputQueue.shift()!;
			this.input = "";
			await this.handleInput(line);
		}
		this.processing = false;
	}

	// ─── Agent loop: call LLM, execute tools, repeat ──────────

	private async agentLoop(userMessage: string) {
		if (!this.llm) {
			this.push("err", "No LLM configured.");
			this.render();
			return;
		}

		const availTools = Object.entries(this.tools).filter(([,v]) => v).map(([k]) => k).join(", ");
		const targetInfo = this.loadedTarget ? `\n\nCurrently loaded target: ${this.loadedTarget}` : "";
		const systemPrompt = `${RE_SYSTEM_PROMPT}

You have ${RE_TOOLS.length} tools available. Available on this system: ${availTools}.${targetInfo}

When the user mentions a path, binary, or directory — run tools on it yourself. Don't ask them to type commands.
When the user provides a URL — use the fetch tool to download it first.
Pick the right tools for whatever the user is asking for. Don't follow a fixed workflow — adapt to the task.`;

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
					onContent: (chunk) => {
						// Stream content directly to output
						this.push("stream", chunk);
						this.render();
					},
				});
			} catch (e) {
				this.push("err", `LLM error: ${e instanceof Error ? e.message : e}`);
				this.render();
				return;
			}

			// Newline after streaming content
			if (resp.content) this.push("out", "");

			if (resp.tool_calls && resp.tool_calls.length > 0) {
				for (const tc of resp.tool_calls) {
					let args: Record<string, unknown> = {};
					try { args = JSON.parse(tc.function.arguments); } catch {}
					const argStr = Object.entries(args).map(([k,v]) => {
						const val = String(v);
						return val.length > 100 ? `${k}=${val.slice(0,100)}...` : `${k}=${val}`;
					}).join(" ");
					this.push("tool", `${tc.function.name}(${argStr})`);
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

					this.render();
					try {
						const result = await tool.execute("pire", params);
						const text = result.content.map((c: { text: string }) => c.text).join("\n");
						const truncated = text.length > 16000 ? text.slice(0, 16000) + "\n... (truncated)" : text;
						messages.push({ role: "tool", tool_call_id: tc.id, content: truncated });
						// Show tool output (truncated for display)
						const displayText = text.length > 2000 ? text.slice(0, 2000) + "\n... (truncated, full output sent to LLM)" : text;
						this.push("out", displayText);
					} catch (e) {
						messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${e instanceof Error ? e.message : e}` });
						this.push("err", String(e instanceof Error ? e.message : e));
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

		if (cmd === ":quit" || cmd === ":q" || cmd === "exit" || cmd === "quit" || cmd === "q") { this.stop(); return; }

		if (cmd === ":help" || cmd === ":h") {
			this.push("info", "Just type naturally — I'll run tools as needed.");
			this.push("info", "Examples:");
			this.push("info", "  analyze /bin/ls");
			this.push("info", "  decompile the main function in ./crackme");
			this.push("info", "  extract strings from app.exe and find URLs");
			this.push("info", "  what's the entropy of this firmware?");
			this.push("info", "  download and check https://example.com/app.apk");
			this.push("info", "");
			this.push("info", "Commands: :load <path|URL> :tools :probe :skills :save :clear :help :quit");
			this.push("info", "PgUp/PgDn to scroll output");
			this.render();
			return;
		}

		if (cmd === ":clear") {
			this.output = [];
			this.scrollOffset = 0;
			this.render();
			return;
		}

		if (cmd === ":tools") {
			for (const tool of RE_TOOLS) this.push("info", `  ${tool.name.padEnd(20)} ${tool.description.split(".")[0]}`);
			this.push("info", `${RE_TOOLS.length} tools registered`);
			this.render();
			return;
		}

		if (cmd === ":probe") {
			this.tools = probeTools();
			for (const [name, avail] of Object.entries(this.tools)) this.push("info", `  ${avail ? "✓" : "✗"} ${name}`);
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
						this.push("info", `  ${s.name.padEnd(40)} ${m?.[1]?.trim() ?? ""}`);
					} catch {}
				}
				this.push("info", `${skills.length} skills`);
			} catch { this.push("err", "Skills directory not found"); }
			this.render();
			return;
		}

		if (cmd.startsWith(":load")) {
			const path = cmd.slice(5).trim();
			if (!path) {
				this.push("err", "Usage: :load <path or URL>");
				this.render();
				return;
			}
			if (/^https?:\/\//i.test(path)) {
				this.push("info", `Downloading from ${path}...`);
				this.render();
				const fetchResult = await fetchTool.execute("pire", { url: path });
				const text = fetchResult.content.map((c: { text: string }) => c.text).join("\n");
				this.push("tool", `fetch(${path})`);
				const pathMatch = text.match(/Downloaded to: (.+)/);
				const localPath = pathMatch?.[1] || fetchResult.details?.path as string;
				if (localPath && existsSync(localPath)) {
					this.loadedTarget = localPath;
					this.push("info", `Loaded: ${localPath}`);
				} else {
					this.push("err", `Download failed: ${text}`);
				}
				this.render();
				return;
			}
			if (!existsSync(path)) {
				this.push("err", `Not found: ${path}`);
				this.render();
				return;
			}
			this.loadedTarget = path;
			this.push("info", `Loaded: ${path}`);
			this.render();
			return;
		}

		if (cmd.startsWith(":save")) {
			const savePath = cmd.slice(4).trim() || join(process.cwd(), `pire-session-${Date.now()}.json`);
			try {
				const data = JSON.stringify({ version: VERSION, target: this.loadedTarget, messages: this.messages }, null, 2);
				mkdirSync(dirname(savePath), { recursive: true });
				writeFileSync(savePath, data);
				this.push("info", `Saved ${this.messages.length} messages to ${savePath}`);
			} catch (e) {
				this.push("err", `Save failed: ${e instanceof Error ? e.message : e}`);
			}
			this.render();
			return;
		}

		// Everything else → agent loop
		this.push("chat", cmd);
		this.render();
		await this.agentLoop(cmd);
	}

	// ─── Output buffer ────────────────────────────────────────

	private push(kind: OutputLine["kind"], text: string) {
		for (const line of text.split("\n")) {
			this.output.push({ text: line, kind });
		}
		if (this.output.length > 1000) this.output = this.output.slice(-1000);
		this.scrollOffset = 0;
	}

	// ─── Render ───────────────────────────────────────────────

	private render() {
		if (!this.isActive) return;

		const w = Math.min(process.stdout.columns || 80, 120);
		const h = process.stdout.rows || 24;
		const lines: string[] = [];

		// ─── Header bar ───
		const targetStr = this.loadedTarget ? `target: ${this.loadedTarget}` : "no target";
		const toolCount = `${RE_TOOLS.length} tools`;
		const headerLeft = `${C.bold}pire v${VERSION}${C.reset}`;
		const headerMid = `${C.dim}${targetStr}${C.reset}`;
		const headerRight = `${C.dim}${toolCount}${C.reset}`;
		const padLen = Math.max(0, w - targetStr.length - toolCount.length - 12);
		lines.push(`${headerLeft}  ${C.gray}${"─".repeat(Math.floor(padLen / 2))}${C.reset}  ${headerMid}  ${C.gray}${"─".repeat(Math.ceil(padLen / 2))}${C.reset}  ${headerRight}`);

		// ─── Tools sidebar (left column, 20 chars wide) ───
		const toolLines: string[] = [];
		toolLines.push(`${C.bold}${C.dim}Tools${C.reset}`);
		for (const [name, avail] of Object.entries(this.tools)) {
			const mark = avail ? `${C.green}✓${C.reset}` : `${C.gray}✗${C.reset}`;
			const nameStr = avail ? name : `${C.gray}${name}${C.reset}`;
			toolLines.push(` ${mark} ${nameStr}`);
		}

		// ─── Output area (right column) ───
		const outputLines: string[] = [];
		const bodyHeight = h - 3; // header + input + border
		const leftWidth = 20;

		// Calculate visible output lines (accounting for wrapping)
		const outputWidth = w - leftWidth - 2;
		const wrappedOutput: { text: string; kind: string }[] = [];
		for (const line of this.output) {
			const prefix = {
				cmd: `${C.cyan}» ${C.reset}`,
				out: `${C.dim}  ${C.reset}`,
				err: `${C.red}! ${C.reset}`,
				info: `${C.blue}• ${C.reset}`,
				tool: `${C.green}⚙ ${C.reset}`,
				chat: `${C.bold}> ${C.reset}`,
				stream: ``,
			}[line.kind] || "";
			const wrapped = this.wrap(prefix + line.text, outputWidth);
			for (const wLine of wrapped) {
				wrappedOutput.push({ text: wLine, kind: line.kind });
			}
		}

		// Apply scroll offset
		const visibleCount = bodyHeight;
		let startIdx = 0;
		if (this.scrollOffset > 0) {
			startIdx = Math.max(0, wrappedOutput.length - visibleCount - this.scrollOffset);
		} else {
			startIdx = Math.max(0, wrappedOutput.length - visibleCount);
		}
		const visibleOutput = wrappedOutput.slice(startIdx, startIdx + visibleCount);

		for (let i = 0; i < bodyHeight; i++) {
			const left = (toolLines[i] ?? "").padEnd(leftWidth).slice(0, leftWidth);
			const right = visibleOutput[i]?.text ?? "";
			lines.push(`${left}${C.gray}│${C.reset} ${right}`);
		}

		// ─── Input line ───
		lines.push(`${C.gray}${"─".repeat(w)}${C.reset}`);
		const inputPrompt = this.processing ? `${C.yellow}⟳${C.reset} ` : `${C.bold}> ${C.reset}`;
		lines.push(`${inputPrompt}${this.input}${C.dim}█${C.reset}`);

		// ─── Render ───
		process.stdout.write(C.clear);
		process.stdout.write(lines.join("\n"));
		process.stdout.write(`\r`);
	}

	private wrap(text: string, width: number): string[] {
		const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
		if (stripped.length <= width) return [text];
		const lines: string[] = [];
		let current = text;
		while (current) {
			const strippedCurrent = current.replace(/\x1b\[[0-9;]*m/g, "");
			if (strippedCurrent.length <= width) { lines.push(current); break; }
			let breakAt = width;
			const spaceIdx = strippedCurrent.lastIndexOf(" ", width);
			if (spaceIdx > 0) breakAt = spaceIdx;
			lines.push(current.slice(0, breakAt));
			current = current.slice(breakAt).trimStart();
		}
		return lines;
	}

	stop() {
		this.isActive = false;
		this.rl.close();
		process.stdout.write(C.showCursor + C.reset);
		process.stdout.write("\n");
		process.exit(0);
	}
}

// ─── CLI mode (plain readline, no dashboard) ───────────────────

export class PireCLI {
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
			}
		}
	}

	async start() {
		console.log("       ,--.               ");
		console.log(" ,---. '--',--.--. ,---.  ");
		console.log("| .-. |,--.|  .--'| .-. : ");
		console.log("| '-' '|  ||  |   \\   --. ");
		console.log("|  |-' '--'--'    '----'  v" + VERSION);
		console.log("'--'                      ");
		console.log("");
		console.log("Tell me what you need. I'll run the tools myself.");

		if (this.llm) {
			console.log(`LLM: ${this.llm.model}`);
		} else {
			console.error(`No LLM config. Run: pire model`);
		}

		console.log(`Probing system...`);
		this.tools = probeTools();
		const avail = Object.values(this.tools).filter(Boolean).length;
		console.log(`${avail}/${Object.keys(this.tools).length} tools available`);

		for (const tool of RE_TOOLS) this.toolMap.set(tool.name, tool);

		if (this.pendingUrl) {
			console.log(`Downloading from ${this.pendingUrl}...`);
			const fetchResult = await fetchTool.execute("pire", { url: this.pendingUrl });
			const text = fetchResult.content.map((c: { text: string }) => c.text).join("\n");
			console.log(`⚙ fetch(${this.pendingUrl})`);
			const pathMatch = text.match(/Downloaded to: (.+)/);
			const localPath = pathMatch?.[1] || fetchResult.details?.path as string;
			if (localPath && existsSync(localPath)) {
				this.loadedTarget = localPath;
				console.log(`Loaded: ${localPath}`);
			} else {
				console.error(`Download failed: ${text}`);
			}
			this.pendingUrl = null;
		}

		if (this.loadedTarget) {
			console.log(`Target loaded: ${this.loadedTarget}`);
		}

		this.rl.setPrompt("pire > ");
		this.rl.prompt();
		this.rl.on("line", (line) => { this.inputQueue.push(line); this.processQueue(); });
		this.rl.on("close", () => { /* don't exit while processing */ });

		// Double Ctrl+C to quit
		setupGracefulQuit(
			() => { this.rl.close(); process.stdout.write("\n"); },
			() => { process.stdout.write(`\n${C.yellow}${C.bold}Press Ctrl+C again to quit.${C.reset}\n`); this.rl.prompt(); },
		);
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

	private async agentLoop(userMessage: string) {
		if (!this.llm) {
			console.error("No LLM configured.");
			return;
		}

		const availTools = Object.entries(this.tools).filter(([,v]) => v).map(([k]) => k).join(", ");
		const targetInfo = this.loadedTarget ? `\n\nCurrently loaded target: ${this.loadedTarget}` : "";
		const systemPrompt = `${RE_SYSTEM_PROMPT}

You have ${RE_TOOLS.length} tools available. Available on this system: ${availTools}.${targetInfo}

When the user mentions a path, binary, or directory — run tools on it yourself. Don't ask them to type commands.
When the user provides a URL — use the fetch tool to download it first.
Pick the right tools for whatever the user is asking for. Don't follow a fixed workflow — adapt to the task.`;

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
				console.error(`LLM error: ${e instanceof Error ? e.message : e}`);
				return;
			}

			if (resp.content) process.stdout.write("\n");

			if (resp.tool_calls && resp.tool_calls.length > 0) {
				for (const tc of resp.tool_calls) {
					let args: Record<string, unknown> = {};
					try { args = JSON.parse(tc.function.arguments); } catch {}
					const argStr = Object.entries(args).map(([k,v]) => {
						const val = String(v);
						return val.length > 100 ? `${k}=${val.slice(0,100)}...` : `${k}=${val}`;
					}).join(" ");
					console.log(`⚙ ${tc.function.name}(${argStr})`);
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
				continue;
			}

			if (resp.content) {
				this.messages.push({ role: "assistant", content: resp.content });
			}
			break;
		}

		this.rl.prompt();
	}

	private async handleInput(line: string) {
		const cmd = line.trim();
		if (!cmd) { this.rl.prompt(); return; }

		if (cmd === ":quit" || cmd === ":q" || cmd === "exit" || cmd === "quit" || cmd === "q") { this.stop(); return; }

		if (cmd === ":help" || cmd === ":h") {
			console.log("Just type naturally — I'll run tools as needed.");
			console.log("Examples:");
			console.log("  analyze /bin/ls");
			console.log("  decompile the main function in ./crackme");
			console.log("  extract strings from app.exe and find URLs");
			console.log("  what's the entropy of this firmware?");
			console.log("  download and check https://example.com/app.apk");
			console.log("");
			console.log("Commands: :load <path|URL> :tools :probe :skills :save [path] :help :quit");
			this.rl.prompt();
			return;
		}

		if (cmd === ":tools") {
			for (const tool of RE_TOOLS) console.log(`  ${tool.name.padEnd(20)} ${tool.description.split(".")[0]}`);
			console.log(`${RE_TOOLS.length} tools registered`);
			this.rl.prompt();
			return;
		}

		if (cmd === ":probe") {
			this.tools = probeTools();
			for (const [name, avail] of Object.entries(this.tools)) console.log(`  ${avail ? "✓" : "✗"} ${name}`);
			this.rl.prompt();
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
						console.log(`  ${s.name.padEnd(40)} ${m?.[1]?.trim() ?? ""}`);
					} catch {}
				}
				console.log(`${skills.length} skills`);
			} catch { console.error("Skills directory not found"); }
			this.rl.prompt();
			return;
		}

		if (cmd.startsWith(":load")) {
			const path = cmd.slice(5).trim();
			if (!path) {
				console.error("Usage: :load <path or URL>");
				this.rl.prompt();
				return;
			}
			if (/^https?:\/\//i.test(path)) {
				console.log(`Downloading from ${path}...`);
				const fetchResult = await fetchTool.execute("pire", { url: path });
				const text = fetchResult.content.map((c: { text: string }) => c.text).join("\n");
				console.log(`⚙ fetch(${path})`);
				const pathMatch = text.match(/Downloaded to: (.+)/);
				const localPath = pathMatch?.[1] || fetchResult.details?.path as string;
				if (localPath && existsSync(localPath)) {
					this.loadedTarget = localPath;
					console.log(`Loaded: ${localPath}`);
				} else {
					console.error(`Download failed: ${text}`);
				}
				this.rl.prompt();
				return;
			}
			if (!existsSync(path)) {
				console.error(`Not found: ${path}`);
				this.rl.prompt();
				return;
			}
			this.loadedTarget = path;
			console.log(`Loaded: ${path}`);
			this.rl.prompt();
			return;
		}

		if (cmd.startsWith(":save")) {
			const savePath = cmd.slice(4).trim() || join(process.cwd(), `pire-session-${Date.now()}.json`);
			try {
				const data = JSON.stringify({ version: VERSION, target: this.loadedTarget, messages: this.messages }, null, 2);
				mkdirSync(dirname(savePath), { recursive: true });
				writeFileSync(savePath, data);
				console.log(`Saved ${this.messages.length} messages to ${savePath}`);
			} catch (e) {
				console.error(`Save failed: ${e instanceof Error ? e.message : e}`);
			}
			this.rl.prompt();
			return;
		}

		// Everything else → agent loop
		console.log(`> ${cmd}`);
		await this.agentLoop(cmd);
	}

	stop() {
		this.rl.close();
		process.exit(0);
	}
}
