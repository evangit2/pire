/**
 * pire-pi-tui.ts — Rich TUI built on Pi's TUI framework
 *
 * Uses TuiAltScreen (alternate screen buffer) for a fixed-viewport
 * layout with proper differential rendering and synchronized output
 * (DECSET ?2026) — no flicker, no scrollback pollution.
 *
 * Layout (TuiAltScreen — fixed viewport):
 *   ┌──────────────────────────────────────────┐
 *   │  HStack: [sidebar | chatVStack]           │
 *   │    sidebar: Box → tool list (full height) │
 *   │    chatVStack:                            │
 *   │      ScrollView(transcript)  ← grows      │
 *   │      DynamicBorder (separator)            │
 *   │      Box → status bar                     │
 *   │      Input (focused)                      │
 *   └──────────────────────────────────────────┘
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Box,
	type Component,
	Container,
	HStack,
	Input,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	TuiAltScreen,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { probeTools, RE_SYSTEM_PROMPT, RE_TOOLS, setGhidraTarget, validateToolParams } from "./index.js";
import { type ChatMessage, callLLM, type LLMConfig, loadLLMConfig, type ToolCall, toolToFunction } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.88.9";

// Use chalk for proper Pi-style colors
import chalk from "chalk";

const BANNER = `
       ,--.               
,---. '--',--.--. ,---.  
| .-. |,--.|  .--'| .-. : 
| '-' '|  ||  |   \\   --. 
|  |-' '--'--'    '----'  v${VERSION}
'--'                     
`;

// ─── SIGTERM handler ──────────────────────────────────────────
// Note: Ctrl+C is handled in the constructor via addInputListener
// because raw mode delivers it as 0x03, not as SIGINT.
function setupGracefulQuit(onQuit: () => void): void {
	process.on("SIGTERM", () => {
		onQuit();
		process.exit(0);
	});
}

const MAX_TURNS = parseInt(process.env.PIRE_MAX_TURNS || "70", 10) || 70;
const MAX_OUTPUT = parseInt(process.env.PIRE_MAX_OUTPUT || "16000", 10) || 16000;

// ─── Context Window Management ─────────────────────────────────
//
// Aggressive multi-stage compression to keep context small:
//   Stage 1: Truncate old tool results to head+tail (keep start + end)
//   Stage 2: Drop old tool results entirely, replace with 1-line stub
//   Stage 3: Drop old assistant messages, keep only first line
//   Stage 4: Drop old user messages (keep first line)
//
// Always preserves the most recent N messages untouched.
// Threshold is conservative — we compress well before the context window fills.

const CONTEXT_CHAR_LIMIT = parseInt(process.env.PIRE_CONTEXT_LIMIT || "120000", 10) || 120000;
const TOOL_RESULT_HEAD = 600; // Keep first N chars of old tool results
const TOOL_RESULT_TAIL = 600; // Keep last N chars of old tool results
const PRESERVE_RECENT = 8; // Never touch the most recent N messages

/** Estimate total characters in the message array. */
function estimateMessageChars(messages: ChatMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if (typeof msg.content === "string") total += msg.content.length;
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) total += (tc.function?.arguments?.length ?? 0) + 100;
		}
	}
	return total;
}

/**
 * Aggressively compress the message array to stay under CONTEXT_CHAR_LIMIT.
 * Multi-stage: truncate → stub → drop. Preserves recent messages.
 */
