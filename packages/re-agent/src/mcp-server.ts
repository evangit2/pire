/**
 * pire MCP server — JSON-RPC 2.0 over stdio
 *
 * Exposes pire's RE tools and agent loop to programmatic clients.
 * Clients can create sessions, load targets, send prompts, and
 * get structured results back — no tmux scraping required.
 *
 * Protocol: line-delimited JSON-RPC 2.0 over stdin/stdout.
 * Each request is one JSON object per line.
 *
 * Methods:
 *   initialize       — handshake, returns server info + tool list
 *   session.create   — create a new RE session (optionally with a target)
 *   session.list     — list active sessions
 *   session.destroy   — destroy a session
 *   session.load     — load a target binary into a session
 *   session.prompt   — send a natural-language prompt to the session's agent
 *   session.history   — get conversation history
 *   session.save      — save session history to a file
 *   tool.execute     — directly execute a single RE tool (no LLM in the loop)
 *   tool.list        — list all available RE tools
 *   tools/call       — MCP-compatible alias for tool.execute
 *
 * Usage:
 *   pire -mcp                        — start MCP server on stdio
 *   pire -mcp --port 9847            — start MCP server on TCP port
 *   pire -mcp --port 9847 --host 0.0.0.0
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import * as net from "node:net";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	type AgentTool,
	probeTools,
	RE_SYSTEM_PROMPT,
	RE_TOOLS,
	setGhidraTarget,
	type ToolResult,
	validateToolParams,
} from "./index.js";
import { type ChatMessage, callLLM, type LLMConfig, loadLLMConfig, toolToFunction } from "./llm.js";

// Context window management — percentage-based, works with any model/context size
// Per-tool-output cap: keep it small — 5% of context budget, min 2000, max 20000 chars.
// Large outputs (objdump -d, readelf -a) should be truncated early, not fill the context.
const MAX_TOOL_OUTPUT = Math.min(20000, Math.max(2000, Math.floor(getContextCharLimit() * 0.05)));

const __filename = fileURLToPath(import.meta.url);
const __dirname_mcp = dirname(__filename);

// Read version from package.json at module load
// In source mode (src/), package.json is at ../../package.json
// In compiled mode (dist/), package.json is at ../package.json
let VERSION = "0.0.0";
for (const rel of ["../package.json", "../../package.json"]) {
	try {
		const pkgPath = join(__dirname_mcp, rel);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		if (pkg.version) {
			VERSION = pkg.version;
			break;
		}
	} catch {}
}

// ─── Context Window Management (shared) ────────────────────────

/**
 * Context budget based on the configured model's context length.
 * Uses percentages so it works with any model — 2k or 2M context.
 * - 75% of context window is the char budget (leaves room for new generation)
 * - Tool result compression: keep first/last 5% of budget each
 * - Always preserve the most recent 8 messages
 */
function getContextCharLimit(): number {
	const llm = loadLLMConfig();
	const ctxLen = llm?.contextLength && llm.contextLength > 0 ? llm.contextLength : 32000;
	return Math.floor(ctxLen * 4 * 0.75); // tokens → chars, use 75% of window
}

const CONTEXT_CHAR_LIMIT = parseInt(process.env.PIRE_CONTEXT_LIMIT || "0", 10) || getContextCharLimit();
const PRESERVE_RECENT = 8;

function getToolResultHeadTail(): { head: number; tail: number } {
	// 5% of context budget each (head + tail = 10% total per tool result)
	const slice = Math.max(200, Math.floor(CONTEXT_CHAR_LIMIT * 0.05));
	return { head: slice, tail: slice };
}

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

/** Multi-stage context compression: truncate → stub → drop old messages.
 *  Triggers at 60% of context budget to stay ahead of growth. */
