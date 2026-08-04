/**
 * pire-pi-tui.ts — Rich TUI built on Pi's actual TUI framework
 *
 * Uses @earendil-works/pi-tui: TuiMainScreen, ScrollView, VStack, HStack,
 * Text, Container, ProcessTerminal. Proper differential rendering,
 * component tree, and input handling from Pi's TUI library.
 *
 * Layout (TuiMainScreen — main screen with scrollback):
 *   ┌─────────────────────────────────────────┐
 *   │  HStack: [ToolSidebar | VStack]          │
 *   │    VStack: [ScrollView(transcript),      │
 *   │             StatusBar, InputLine]        │
 *   └─────────────────────────────────────────┘
 */

import {
	ProcessTerminal,
	TuiMainScreen,
	Container,
	Text,
	ScrollView,
	VStack,
	HStack,
	type Component,
} from "@earendil-works/pi-tui";
import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools } from "./index.js";
import { callLLM, toolToFunction, loadLLMConfig, type ChatMessage, type ToolCall, type LLMConfig } from "./llm.js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.85.0";

const BANNER = `
  ____  _ _____  _       
 |  _ \\(_) ____|| |      
 | |_) | | |  __| |____  
 |  __/| | | |_ |  _  _| 
 |_|   |_|______||_____|  v${VERSION}
`;

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	boldGreen: "\x1b[1;32m",
	boldCyan: "\x1b[1;36m",
	boldYellow: "\x1b[1;33m",
	boldRed: "\x1b[1;31m",
};

const MAX_TURNS = 40;
const MAX_OUTPUT = 16000;

// Strip ANSI for visible length
function visLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padRight(s: string, width: number): string {
	const len = visLen(s);
	if (len >= width) return s;
	return s + " ".repeat(width - len);
}

function trunc(s: string, max: number): string {
	const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.length <= max) return s;
	return plain.slice(0, max - 3) + "..." + C.reset;
}

function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		const words = rawLine.split(" ");
		let cur = "";
		for (const word of words) {
			if (visLen(cur + " " + word) > width && cur) {
				out.push(cur);
				cur = word;
			} else {
				cur = cur ? cur + " " + word : word;
			}
		}
		out.push(cur);
	}
	return out.length > 0 ? out : [""];
}

// ─── ToolSidebar ───────────────────────────────────────────────
class ToolSidebar implements Component {
	private status: Record<string, boolean> = {};
	private cached?: string[];
	private cachedW = -1;

	constructor() { this.refresh(); }

	refresh(): void {
		this.status = probeTools();
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached && this.cachedW === width) return this.cached;
		const lines: string[] = [];
		lines.push(padRight(`${C.boldCyan}Tools${C.reset}`, width));
		lines.push(padRight(`${C.gray}${"─".repeat(Math.min(width, 20))}${C.reset}`, width));
		lines.push("");
		for (const tool of RE_TOOLS) {
			const ok = this.status[tool.name] ?? false;
			const icon = ok ? `${C.green}✓${C.reset}` : `${C.gray}✗${C.reset}`;
			lines.push(padRight(`${icon} ${C.dim}${trunc(tool.name, width - 4)}${C.reset}`, width));
		}
		const avail = Object.values(this.status).filter(Boolean).length;
		const total = Object.keys(this.status).length;
		lines.push("");
		lines.push(padRight(`${C.gray}${avail}/${total} available${C.reset}`, width));
		this.cached = lines;
		this.cachedW = width;
		return lines;
	}

	invalidate(): void { this.cached = undefined; }
}

// ─── TranscriptView ────────────────────────────────────────────
class TranscriptView implements Component {
	private entries: { type: string; text: string; streaming?: boolean }[] = [];
	private cached?: string[];
	private cachedW = -1;

	add(type: string, text: string): void {
		this.entries.push({ type, text });
		this.cached = undefined;
	}

	updateLast(text: string): void {
		const last = this.entries[this.entries.length - 1];
		if (last) { last.text = text; this.cached = undefined; }
	}

	finalizeLast(): void {
		const last = this.entries[this.entries.length - 1];
		if (last) delete last.streaming;
	}

