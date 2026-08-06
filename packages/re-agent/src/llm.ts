/**
 * Shared LLM client — config loading, types, streaming chat completions.
 * Used by both the TUI and the autonomous reimplementation pipeline.
 */

import { existsSync, readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { join } from "node:path";

// ─── Types ─────────────────────────────────────────────────────

export interface LLMConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	contextLength?: number;
	maxTokens?: number;
}

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface LLMResponse {
	content: string | null;
	tool_calls?: ToolCall[];
	usage?: { prompt_tokens: number; completion_tokens: number };
}

// ─── Config ────────────────────────────────────────────────────

/**
 * Parse a simple YAML config file line by line.
 * Handles quoted values, comments, and whitespace.
 * Supports flat key: value pairs only (all pire needs).
 */
function parseYAMLConfig(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of content.split("\n")) {
		const match = rawLine.match(/^\s*(\w+)\s*:\s*(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		// Strip comments only if NOT inside quotes
		if (value.startsWith('"') || value.startsWith("'")) {
			const quote = value[0];
			// Find the closing quote
			const endQuote = value.indexOf(quote, 1);
			if (endQuote >= 0) {
				// Everything after closing quote is comment (if any)
				value = value.slice(1, endQuote);
			}
		} else {
			// Unquoted: strip everything after #
			const commentIdx = value.indexOf("#");
			if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
		}
		result[match[1]] = value;
	}
	return result;
}

export function loadLLMConfig(): LLMConfig | null {
	const candidates = [process.env.PIRE_CONFIG, join(process.env.HOME || "/tmp", ".pire/config.yaml")];
	for (const path of candidates) {
		if (!path || !existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf-8");
			const parsed = parseYAMLConfig(content);
			if (parsed.base_url) {
				return {
					baseUrl: parsed.base_url.replace(/\/$/, ""),
					apiKey: parsed.api_key,
					model: parsed.model && parsed.model !== "none" ? parsed.model : "",
					contextLength: parsed.context_length ? parseInt(parsed.context_length) : undefined,
					maxTokens: parsed.max_tokens ? parseInt(parsed.max_tokens) : undefined,
				};
			}
		} catch {}
	}
	if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
		return {
			baseUrl: process.env.OPENAI_BASE_URL,
			apiKey: process.env.OPENAI_API_KEY,
			model: process.env.OPENAI_MODEL || process.env.PIRE_MODEL || "GLM-5.2",
		};
	}
	return null;
}

// ─── Tool schema conversion ────────────────────────────────────

import type { AgentTool } from "./index.js";