function trimContextMessages(messages: ChatMessage[]): ChatMessage[] {
	if (messages.length <= PRESERVE_RECENT) return messages;
	let totalChars = estimateMessageChars(messages);
	const triggerLimit = Math.floor(CONTEXT_CHAR_LIMIT * 0.6);
	if (totalChars <= triggerLimit) return messages;
	const result = messages.map((m) => ({ ...m }));
	const cutoff = result.length - PRESERVE_RECENT;
	const { head: toolHead, tail: toolTail } = getToolResultHeadTail();

	// Stage 1: Truncate old tool results to head+tail
	for (let i = 0; i < cutoff && totalChars > triggerLimit; i++) {
		const msg = result[i];
		if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > toolHead + toolTail) {
			const originalLen = msg.content.length;
			msg.content = msg.content.slice(0, toolHead) + `\n... (truncated ${originalLen - toolHead - toolTail} chars) ...\n` + msg.content.slice(-toolTail);
			totalChars -= originalLen - msg.content.length;
		}
	}

	// Stage 2: Replace old tool results with 1-line stubs
	for (let i = 0; i < cutoff && totalChars > triggerLimit; i++) {
		const msg = result[i];
		if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 100) {
			const originalLen = msg.content.length;
			const firstLine = msg.content.split("\n")[0]?.slice(0, 80) ?? "";
			msg.content = `[compressed: ${firstLine}...]`;
			totalChars -= originalLen - msg.content.length;
		}
	}

	// Stage 3: Compress old assistant messages
	for (let i = 0; i < cutoff && totalChars > triggerLimit; i++) {
		const msg = result[i];
		if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 200) {
			const originalLen = msg.content.length;
			msg.content = (msg.content.split("\n")[0]?.slice(0, 120) ?? "") + " [...]";
			totalChars -= originalLen - msg.content.length;
			if (msg.tool_calls) {
				totalChars -= msg.tool_calls.reduce((sum, tc) => sum + (tc.function?.arguments?.length ?? 0) + 100, 0);
				delete msg.tool_calls;
			}
		}
	}

	// Stage 4: Compress old user messages
	for (let i = 0; i < cutoff && totalChars > triggerLimit; i++) {
		const msg = result[i];
		if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 200) {
			const originalLen = msg.content.length;
			msg.content = (msg.content.split("\n")[0]?.slice(0, 120) ?? "") + " [...]";
			totalChars -= originalLen - msg.content.length;
		}
	}

	return result;
}

// ─── Session ───────────────────────────────────────────────────

interface MCPSession {
	id: string;
	messages: ChatMessage[];
	target: string | null;
	llm: LLMConfig | null;
	tools: Record<string, boolean>;
	toolMap: Map<string, AgentTool<any>>;
	createdAt: number;
}

const sessions = new Map<string, MCPSession>();
let sessionCounter = 0;

function createSession(target?: string): MCPSession {
	const id = `sess_${Date.now()}_${sessionCounter++}`;
	const llm = loadLLMConfig();
	const tools = probeTools();
	const toolMap = new Map<string, AgentTool<any>>();
	for (const tool of RE_TOOLS) toolMap.set(tool.name, tool);

	const session: MCPSession = {
		id,
		messages: [],
		target: target ?? null,
		llm,
		tools,
		toolMap,
		createdAt: Date.now(),
	};
	if (target) setGhidraTarget(target);
	sessions.set(id, session);
	return session;
}

function getSession(id: string): MCPSession | null {
	return sessions.get(id) ?? null;
}

function destroySession(id: string): boolean {
	return sessions.delete(id);
}

// ─── Agent loop (shared between CLI and MCP) ──────────────────

interface AgentLoopOptions {
	onContent?: (chunk: string) => void;
	onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
	onToolResult?: (toolName: string, result: string) => void;
	onTurn?: (turn: number, maxTurns: number) => void;
	maxTurns?: number;
}

interface AgentLoopResult {
	content: string;
	toolCalls: { name: string; args: Record<string, unknown>; result: string }[];
	turns: number;
}