	clear(): void {
		this.entries = [];
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached && this.cachedW === width) return this.cached;
		const lines: string[] = [];
		for (const e of this.entries) {
			let prefix = "";
			let color = "";
			switch (e.type) {
				case "user":      prefix = `${C.boldCyan}you${C.reset} > `;    break;
				case "assistant": prefix = `${C.boldGreen}pire${C.reset} > `;  break;
				case "tool_call": prefix = `${C.boldYellow}⚙${C.reset} `;      color = C.yellow; break;
				case "tool_result": prefix = `${C.gray}↳${C.reset} `;          color = C.dim; break;
				case "system":    prefix = `${C.bold}system${C.reset} > `;     color = C.blue; break;
				case "error":     prefix = `${C.boldRed}error${C.reset} > `;   color = C.red; break;
			}
			const prefixLen = visLen(prefix.replace(/\x1b\[[0-9;]*m/g, ""));
			const wrapped = wrapText(e.text, width - prefixLen);
			for (let i = 0; i < wrapped.length; i++) {
				if (i === 0) lines.push(prefix + color + wrapped[i] + C.reset);
				else lines.push(" ".repeat(prefixLen) + color + wrapped[i] + C.reset);
			}
		}
		this.cached = lines;
		this.cachedW = width;
		return lines;
	}

	invalidate(): void { this.cached = undefined; }
}

// ─── StatusBar ─────────────────────────────────────────────────
class StatusBar implements Component {
	private target = "none";
	private model = "";
	private processing = false;
	private cached?: string[];
	private cachedW = -1;

	setTarget(t: string): void { this.target = t; this.cached = undefined; }
	setModel(m: string): void { this.model = m; this.cached = undefined; }
	setProcessing(p: boolean): void { this.processing = p; this.cached = undefined; }

