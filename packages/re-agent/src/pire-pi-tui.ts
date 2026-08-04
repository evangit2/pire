/**
 * pire-pi-tui.ts — Rich TUI built on Pi's actual TUI framework
 *
 * Uses @earendil-works/pi-tui components: TuiMainScreen, Container,
 * ScrollView, VStack, HStack, Box, Text, Spacer, Input, Markdown.
 * Proper differential rendering, component tree, focus management,
 * and input handling from Pi's TUI library.
 *
 * Layout (TuiMainScreen — main screen with scrollback):
 *   ┌──────────────────────────────────────────┐
 *   │  Container (vertical stack)               │
 *   │    Box(padding=1) → sidebar title         │
 *   │    HStack: [sidebar | chatContainer]      │
 *   │      sidebar: Box → tool list             │
 *   │      chatContainer:                        │
 *   │        ScrollView(transcript)             │
 *   │        DynamicBorder (separator)          │
 *   │        Box → status bar                    │
 *   │        Input (focused)                     │
 *   └──────────────────────────────────────────┘
 */

import {
	ProcessTerminal,
	TuiMainScreen,
	Container,
	Text,
	Box,
	Spacer,
	ScrollView,
	VStack,
	HStack,
	Input,
	visibleWidth,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools } from "./index.js";
import { callLLM, toolToFunction, loadLLMConfig, type ChatMessage, type ToolCall, type LLMConfig } from "./llm.js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.85.0";

// Use chalk for proper Pi-style colors
import chalk from "chalk";

const BANNER = `
  ____  _ _____  _       
 |  _ \\(_) ____|| |      
 | |_) | | |  __| |____  
 |  __/| | | |_ |  _  _| 
 |_|   |_|______||_____|  v${VERSION}
`;

const MAX_TURNS = 40;
const MAX_OUTPUT = 16000;

// ─── DynamicBorder (inline, like Pi's coding-agent) ────────────
class DynamicBorder implements Component {
	private colorFn: (s: string) => string;

	constructor(colorFn: (s: string) => string = chalk.dim) {
		this.colorFn = colorFn;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.colorFn("─".repeat(Math.max(1, width)))];
	}
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
		lines.push(chalk.bold.cyan("Tools"));
		lines.push(chalk.dim("─".repeat(Math.min(width, 20))));
		lines.push("");
		for (const tool of RE_TOOLS) {
			const ok = this.status[tool.name] ?? false;
			const icon = ok ? chalk.green("✓") : chalk.gray("✗");
			const name = truncateToWidth(tool.name, width - 4);
			lines.push(`${icon} ${chalk.dim(name)}`);
		}
		const avail = Object.values(this.status).filter(Boolean).length;
		const total = RE_TOOLS.length;
		lines.push("");
		lines.push(chalk.dim(`${avail}/${total} available`));
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
			let color = (s: string) => s;
			switch (e.type) {
				case "user":      prefix = `${chalk.bold.cyan("you")} > `;    break;
				case "assistant": prefix = `${chalk.bold.green("pire")} > `;  break;
				case "tool_call": prefix = `${chalk.bold.yellow("⚙")} `;      color = chalk.yellow; break;
				case "tool_result": prefix = `${chalk.dim("↳")} `;            color = chalk.dim; break;
				case "system":    prefix = `${chalk.bold("system")} > `;      color = chalk.blue; break;
				case "error":     prefix = `${chalk.bold.red("error")} > `;   color = chalk.red; break;
			}
			const prefixLen = visibleWidth(prefix);
			// Simple word-wrap that preserves ANSI
			for (const rawLine of e.text.split("\n")) {
				const words = rawLine.split(" ");
				let cur = "";
				for (const word of words) {
					if (visibleWidth(cur + " " + word) > width - prefixLen && cur) {
						lines.push(prefix + color(cur));
						cur = word;
					} else {
						cur = cur ? cur + " " + word : word;
					}
				}
				lines.push(prefix + color(cur));
				// Continuation lines use spaces
				prefix = " ".repeat(prefixLen);
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
		const left = `${chalk.dim("target:")} ${this.target}  ${chalk.dim("model:")} ${this.model || "default"}`;
		const right = this.processing ? chalk.bold.yellow("⟳ working") : chalk.green("● ready");
		const lLen = visibleWidth(left);
		const rLen = visibleWidth(right);
		const gap = Math.max(1, width - lLen - rLen);
		this.cached = [left + " ".repeat(gap) + right];
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
	private input: Input;
	private scrollView: ScrollView;
	private rootContainer: Container;
	private chatContainer: Container;

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

		// Use Pi's Input component with onSubmit
		this.input = new Input();
		this.input.onSubmit = (value: string) => {
			if (value.trim() && !this.processing) {
				void this.handleInput(value);
			}
		};

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

		// Initial transcript content
		this.transcript.add("system", BANNER);
		this.transcript.add("system", "Tell me what you need — load a binary with :load, or just describe what you're looking for.");
		this.transcript.add("system", "Type :help for commands, :quit to exit.");

		// Build layout using Pi components
		// ScrollView wraps the transcript
		this.scrollView = new ScrollView(this.transcript, {
			follow: "end",
			primary: true,
			scrollbar: "auto",
		});

		// Chat container: scrollview + border + status + input
		this.chatContainer = new Container();
		this.chatContainer.addChild(this.scrollView);
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Box(1, 0, (s: string) => chalk.dim(s)));
		// Box wraps status bar with padding
		const statusBox = new Box(1, 0);
		statusBox.addChild(this.statusBar);
		this.chatContainer.addChild(statusBox);
		this.chatContainer.addChild(this.input);

		// HStack: sidebar | chat
		const sidebarBox = new Box(1, 1);
		sidebarBox.addChild(this.sidebar);
		const sidebarVStack = new VStack([
			{ component: sidebarBox, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
		]);
		const chatVStack = new VStack([
			{ component: this.chatContainer, basis: 0, grow: 1, shrink: 1, minSize: 10 },
		]);
		const mainHStack = new HStack([
			{ component: sidebarVStack, basis: 24, grow: 0, shrink: 0, minSize: 15 },
			{ component: chatVStack, basis: 0, grow: 1, shrink: 1, minSize: 20 },
		]);

		// Root container
		this.rootContainer = new Container();
		this.rootContainer.addChild(mainHStack);

		this.ui.addChild(this.rootContainer);

		// Focus the input
		this.ui.setFocus(this.input);
	}

	private async handleInput(input: string): Promise<void> {
		const trimmed = input.trim();
		if (!trimmed) return;

		// Clear the input field
		this.input.setValue("");
		this.ui.requestRender();

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
				const total = RE_TOOLS.length;
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

				const resp = await callLLM(this.llm, [{ role: "system", content: systemPrompt }, ...this.messages], toolSchemas, {
					onContent: (chunk: string) => {
						assistantContent += chunk;
						const last = this.transcript["entries"][this.transcript["entries"].length - 1];
						if (last && last.type === "assistant" && last.streaming) {
							this.transcript.updateLast(assistantContent);
						} else {
							this.transcript.add("assistant", assistantContent);
							this.transcript["entries"][this.transcript["entries"].length - 1].streaming = true;
						}
						this.ui.requestRender();
					},
				});

				this.transcript.finalizeLast();

				if (!resp.tool_calls || resp.tool_calls.length === 0) {
					this.messages.push({ role: "assistant", content: resp.content ?? assistantContent });
					break;
				}

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