export async function runAgentLoop(
	session: MCPSession,
	userMessage: string,
	options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
	if (!session.llm) {
		throw new Error("No LLM configured. Run: pire model");
	}

	const availToolNames = Object.entries(session.tools)
		.filter(([, v]) => v)
		.map(([k]) => k);
	const availTools = availToolNames.join(", ");
	const targetInfo = session.target ? `\n\nCurrently loaded target: ${session.target}` : "";
	const systemPrompt = `${RE_SYSTEM_PROMPT}

You have ${availToolNames.length} tools available. Available on this system: ${availTools}.${targetInfo}

When the user mentions a path, binary, or directory — run tools on it yourself. Don't ask them to type commands.
When the user provides a URL — use the fetch tool to download it first.
Pick the right tools for whatever the user is asking for. Don't follow a fixed workflow — adapt to the task.

IMPORTANT: When you need to write a file, use the write_file tool with path and content parameters. Do not use shell heredocs or echo commands. Always write your analysis to a file before reporting completion.`;

	// Only send schemas for tools that are actually available — saves ~50% tokens
	const toolSchemas = RE_TOOLS
		.filter((t) => session.tools[t.name] !== false)
		.map(toolToFunction);
	const MAX_TURNS = options.maxTurns ?? 70;
	const toolCallLog: { name: string; args: Record<string, unknown>; result: string }[] = [];

	let finalContent = "";
	let turnCount = 0;

	// Add user message to session history once
	session.messages.push({ role: "user", content: userMessage });

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		turnCount = turn + 1;
		options.onTurn?.(turn + 1, MAX_TURNS);

		// Reset finalContent each turn — we only want the last turn's response
		finalContent = "";

		// Build messages from trimmed session history.
		// session.messages already contains the user message (added above) and all
		// prior assistant/tool messages. Just trim and send.
		const trimmedHistory = trimContextMessages(session.messages);

		const messages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...trimmedHistory,
		];

		// seenCalls is per-turn, not per-session — allows re-running same tool in different turns
		const seenCalls = new Set<string>();

		const resp = await callLLM(session.llm, messages, toolSchemas, {
			onContent: (chunk) => {
				finalContent += chunk;
				options.onContent?.(chunk);
			},
		});

		if (resp.tool_calls && resp.tool_calls.length > 0) {
			// Save assistant message with tool calls to session history
			session.messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls });
			messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls });

			// Execute tool calls in parallel when possible.
			// Tools with executionMode "sequential" (e.g. r2, ghidra) run one at a time.
			// All other tools run concurrently via Promise.all.
			const sequentialCalls: typeof resp.tool_calls = [];
			const parallelCalls: typeof resp.tool_calls = [];
			for (const tc of resp.tool_calls) {
				const tool = session.toolMap.get(tc.function.name);
				if (tool?.executionMode === "sequential") {
					sequentialCalls.push(tc);
				} else {
					parallelCalls.push(tc);
				}
			}

			// Helper: execute a single tool call and return its result + messages
			async function execToolCall(tc: NonNullable<typeof resp.tool_calls>[0]): Promise<void> {
				const tool = session.toolMap.get(tc.function.name);
				if (!tool) {
					const errMsg = `Error: unknown tool "${tc.function.name}"`;
					messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
					session.messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
					return;
				}
				let params: Record<string, unknown>;
				try {
					params = JSON.parse(tc.function.arguments);
				} catch {
					params = {};
				}

				const validationError = validateToolParams(tool, params);
				if (validationError) {
					messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${validationError}` });
					session.messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${validationError}` });
					options.onToolCall?.(tc.function.name, params);
					options.onToolResult?.(tc.function.name, `Error: ${validationError}`);
					toolCallLog.push({ name: tc.function.name, args: params, result: `Error: ${validationError}` });
					return;
				}

				const callSig = `${tc.function.name}:${JSON.stringify(params)}`;
				if (seenCalls.has(callSig)) {
					const skipMsg = "Skipped: identical call already executed this turn.";
					messages.push({ role: "tool", tool_call_id: tc.id, content: skipMsg });
					session.messages.push({ role: "tool", tool_call_id: tc.id, content: skipMsg });
					return;
				}
				seenCalls.add(callSig);

				options.onToolCall?.(tc.function.name, params);

				try {
					// Per-tool timeout: 120s default, 300s for known slow tools
					const toolTimeout = ["angr", "ghidra_decompile", "decompile", "volatility"].includes(tc.function.name) ? 300000 : 120000;
					const result = await Promise.race([
						tool.execute("pire", params),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error(`Tool "${tc.function.name}" timed out after ${toolTimeout / 1000}s`)), toolTimeout),
						),
					]);
					const text = result.content.map((c: { text: string }) => c.text).join("\n");
					const truncated = text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n... (truncated)" : text;
					messages.push({ role: "tool", tool_call_id: tc.id, content: truncated });
					session.messages.push({ role: "tool", tool_call_id: tc.id, content: truncated });
					options.onToolResult?.(tc.function.name, text);
					toolCallLog.push({ name: tc.function.name, args: params, result: text });
				} catch (e) {
					const errMsg = e instanceof Error ? e.message : String(e);
					messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${errMsg}` });
					session.messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${errMsg}` });
					options.onToolResult?.(tc.function.name, `Error: ${errMsg}`);
					toolCallLog.push({ name: tc.function.name, args: params, result: `Error: ${errMsg}` });
				}
			}

			// Run parallel tools concurrently, then sequential tools one-by-one
			await Promise.all(parallelCalls.map((tc) => execToolCall(tc)));
			for (const tc of sequentialCalls) {
				await execToolCall(tc);
			}
			continue;
			}

			if (resp.content) {
			session.messages.push({ role: "assistant", content: resp.content });
			}
			break;
			}

			return { content: finalContent, toolCalls: toolCallLog, turns: turnCount };
			}