function trimContext(messages: ChatMessage[]): ChatMessage[] {
	if (messages.length <= PRESERVE_RECENT) return messages;

	let totalChars = estimateMessageChars(messages);
	if (totalChars <= CONTEXT_CHAR_LIMIT) return messages;

	// Work on a copy
	const result = messages.map((m) => ({ ...m }));
	const cutoff = result.length - PRESERVE_RECENT;

	// Stage 1: Truncate old tool results to head+tail
	for (let i = 0; i < cutoff && totalChars > CONTEXT_CHAR_LIMIT; i++) {
		const msg = result[i];
		if (
			msg.role === "tool" &&
			typeof msg.content === "string" &&
			msg.content.length > TOOL_RESULT_HEAD + TOOL_RESULT_TAIL
		) {
			const originalLen = msg.content.length;
			msg.content =
				msg.content.slice(0, TOOL_RESULT_HEAD) +
				`\n... (truncated ${originalLen - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL} chars) ...\n` +
				msg.content.slice(-TOOL_RESULT_TAIL);
			totalChars -= originalLen - msg.content.length;
		}
	}

	// Stage 2: Replace old tool results with 1-line stubs
	for (let i = 0; i < cutoff && totalChars > CONTEXT_CHAR_LIMIT; i++) {
		const msg = result[i];
		if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 100) {
			const originalLen = msg.content.length;
			// Keep just the first line as a summary
			const firstLine = msg.content.split("\n")[0]?.slice(0, 80) ?? "";
			msg.content = `[compressed: ${firstLine}...]`;
			totalChars -= originalLen - msg.content.length;
		}
	}

	// Stage 3: Compress old assistant messages — keep only first line
	for (let i = 0; i < cutoff && totalChars > CONTEXT_CHAR_LIMIT; i++) {
		const msg = result[i];
		if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 200) {
			const originalLen = msg.content.length;
			const firstLine = msg.content.split("\n")[0]?.slice(0, 120) ?? "";
			msg.content = firstLine + " [...]";
			totalChars -= originalLen - msg.content.length;
			// Drop old tool_calls from compressed assistant messages
			if (msg.tool_calls) {
				totalChars -= msg.tool_calls.reduce((sum, tc) => sum + (tc.function?.arguments?.length ?? 0) + 100, 0);
				delete msg.tool_calls;
			}
		}
	}

	// Stage 4: Compress old user messages — keep only first line
	for (let i = 0; i < cutoff && totalChars > CONTEXT_CHAR_LIMIT; i++) {
		const msg = result[i];
		if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 200) {
			const originalLen = msg.content.length;
			const firstLine = msg.content.split("\n")[0]?.slice(0, 120) ?? "";
			msg.content = firstLine + " [...]";
			totalChars -= originalLen - msg.content.length;
		}
	}

	return result;
}

// ─── DynamicBorder ─────────────────────────────────────────────
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

	constructor() {
		this.refresh();
	}

	refresh(): void {
		this.status = probeTools();
		this.cached = undefined;
	}

	render(width: number): string[] {
		const fixedWidth = Math.min(20, Math.max(10, width));
		if (this.cached && this.cachedW === fixedWidth) return this.cached;
		const lines: string[] = [];
		lines.push(chalk.bold.cyan("Tools"));
		lines.push(chalk.dim("─".repeat(fixedWidth)));
		lines.push("");
		for (const tool of RE_TOOLS) {
			const ok = this.status[tool.name] ?? false;
			const icon = ok ? chalk.green("✓") : chalk.gray("✗");
			const name = truncateToWidth(tool.name, fixedWidth - 4);
			lines.push(`${icon} ${chalk.dim(name)}`);
		}
		const avail = Object.values(this.status).filter(Boolean).length;
		const total = RE_TOOLS.length;
		lines.push("");
		lines.push(chalk.dim(`${avail}/${total} available`));
		this.cached = lines;
		this.cachedW = fixedWidth;
		return this.cached;
	}

	invalidate(): void {
		this.cached = undefined;
	}
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
		if (last) {
			last.text = text;
			this.cached = undefined;
		}
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
		const contentWidth = Math.max(10, width);
		for (const e of this.entries) {
			let prefix = "";
			let color = (s: string) => s;
			switch (e.type) {
				case "user":
					prefix = `${chalk.bold.cyan("you")} > `;
					break;
				case "assistant":
					prefix = `${chalk.bold.green("pire")} > `;
					break;
				case "tool_call":
					prefix = `${chalk.bold.yellow("⚙")} `;
					color = chalk.yellow;
					break;
				case "tool_result":
					prefix = `${chalk.dim("↳")} `;
					color = chalk.dim;
					break;
				case "system":
					prefix = `${chalk.bold("system")} > `;
					color = chalk.blue;
					break;
				case "error":
					prefix = `${chalk.bold.red("error")} > `;
					color = chalk.red;
					break;
			}
			const prefixLen = visibleWidth(prefix);

			if (e.type === "tool_call" || e.type === "tool_result") {
				const firstLine = e.text.split("\n")[0] || "";
				const wrapWidth = Math.max(10, contentWidth - prefixLen);
				let truncated = firstLine;
				if (visibleWidth(firstLine) > wrapWidth) {
					truncated = firstLine.slice(0, Math.max(0, wrapWidth - 3));
					const lastEscape = truncated.lastIndexOf("\x1b[");
					const lastM = truncated.lastIndexOf("m");
					if (lastEscape > lastM) {
						truncated = truncated.slice(0, lastEscape);
					}
					truncated += "...";
				}
				if (truncated) {
					lines.push(prefix + color(truncated));
				}
				continue;
			}

			const wrapWidth = Math.max(10, contentWidth - prefixLen);
			for (const rawLine of e.text.split("\n")) {
				const wrapped = wrapTextWithAnsi(rawLine, wrapWidth);
				for (let i = 0; i < wrapped.length; i++) {
					if (i === 0) {
						lines.push(prefix + color(wrapped[i]));
					} else {
						lines.push(" ".repeat(prefixLen) + color(wrapped[i]));
					}
				}
				if (wrapped.length === 0) {
					lines.push(prefix);
				}
			}
		}
		this.cached = lines;
		this.cachedW = width;
		return this.cached;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}