	render(width: number): string[] {
		if (this.cached && this.cachedW === width) return this.cached;
		const left = `${C.dim}target:${C.reset} ${this.target}  ${C.dim}model:${C.reset} ${this.model || "default"}`;
		const right = this.processing ? `${C.boldYellow}⟳ working${C.reset}` : `${C.green}● ready${C.reset}`;
		const lLen = visLen(left.replace(/\x1b\[[0-9;]*m/g, ""));
		const rLen = visLen(right.replace(/\x1b\[[0-9;]*m/g, ""));
		const gap = Math.max(1, width - lLen - rLen);
		const border = `${C.gray}${"─".repeat(width)}${C.reset}`;
		this.cached = [border, left + " ".repeat(gap) + right];
		this.cachedW = width;
		return this.cached;
	}

	invalidate(): void { this.cached = undefined; }
}

// ─── InputLine ─────────────────────────────────────────────────
class InputLine implements Component {
	private buf = "";
	private prompt = `${C.boldCyan}>${C.reset} `;
	private cached?: string[];
	private cachedW = -1;

	get value(): string { return this.buf; }

	clear(): void { this.buf = ""; this.cached = undefined; }

	type(ch: string): void {
		this.buf += ch;
		this.cached = undefined;
	}

	backspace(): void {
		if (this.buf.length > 0) {
			this.buf = this.buf.slice(0, -1);
			this.cached = undefined;
		}
	}

	render(width: number): string[] {
		if (this.cached && this.cachedW === width) return this.cached;
		const promptLen = visLen(this.prompt.replace(/\x1b\[[0-9;]*m/g, ""));
		const availWidth = width - promptLen;
		let display = this.buf;
		if (visLen(display) > availWidth) {
			// Scroll horizontally: show last N chars
			const plain = display;
			display = plain.slice(Math.max(0, visLen(plain) - availWidth));
		}
		this.cached = [this.prompt + display];
		this.cachedW = width;
		return this.cached;
	}

	invalidate(): void { this.cached = undefined; }
}

// ─── PirePiTUI ─────────────────────────────────────────────────
export class PirePiTUI {
	private ui: TuiMainScreen;
	private terminal: ProcessTerminal;
	private transcript: TranscriptView;
	private sidebar: ToolSidebar;
	private statusBar: StatusBar;
	private inputLine: InputLine;
	private scrollView: ScrollView;
	private rightPanel: VStack;
	private layout: HStack;

	private messages: ChatMessage[] = [];
	private loadedTarget: string | null = null;
	private pendingUrl: string | null = null;
	private systemPrompt = RE_SYSTEM_PROMPT;
	private llm: LLMConfig | null;
	private processing = false;

	constructor(target?: string) {
		this.terminal = new ProcessTerminal();
		this.ui = new TuiMainScreen(this.terminal, true);

		this.transcript = new TranscriptView();
		this.sidebar = new ToolSidebar();
		this.statusBar = new StatusBar();
		this.inputLine = new InputLine();
		this.scrollView = new ScrollView(this.transcript, {
			follow: "end",
			primary: true,
			scrollbar: "auto",
		});

		this.llm = loadLLMConfig();

		if (target) {
			if (/^https?:\/\//.test(target)) {
				this.pendingUrl = target;
			} else {
				this.loadedTarget = target;
			}
			this.statusBar.setTarget(target);
		}
		if (this.llm?.model) this.statusBar.setModel(this.llm.model);

		this.transcript.add("system", BANNER);
		this.transcript.add("system", "Tell me what you need — load a binary with :load, or just describe what you're looking for.");
		this.transcript.add("system", "Type :help for commands, :quit to exit.");

		// Build layout: HStack [sidebar | VStack [scrollview, status, input]]
		this.rightPanel = new VStack([
			{ component: this.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 3 },
			{ component: this.statusBar, basis: "auto", grow: 0, shrink: 0 },
			{ component: this.inputLine, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		]);

		this.layout = new HStack([
			{ component: this.sidebar, basis: 22, grow: 0, shrink: 0, minSize: 15 },
			{ component: this.rightPanel, basis: 0, grow: 1, shrink: 1, minSize: 20 },
		]);

		// TuiMainScreen extends Container — use addChild for the root layout
		this.ui.addChild(this.layout);
		this.setupInput();
	}

	private setupInput(): void {
		this.ui.addInputListener((data: string) => {
			// Enter
			if (data === "\r" || data === "\n") {
				const value = this.inputLine.value;
				this.inputLine.clear();
				this.ui.requestRender();
				if (value.trim()) {
					void this.handleInput(value);
				}
				return { consume: true };
			}

			// Ctrl+C
			if (data === "\x03") {
				this.stop();
				process.exit(0);
			}

			// Ctrl+D
			if (data === "\x04") {
				this.stop();
				process.exit(0);
			}

			// Backspace
			if (data === "\x7f" || data === "\b") {
				this.inputLine.backspace();
				this.ui.requestRender();
				return { consume: true };
			}

			// Tab — ignore for now
			if (data === "\t") return { consume: true };

			// Escape — clear input
			if (data === "\x1b") {
				this.inputLine.clear();
				this.ui.requestRender();
				return { consume: true };
			}

			// Printable single char
			if (data.length === 1 && data >= " " && data <= "~") {
				this.inputLine.type(data);
				this.ui.requestRender();
				return { consume: true };
			}

			return { consume: true };
		});
	}

	private async handleInput(input: string): Promise<void> {
		if (this.processing) return;
		const trimmed = input.trim();

		if (trimmed.startsWith(":")) {
			await this.handleCommand(trimmed);
			return;
		}

		this.transcript.add("user", trimmed);
		this.messages.push({ role: "user", content: trimmed });
		this.ui.requestRender();
		await this.agentLoop();
	}

	private async handleCommand(cmd: string): Promise<void> {
		const parts = cmd.slice(1).split(" ");
		const command = parts[0];
		const arg = parts.slice(1).join(" ");

		switch (command) {
			case "help":
				this.transcript.add("system", [
					"Commands:",
					"  :load <path|URL>  Load a target binary or URL",
					"  :tools            List all RE tools",
					"  :probe            Re-probe system for tools",
					"  :skills           List available skills",
					"  :save [path]      Save conversation history",
					"  :clear            Clear transcript",
					"  :quit             Exit pire",
					"",
					"Just type naturally — I'll run tools as needed.",
				].join("\n"));
				break;

			case "load":
				if (!arg) {
					this.transcript.add("error", "Usage: :load <path|URL>");
				} else if (/^https?:\/\//.test(arg)) {
					this.pendingUrl = arg;
					this.statusBar.setTarget(arg);
					this.transcript.add("system", `Will download from ${arg} on next message.`);
				} else {
					if (!existsSync(arg)) {
						this.transcript.add("error", `File not found: ${arg}`);
					} else {
						this.loadedTarget = arg;
						this.statusBar.setTarget(basename(arg));
						this.transcript.add("system", `Loaded: ${arg}`);
					}
				}
				break;

			case "tools":
				this.transcript.add("system", RE_TOOLS.map((t) => `  ${t.name.padEnd(20)} ${t.description.split(".")[0]}`).join("\n"));
				break;

			case "probe":
				this.transcript.add("system", "Probing system for tools...");
				this.sidebar.refresh();
				const status = probeTools();
				const avail = Object.values(status).filter(Boolean).length;
				const total = Object.keys(status).length;
				this.transcript.add("system", `${avail}/${total} tools available`);
				break;

			case "skills":
				try {
					const skillsDir = join(__dirname, "..", "..", "..", "skills");
					const skills = readdirSync(skillsDir, { withFileTypes: true })
						.filter((d) => d.isDirectory())
						.map((d) => d.name);
					this.transcript.add("system", skills.map((s) => `  ${s}`).join("\n"));
				} catch {
					this.transcript.add("error", "No skills directory found");
				}
				break;

			case "save": {
				const savePath = arg || `/tmp/pire-session-${Date.now()}.txt`;
				const content = this.messages
					.map((m) => `[${m.role}]\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
					.join("\n\n");
				writeFileSync(savePath, content);
				this.transcript.add("system", `Saved to ${savePath}`);
				break;
			}

			case "clear":
				this.transcript.clear();
				this.messages = [];
				this.transcript.add("system", BANNER);
				this.transcript.add("system", "Transcript cleared.");
				break;

			case "quit":
			case "exit":
				this.stop();
				process.exit(0);

			default:
				this.transcript.add("error", `Unknown command: :${command}. Type :help for available commands.`);
		}
		this.ui.requestRender();
	}

	private async agentLoop(): Promise<void> {
		if (!this.llm) {
			this.transcript.add("error", "No LLM config found. Set OPENAI_API_KEY + OPENAI_BASE_URL or create ~/.pire/config.yaml");
			this.ui.requestRender();
			return;
		}

		this.processing = true;
		this.statusBar.setProcessing(true);
		this.ui.requestRender();

		try {
			// Handle pending URL download
			if (this.pendingUrl) {
				const url = this.pendingUrl;
				this.pendingUrl = null;
				const { fetchTool } = await import("./index.js");
				const result = await fetchTool.execute("pire", { url });
				const path = result.content[0]?.text ?? "";
				if (path.startsWith("Error") || !path) {
					this.transcript.add("error", path || "Download failed");
				} else {
					this.loadedTarget = path;
					this.transcript.add("system", `Downloaded to: ${path}`);
					this.statusBar.setTarget(basename(path));
					this.messages.push({ role: "user", content: `I've loaded ${url} (downloaded to ${path}). Please analyze it.` });
				}
			}

			let systemPrompt = this.systemPrompt;
			if (this.loadedTarget) {
				systemPrompt += `\n\nThe user has loaded: ${this.loadedTarget}`;
			}

			const toolSchemas = RE_TOOLS.map((t) => toolToFunction(t));

			for (let turn = 0; turn < MAX_TURNS; turn++) {
				this.statusBar.setTarget(`turn ${turn + 1}/${MAX_TURNS}`);
				this.ui.requestRender();

				let assistantContent = "";
				const toolCalls: ToolCall[] = [];

				const resp = await callLLM(this.llm, [{ role: "system", content: systemPrompt }, ...this.messages], toolSchemas, {
					onContent: (chunk: string) => {
						assistantContent += chunk;
						const last = (this.transcript as any).entries?.[(this.transcript as any).entries.length - 1];
						if (last && last.type === "assistant" && last.streaming) {
							this.transcript.updateLast(assistantContent);
						} else {
							this.transcript.add("assistant", assistantContent);
							(this.transcript as any).entries[(this.transcript as any).entries.length - 1].streaming = true;
						}
						this.ui.requestRender();
					},
				});

				this.transcript.finalizeLast();

				if (!resp.tool_calls || resp.tool_calls.length === 0) {
					this.messages.push({ role: "assistant", content: resp.content ?? assistantContent });
					break;
				}

				// Collect tool calls accumulated during streaming
				const allToolCalls = resp.tool_calls;
				this.messages.push({
					role: "assistant",
					content: resp.content ?? assistantContent,
					tool_calls: allToolCalls,
				});

				for (const tc of allToolCalls) {
					const tool = RE_TOOLS.find((t) => t.name === tc.function.name);
					if (!tool) {
						this.transcript.add("error", `Unknown tool: ${tc.function.name}`);
						this.messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: unknown tool ${tc.function.name}` });
						continue;
					}

					let args: any;
					try {
						args = JSON.parse(tc.function.arguments);
					} catch { args = {}; }

					if (this.loadedTarget && !args.target && !args.binary && !args.path && !args.file) {
						args.target = this.loadedTarget;
					}

					this.transcript.add("tool_call", `${tc.function.name}(${tc.function.arguments})`);
					this.ui.requestRender();

					let resultText: string;
					try {
						const result = await tool.execute("pire", args);
						resultText = result.content[0]?.text ?? JSON.stringify(result);
					} catch (e: any) {
						resultText = `Error: ${e.message}`;
					}

					if (resultText.length > MAX_OUTPUT) {
						resultText = resultText.slice(0, MAX_OUTPUT) + "\n... (truncated)";
					}

					this.transcript.add("tool_result", resultText.slice(0, 200) + (resultText.length > 200 ? "..." : ""));
					this.ui.requestRender();

					this.messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
				}
			}

			this.statusBar.setTarget(this.loadedTarget ? basename(this.loadedTarget) : "none");
		} catch (e: any) {
			this.transcript.add("error", e.message);
		} finally {
			this.processing = false;
			this.statusBar.setProcessing(false);
			this.ui.requestRender();
		}
	}

	start(): void {
		this.ui.start();
		const cleanup = () => { this.stop(); process.exit(0); };
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
	}

	stop(): void {
		this.ui.stop();
	}
}