// ─── JSON-RPC ──────────────────────────────────────────────────

interface RPCRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface RPCResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

function ok(id: number | string, result: unknown): RPCResponse {
	return { jsonrpc: "2.0", id, result };
}

function err(id: number | string, code: number, message: string, data?: unknown): RPCResponse {
	return { jsonrpc: "2.0", id, error: { code, message, data } };
}

// ─── Method handlers ───────────────────────────────────────────

async function handleRequest(req: RPCRequest): Promise<RPCResponse> {
	const { id, method, params } = req;
	const p = params ?? {};

	try {
		switch (method) {
			case "initialize": {
				return ok(id, {
					protocolVersion: "2024-11-05",
					serverInfo: { name: "pire", version: VERSION },
					capabilities: { tools: {}, resources: {}, prompts: {} },
					tools: RE_TOOLS.map((t) => ({
						name: t.name,
						description: t.description,
						parameters: (t.parameters as any)?.properties ?? {},
						required: (t.parameters as any)?.required ?? [],
					})),
				});
			}

			case "tools/list":
			case "tool.list": {
				return ok(id, {
					tools: RE_TOOLS.map((t) => ({
						name: t.name,
						description: t.description,
						parameters: (t.parameters as any)?.properties ?? {},
						required: (t.parameters as any)?.required ?? [],
					})),
				});
			}

			case "tools/call":
			case "tool.execute": {
				const toolName = p.name as string;
				const toolArgs = (p.arguments ?? p.params ?? {}) as Record<string, unknown>;
				const tool = RE_TOOLS.find((t) => t.name === toolName);
				if (!tool) {
					return err(id, -32602, `Unknown tool: ${toolName}`);
				}
				const validationError = validateToolParams(tool, toolArgs);
				if (validationError) {
					return err(id, -32602, validationError);
				}
				const result: ToolResult = await tool.execute("pire", toolArgs);
				const text = result.content.map((c: { text: string }) => c.text).join("\n");
				// Record in session history if sessionId provided
				const sid = p.sessionId as string | undefined;
				if (sid && sessions.has(sid)) {
					const session = sessions.get(sid)!;
					session.messages.push({ role: "tool", tool_call_id: `tool_${id}`, content: text });
					session.messages.push({
						role: "assistant",
						content: `Tool ${toolName} result: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`,
					});
				}
				return ok(id, { content: [{ type: "text", text }] });
			}

			case "session.create": {
				const target = p.target as string | undefined;
				const session = createSession(target);
				return ok(id, {
					sessionId: session.id,
					target: session.target,
					llm: session.llm ? session.llm.model : null,
					tools: session.tools,
				});
			}

			case "session.list": {
				return ok(id, {
					sessions: Array.from(sessions.values()).map((s) => ({
						id: s.id,
						target: s.target,
						messageCount: s.messages.length,
						createdAt: s.createdAt,
					})),
				});
			}

			case "session.destroy": {
				const sid = p.sessionId as string;
				if (!destroySession(sid)) {
					return err(id, -32602, `Session not found: ${sid}`);
				}
				return ok(id, { destroyed: true });
			}

			case "session.load": {
				const sid = p.sessionId as string;
				const target = p.target as string;
				const session = getSession(sid);
				if (!session) {
					return err(id, -32602, `Session not found: ${sid}`);
				}
				session.target = target;
				setGhidraTarget(target);
				return ok(id, { loaded: target });
			}

			case "session.prompt": {
				const sid = p.sessionId as string;
				const prompt = p.prompt as string;
				const session = getSession(sid);
				if (!session) {
					return err(id, -32602, `Session not found: ${sid}`);
				}
				if (!prompt) {
					return err(id, -32602, "Missing required parameter 'prompt'");
				}

				const events: unknown[] = [];
				const result = await runAgentLoop(session, prompt, {
					maxTurns: p.maxTurns as number | undefined,
					onContent: (chunk) => events.push({ type: "content", chunk }),
					onToolCall: (name, args) => events.push({ type: "tool_call", name, args }),
					onToolResult: (name, result) => events.push({ type: "tool_result", name, result }),
					onTurn: (turn, max) => events.push({ type: "turn", turn, max }),
				});

				return ok(id, {
					content: result.content,
					toolCalls: result.toolCalls,
					turns: result.turns,
					events,
				});
			}

			case "session.history": {
				const sid = p.sessionId as string;
				const session = getSession(sid);
				if (!session) {
					return err(id, -32602, `Session not found: ${sid}`);
				}
				return ok(id, { messages: session.messages, target: session.target });
			}

			case "session.save": {
				const sid = p.sessionId as string;
				const path = p.path as string;
				const session = getSession(sid);
				if (!session) {
					return err(id, -32602, `Session not found: ${sid}`);
				}
				const data = JSON.stringify(
					{
						version: VERSION,
						target: session.target,
						messages: session.messages,
					},
					null,
					2,
				);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, data);
				return ok(id, { saved: true, path, messages: session.messages.length });
			}

			default:
				return err(id, -32601, `Method not found: ${method}`);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return err(id, -32603, `Internal error: ${msg}`);
	}
}