// ─── StatusBar ─────────────────────────────────────────────────
class StatusBar implements Component {
	private target = "none";
	private model = "";
	private processing = false;
	private turnCurrent = 0;
	private turnTotal = 0;
	private tokensIn = 0;
	private tokensOut = 0;
	private cached?: string[];
	private cachedW = -1;

	setTarget(t: string): void {
		this.target = t;
		this.cached = undefined;
	}
	setModel(m: string): void {
		this.model = m;
		this.cached = undefined;
	}
	setProcessing(p: boolean): void {
		this.processing = p;
		this.cached = undefined;
	}
	setTurns(current: number, total: number): void {
		this.turnCurrent = current;
		this.turnTotal = total;
		this.cached = undefined;
	}
	addTokens(inTokens: number, outTokens: number): void {
		this.tokensIn += inTokens;
		this.tokensOut += outTokens;
		this.cached = undefined;
	}
	resetTokens(): void {
		this.tokensIn = 0;
		this.tokensOut = 0;
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached && this.cachedW === width) return this.cached;
		const parts: string[] = [];
		parts.push(`${chalk.dim("target:")} ${this.target}`);
		parts.push(`${chalk.dim("model:")} ${this.model || "default"}`);
		if (this.turnTotal > 0) {
			parts.push(`${chalk.dim("turn:")} ${this.turnCurrent}/${this.turnTotal}`);
		}
		if (this.tokensIn > 0 || this.tokensOut > 0) {
			parts.push(
				`${chalk.dim("tokens:")} ${chalk.cyan("↑")}${this.tokensIn} ${chalk.magenta("↓")}${this.tokensOut}`,
			);
		}
		const left = parts.join("  ");
		const right = this.processing ? chalk.bold.yellow("⟳ working") : chalk.green("● ready");
		const lLen = visibleWidth(left);
		const rLen = visibleWidth(right);
		const gap = Math.max(1, width - lLen - rLen);
		this.cached = [left + " ".repeat(gap) + right];
		this.cachedW = width;
		return this.cached;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}

// ─── Render throttle helper ────────────────────────────────────
// Coalesces rapid requestRender() calls into a single render per
// animation frame (~16ms). This is the primary flicker reduction —
// instead of rendering on every streaming chunk (which can be dozens
// per second), we batch them into one render per frame.
class RenderThrottle {
	private pending = false;
	private timer: NodeJS.Timeout | null = null;
	private readonly interval: number;

	constructor(
		private renderFn: () => void,
		intervalMs = 16,
	) {
		this.interval = intervalMs;
	}

