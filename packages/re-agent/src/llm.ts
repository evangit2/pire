/**
 * Shared LLM client — config loading, types, streaming chat completions.
 * Used by both the TUI and the autonomous reimplementation pipeline.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as https from "node:https";
import * as http from "node:http";

// ─── Types ─────────────────────────────────────────────────────

export interface LLMConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
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
		// Strip comments
		const commentIdx = rawLine.indexOf("#");
		const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
		const match = line.match(/^(\w+)\s*:\s*(.+)$/);
		if (!match) continue;
		let value = match[2].trim();
		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		result[match[1]] = value;
	}
	return result;
}

export function loadLLMConfig(): LLMConfig | null {
	const candidates = [
		process.env.PIRE_CONFIG,
		join(process.env.HOME || "/tmp", ".pire/config.yaml"),
	];
	for (const path of candidates) {
		if (!path || !existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf-8");
			const parsed = parseYAMLConfig(content);
			if (parsed.base_url && parsed.api_key && parsed.model) {
				return {
					baseUrl: parsed.base_url.replace(/\/$/, ""),
					apiKey: parsed.api_key,
					model: parsed.model,
				};
			}
		} catch {}
	}
	if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
		return {
			baseUrl: process.env.OPENAI_BASE_URL,
			apiKey: process.env.OPENAI_API_KEY,
			model: process.env.OPENAI_MODEL || process.env.PIRE_MODEL || "gpt-4o",
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
		max_tokens: options?.maxTokens ?? 8192,
		stream: true,
	});

	const optionsReq: http.RequestOptions = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
	};

	const doRequest = (): Promise<LLMResponse> => new Promise((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		const req = client.request(url, optionsReq, (res) => {
			if (res.statusCode && res.statusCode >= 500) {
				reject(new Error(`HTTP ${res.statusCode}`));
				return;
			}

			let content = "";
			const toolCalls: ToolCall[] = [];
			let buffer = "";
			let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

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
					} catch { /* skip malformed */ }
				}
			});

			res.on("end", () => {
				resolve({
					content: content || null,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
					usage,
				});
			});
		});
		req.on("error", reject);
		req.setTimeout(options?.timeoutMs ?? 180000, () => req.destroy(new Error("Timeout")));
		req.write(body);
		req.end();
	});

	let lastErr: Error | null = null;
	for (let i = 0; i < 3; i++) {
		try {
			return await doRequest();
		} catch (e) {
			lastErr = e instanceof Error ? e : new Error(String(e));
			if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
		}
	}
	throw lastErr;
}