export function toolToFunction(tool: AgentTool<any>) {
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

// ─── LLM call with streaming + tool support ────────────────────

export interface CallOptions {
	maxTokens?: number;
	timeoutMs?: number;
	/** Called with content chunks as they arrive (for TUI streaming display). */
	onContent?: (chunk: string) => void;
	/** Abort signal — when aborted, the HTTP request is destroyed. */
	signal?: AbortSignal;
}

export async function callLLM(
	config: LLMConfig,
	messages: ChatMessage[],
	tools?: object[],
	options?: CallOptions,
): Promise<LLMResponse> {
	const url = new URL(config.baseUrl.replace(/\/$/, "") + "/chat/completions");
	const body = JSON.stringify({
		model: config.model,
		messages,
		tools: tools?.length ? tools : undefined,
		max_tokens: options?.maxTokens ?? config.maxTokens ?? 8192,
		stream: true,
	});

	const optionsReq: http.RequestOptions = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
	};

	const doRequest = (): Promise<LLMResponse> =>
		new Promise((resolve, reject) => {
			const client = url.protocol === "https:" ? https : http;
			const req = client.request(url, optionsReq, (res) => {
				if (res.statusCode && res.statusCode >= 400) {
					// Read error body for diagnostics
					let errBody = "";
					res.on("data", (c: Buffer) => (errBody += c.toString()));
					res.on("end", () => {
						const sc = res.statusCode ?? 500;
						const err = new Error(`HTTP ${sc}: ${errBody.slice(0, 500)}`);
						(err as any).statusCode = sc;
						(err as any).retriable = sc >= 500 || sc === 429;
						reject(err);
					});
					return;
				}

				let content = "";
				const toolCalls: ToolCall[] = [];
				let buffer = "";
				let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

				// If aborted, destroy the response stream
				options?.signal?.addEventListener("abort", () => {
					res.destroy();
				});

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
							if (!delta) {
								// Check for usage in final chunk (some providers send it without choices)
								if (json.usage) {
									usage = {
										prompt_tokens: json.usage.prompt_tokens ?? 0,
										completion_tokens: json.usage.completion_tokens ?? 0,
									};
								}
								continue;
							}

							if (delta.content) {
								content += delta.content;
								options?.onContent?.(delta.content);
							}
							if (delta.tool_calls) {
								for (const tc of delta.tool_calls) {
									const idx = tc.index ?? 0;
									if (!toolCalls[idx]) {
										toolCalls[idx] = {
											id: tc.id || "",
											type: "function" as const,
											function: { name: "", arguments: "" },
										};
									}
									if (tc.id) toolCalls[idx].id = tc.id;
									if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
									if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
								}
							}
							// Some providers send usage alongside the last delta
							if (json.usage) {
								usage = {
									prompt_tokens: json.usage.prompt_tokens ?? 0,
									completion_tokens: json.usage.completion_tokens ?? 0,
								};
							}
						} catch {
							/* skip malformed */
						}
					}
				});

				res.on("end", () => {
					// Sanitize tool calls: ensure arguments are valid JSON
					for (const tc of toolCalls) {
						if (tc.function?.arguments) {
							try {
								JSON.parse(tc.function.arguments);
							} catch {
								// Arguments are malformed JSON — try to fix common issues
								let fixed = tc.function.arguments;
								// If truncated (unterminated string), close it
								if (fixed.includes('"') && !fixed.endsWith("}")) {
									// Count unmatched braces
									let braces = 0;
									let inString = false;
									let escape = false;
									for (let i = 0; i < fixed.length; i++) {
										const ch = fixed[i];
										if (escape) {
											escape = false;
											continue;
										}
										if (ch === "\\") {
											escape = true;
											continue;
										}
										if (ch === '"') {
											inString = !inString;
											continue;
										}
										if (!inString) {
											if (ch === "{") braces++;
											else if (ch === "}") braces--;
										}
									}
									// Close any open string
									if (inString) fixed += '"';
									// Close open braces
									while (braces > 0) {
										fixed += "}";
										braces--;
									}
								}
								try {
									JSON.parse(fixed);
									tc.function.arguments = fixed;
								} catch {
									// Still broken — replace with empty object
									tc.function.arguments = "{}";
								}
							}
						}
					}
					resolve({
						content: content || null,
						tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
						usage,
					});
				});
			});
			req.on("error", reject);
			req.setTimeout(options?.timeoutMs ?? 180000, () => req.destroy(new Error("Timeout")));

			// If aborted before response arrives, destroy the request
			options?.signal?.addEventListener("abort", () => {
				req.destroy(new Error("Aborted"));
			});

			req.write(body);
			req.end();
		});

	let lastErr: Error | null = null;
	for (let i = 0; i < 3; i++) {
		try {
			return await doRequest();
		} catch (e) {
			lastErr = e instanceof Error ? e : new Error(String(e));
			// Don't retry 4xx client errors — they will never succeed
			const retriable = (lastErr as any).retriable;
			if (retriable === false) throw lastErr;
			// Retry on: 5xx (retriable=true), network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED), timeouts
			// These are all transient and may succeed on retry
			const code = (lastErr as any).code;
			if (code === "ECONNREFUSED") {
				// Server not running — don't retry, fail fast
				throw lastErr;
			}
			if (i < 2) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
		}
	}
	throw lastErr;
}