	request(): void {
		if (this.pending) return;
		this.pending = true;
		this.timer = setTimeout(() => {
			this.pending = false;
			this.timer = null;
			this.renderFn();
		}, this.interval);
	}

	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		// Always render on flush — even if the throttle timer already fired
		// or was never set. Without this, flushRender() calls in the agent
		// loop are silently dropped when no pending render exists, leaving
		// stale status bar content on screen (appears as duplicated lines).
		this.pending = false;
		this.renderFn();
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
			this.pending = false;
		}
	}
}

// ─── PirePiTUI ─────────────────────────────────────────────────
export class PirePiTUI {
	private ui: TuiAltScreen;
	private terminal: ProcessTerminal;
	private transcript: TranscriptView;
	private sidebar: ToolSidebar;
	private statusBar: StatusBar;
	private input: Input;
	private scrollView: ScrollView;
	private throttle: RenderThrottle;

	private messages: ChatMessage[] = [];
	private loadedTarget: string | null = null;
	private pendingUrl: string | null = null;
	private systemPrompt = RE_SYSTEM_PROMPT;
	private llm: LLMConfig | null;
	private processing = false;
	private abortController: AbortController | null = null;

	constructor(target?: string) {
		this.terminal = new ProcessTerminal();
		this.ui = new TuiAltScreen(this.terminal, true);

		this.transcript = new TranscriptView();
		this.sidebar = new ToolSidebar();
		this.statusBar = new StatusBar();

		// Render throttle — coalesce rapid renders into one per frame.
		// Uses differential rendering (no full clear) for smooth streaming
		// without flicker. Transition points (turn boundaries, status changes)
		// call flushRender() which does a forced full redraw to clear stale
		// content.
		this.throttle = new RenderThrottle(() => this.ui.requestRender(true), 33);

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
		if (this.llm?.model) {
			this.statusBar.setModel(this.llm.model);
		} else {
			this.statusBar.setModel("none — run: pire model");
		}

		// Initial transcript content
		this.transcript.add("system", BANNER);
		this.transcript.add(
			"system",
			"Tell me what you need — load a binary with :load, or just describe what you're looking for.",
		);
		this.transcript.add("system", "Type :help for commands, :quit to exit.");

		// ScrollView wraps the transcript — this is the scrollable area
		this.scrollView = new ScrollView(this.transcript, {
			follow: "end",
			primary: true,
			scrollbar: "auto",
		});

		// Chat column: scrollview (grows) + border + status + input
		const chatVStack = new VStack([
			{ component: this.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 3 },
			{ component: new DynamicBorder(), basis: 1, grow: 0, shrink: 0 },
			{ component: this.statusBar, basis: 1, grow: 0, shrink: 0, maxSize: 1 },
			{ component: this.input, basis: 1, grow: 0, shrink: 0, maxSize: 1 },
		]);

		// Sidebar column — padded to fill full height
		const sidebarInner = new Box(1, 1);
		sidebarInner.addChild(this.sidebar);
		const sidebarVStack = new VStack([{ component: sidebarInner, basis: 0, grow: 1, shrink: 0, minSize: 3 }]);

		// HStack: sidebar (fixed 22 cols) | chat (fills rest)
		const mainHStack = new HStack([
			{ component: sidebarVStack, basis: 22, grow: 0, shrink: 0, minSize: 22, maxSize: 22 },
			{ component: chatVStack, basis: 0, grow: 1, shrink: 1, minSize: 20 },
		]);

		// Set as layout root — TuiAltScreen uses renderLayoutFrame to
		// enforce sizing constraints and clip to the fixed viewport
		this.ui.setLayoutRoot(mainHStack);

		// Intercept Ctrl+C — in raw mode it arrives as 0x03, but when the
		// Kitty keyboard protocol is active it arrives as CSI-u (\x1b[99;5u).
		// Use matchesKey() to handle both encodings. The Input component
		// silently drops control chars, so we must intercept here.
		let ctrlCPressed = false;
		let ctrlCTimer: NodeJS.Timeout | undefined;
		this.ui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) {
				if (ctrlCPressed) {
					// Double press — exit immediately
					if (ctrlCTimer) clearTimeout(ctrlCTimer);
					this.stop();
					process.exit(0);
				}
				ctrlCPressed = true;
				// First press — abort current operation
				if (this.processing && this.abortController) {
					this.abortController.abort();
					this.transcript.add("system", chalk.bold.yellow("⏹ Aborted."));
					this.flushRender();
				} else if (!this.processing) {
					// Not processing — exit on first Ctrl+C
					this.stop();
					process.exit(0);
				}
				ctrlCTimer = setTimeout(() => {
					ctrlCPressed = false;
				}, 5000);
				return { consume: true };
			}
			return undefined;
		});

		// Focus the input
		this.ui.setFocus(this.input);
	}

	/** Request a render — always forces a full redraw to prevent stale content.
	 *  Synchronized output (BEGIN/END SYNCHRONIZED_OUTPUT) in the framework
	 *  prevents visible flicker. */
	private requestRender(): void {
		this.throttle.request();
	}

	/** Flush any pending render immediately — forces a full render, bypassing all coalescing */
	private flushRender(): void {
		this.throttle.dispose();
		this.ui.requestRender(true);
	}

	private async handleInput(input: string): Promise<void> {
		const trimmed = input.trim();
		if (!trimmed) return;

		// Clear the input field
		this.input.setValue("");
		this.flushRender();

		// Bare keywords that should quit without colon prefix
		if (trimmed === "exit" || trimmed === "quit" || trimmed === "q") {
			this.stop();
			process.exit(0);
		}

		if (trimmed.startsWith(":")) {
			await this.handleCommand(trimmed);
			return;
		}

		this.transcript.add("user", trimmed);
		this.messages.push({ role: "user", content: trimmed });

		// Reset turn counter for new user message
		this.statusBar.setTurns(0, MAX_TURNS);
		this.flushRender();
		await this.agentLoop();
	}

	private async handleCommand(cmd: string): Promise<void> {
		const parts = cmd.slice(1).split(" ");
		const command = parts[0];
		const arg = parts.slice(1).join(" ");

		switch (command) {
			case "help":
				this.transcript.add(
					"system",
					[
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
					].join("\n"),
				);
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
						setGhidraTarget(arg);
						this.sidebar.refresh();
						this.statusBar.setTarget(basename(arg));
						const status = probeTools();
						const avail = Object.values(status).filter(Boolean).length;
						this.transcript.add("system", `Loaded: ${arg} (${avail}/${RE_TOOLS.length} tools available)`);
					}
				}
				break;

			case "tools":
				this.transcript.add(
					"system",
					RE_TOOLS.map((t) => `  ${t.name.padEnd(20)} ${t.description.split(".")[0]}`).join("\n"),
				);
				break;

			case "probe": {
				this.transcript.add("system", "Probing system for tools...");
				this.sidebar.refresh();
				const status = probeTools();
				const avail = Object.values(status).filter(Boolean).length;
				const total = RE_TOOLS.length;
				this.transcript.add("system", `${avail}/${total} tools available`);
				break;
			}

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
				this.statusBar.setTurns(0, 0);
				this.statusBar.resetTokens();
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
		this.flushRender();
	}

	private async agentLoop(): Promise<void> {
		if (!this.llm) {
			this.transcript.add("error", "No LLM config found. Run: pire model");
			this.flushRender();
			return;
		}

		this.processing = true;
		this.statusBar.setProcessing(true);
		this.statusBar.resetTokens();
		this.abortController = new AbortController();
		this.flushRender();

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
					setGhidraTarget(path);
					this.sidebar.refresh();
					this.transcript.add("system", `Downloaded to: ${path}`);
					this.statusBar.setTarget(basename(path));
					this.messages.push({
						role: "user",
						content: `I've loaded ${url} (downloaded to ${path}). Please analyze it.`,
					});
				}
			}

			let systemPrompt = this.systemPrompt;
			if (this.loadedTarget) {
				systemPrompt += `\n\nThe user has loaded: ${this.loadedTarget}`;
			}
			// write_file instruction is already in RE_SYSTEM_PROMPT

			const toolSchemas = RE_TOOLS.map((t) => toolToFunction(t));

			for (let turn = 0; turn < MAX_TURNS; turn++) {
				// Count UP: turn 1/40, 2/40, ...
				this.statusBar.setTurns(turn + 1, MAX_TURNS);
				this.requestRender();

				let assistantContent = "";

				const resp = await callLLM(
					this.llm,
					[{ role: "system", content: systemPrompt }, ...trimContext(this.messages)],
					toolSchemas,
					{
						signal: this.abortController?.signal,
						onContent: (chunk: string) => {
							assistantContent += chunk;
							const last = this.transcript["entries"][this.transcript["entries"].length - 1];
							if (last && last.type === "assistant" && last.streaming) {
								this.transcript.updateLast(assistantContent);
							} else {
								this.transcript.add("assistant", assistantContent);
								this.transcript["entries"][this.transcript["entries"].length - 1].streaming = true;
							}
							// Throttled render — coalesces rapid chunks
							this.requestRender();
						},
					},
				);

				this.transcript.finalizeLast();

				// Track token usage
				if (resp.usage) {
					this.statusBar.addTokens(resp.usage.prompt_tokens, resp.usage.completion_tokens);
				}

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
						this.messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: `Error: unknown tool ${tc.function.name}`,
						});
						continue;
					}

					let args: any;
					try {
						const raw = tc.function.arguments;
						if (!raw || raw.trim() === "") {
							args = {};
						} else {
							args = JSON.parse(raw);
						}
					} catch {
						args = {};
					}

					// Validate that required string args aren't undefined/null.
					// LLMs sometimes send {"command": undefined} or {"command": null}
					// which causes execSync to throw with a confusing type error.
					for (const key of Object.keys(args)) {
						if (args[key] === undefined || args[key] === null) {
							delete args[key];
						}
					}

					// Validate required params are present (catches undefined → deleted → missing)
					const validationError = validateToolParams(tool, args);
					if (validationError) {
						this.transcript.add("error", validationError);
						this.messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: `Error: ${validationError}`,
						});
						continue;
					}

					// Auto-detect target from tool calls
					if (!this.loadedTarget) {
						const candidate = args.path || args.binary || args.target || args.file;
						if (candidate && typeof candidate === "string" && candidate.startsWith("/")) {
							this.loadedTarget = candidate;
							this.statusBar.setTarget(basename(candidate));
						}
					}

					if (this.loadedTarget && !args.target && !args.binary && !args.path && !args.file) {
						args.target = this.loadedTarget;
					}

					// Format tool call args for display
					let displayArgs: string;
					try {
						const parsed = JSON.parse(tc.function.arguments);
						displayArgs = JSON.stringify(parsed);
					} catch {
						displayArgs = tc.function.arguments;
					}
					if (displayArgs.length > 120) {
						displayArgs = displayArgs.slice(0, 117) + "...";
					}
					this.transcript.add("tool_call", `${tc.function.name}(${displayArgs})`);
					this.requestRender();

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

					// Clean up result text for display
					let displayResult = resultText;
					const resultLines = displayResult.split("\n");
					const cleanedLines: string[] = [];
					let inTraceback = false;
					for (const ln of resultLines) {
						if (ln.startsWith("Traceback (most recent call last):")) {
							inTraceback = true;
							continue;
						}
						if (inTraceback) {
							if (ln.startsWith("  ") || ln.startsWith("\t") || ln.startsWith("    ")) continue;
							inTraceback = false;
						}
						if (/^(WARNING|INFO|ERROR)\s+\|/.test(ln)) continue;
						cleanedLines.push(ln);
					}
					displayResult = cleanedLines.join("\n").trim() || "(no output)";

					this.transcript.add(
						"tool_result",
						displayResult.slice(0, 200) + (displayResult.length > 200 ? "..." : ""),
					);
					this.requestRender();

					this.messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
				}
			}
		} catch (e: any) {
			if (e?.message === "Aborted" || e?.code === "ERR_ABORTED" || e?.name === "AbortError") {
				// Expected when user presses Ctrl+C
			} else {
				this.transcript.add("error", e.message);
			}
		} finally {
			this.processing = false;
			this.abortController = null;
			this.statusBar.setProcessing(false);
			this.flushRender();
		}
	}

	start(): void {
		this.ui.start();
		setupGracefulQuit(() => {
			this.stop();
		});
	}

	stop(): void {
		this.throttle.dispose();
		this.ui.stop();
	}
}