// ─── Server: stdio mode ────────────────────────────────────────

async function runStdioServer() {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let req: RPCRequest;
		try {
			req = JSON.parse(trimmed);
		} catch {
			const response = err(0, -32700, "Parse error");
			process.stdout.write(JSON.stringify(response) + "\n");
			continue;
		}

		const response = await handleRequest(req);
		process.stdout.write(JSON.stringify(response) + "\n");
	}
}

// ─── Server: TCP mode ──────────────────────────────────────────

async function runTcpServer(port: number, host: string) {
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf-8");

		socket.on("data", async (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				let req: RPCRequest;
				try {
					req = JSON.parse(trimmed);
				} catch {
					socket.write(JSON.stringify(err(0, -32700, "Parse error")) + "\n");
					continue;
				}

				const response = await handleRequest(req);
				socket.write(JSON.stringify(response) + "\n");
			}
		});

		socket.on("error", () => {
			/* client disconnected */
		});
	});

	server.listen(port, host, () => {
		process.stderr.write(`pire MCP server listening on ${host}:${port}\n`);
	});
}

// ─── Server: HTTP mode ─────────────────────────────────────────

async function runHttpServer(port: number, host: string) {
	const server = createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify(err(0, -32601, "Method not allowed: use POST")));
			return;
		}

		// Limit body size to 10MB to prevent memory exhaustion
		const MAX_BODY = 10 * 1024 * 1024;
		let body = "";
		let tooLarge = false;
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > MAX_BODY) {
				tooLarge = true;
				req.destroy();
			}
		});
		req.on("end", async () => {
			if (tooLarge) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify(err(0, -32600, "Request body too large (max 10MB)")));
				return;
			}
			let rpcReq: RPCRequest;
			try {
				rpcReq = JSON.parse(body);
			} catch {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(err(0, -32700, "Parse error")));
				return;
			}

			// Support JSON-RPC batch requests (array of requests)
			if (Array.isArray(rpcReq)) {
				const responses = await Promise.all(rpcReq.map((r) => handleRequest(r)));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(responses));
				return;
			}

			const response = await handleRequest(rpcReq);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(response));
		});
		req.on("error", () => {
			if (!res.headersSent) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify(err(0, -32600, "Request error")));
			}
		});
	});

	server.listen(port, host, () => {
		process.stderr.write(`pire MCP HTTP server listening on http://${host}:${port}\n`);
	});
}

// ─── Entry point ───────────────────────────────────────────────

export async function startMCPServer(args: string[]) {
	let port: number | null = null;
	let host = "127.0.0.1";
	let transport: "stdio" | "tcp" | "http" = "stdio";

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = parseInt(args[i + 1]);
			transport = "tcp";
			i++;
		} else if (args[i] === "--http" && args[i + 1]) {
			port = parseInt(args[i + 1]);
			transport = "http";
			i++;
		} else if (args[i] === "--host" && args[i + 1]) {
			host = args[i + 1];
			i++;
		} else if (args[i] === "--stdio") {
			transport = "stdio";
		}
	}

	if (transport === "stdio") {
		await runStdioServer();
	} else if (transport === "tcp" && port) {
		await runTcpServer(port, host);
	} else if (transport === "http" && port) {
		await runHttpServer(port, host);
	} else {
		process.stderr.write("Invalid arguments. Use: pire -mcp [--port N] [--host H] [--stdio]\n");
		process.exit(1);
	}
}

// ─── Self-invoking entry point (for direct tsx execution) ──────

const isDirectRun = (() => {
	const argv0 = process.argv[1] ?? "";
	return argv0.endsWith("mcp-server.ts") || argv0.endsWith("mcp-server.js");
})();

if (isDirectRun) {
	startMCPServer(process.argv.slice(2));
}
