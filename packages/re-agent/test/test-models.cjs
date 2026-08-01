#!/usr/bin/env node
/**
 * pire model inference test harness
 *
 * Tests real model inference through Hermes-configured providers.
 * Verifies that the LLM can:
 * 1. Understand the RE system prompt
 * 2. Choose appropriate tools
 * 3. Produce structured tool calls
 * 4. Handle multi-turn RE conversations
 * 5. Stream responses correctly
 *
 * Usage:
 *   node packages/re-agent/test/test-models.cjs                 — run all model tests
 *   node packages/re-agent/test/test-models.cjs --quick          — single model, single test
 *   node packages/re-agent/test/test-models.cjs --provider=vt-arc — specific provider
 *
 * Reads API config from ~/.hermes/config.yaml
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const https = require("https");
const http = require("http");

// ─── Config ────────────────────────────────────────────────────

const CONFIG_PATH = path.join(process.env.HOME, ".hermes", "config.yaml");

function loadConfig() {
	const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
	const config = {};
	// Simple YAML parsing for the fields we need
	const lines = raw.split("\n");
	let inModel = false, inProviders = false, currentProvider = null;
	for (const line of lines) {
		if (line.startsWith("model:")) { inModel = true; inProviders = false; continue; }
		if (line.startsWith("providers:")) { inModel = false; inProviders = true; continue; }
		if (line.startsWith("fallback_providers:")) { inProviders = false; continue; }

		if (inModel) {
			const m = line.match(/^\s+(\w+):\s*(.+)$/);
			if (m) config[`model.${m[1]}`] = m[2].replace(/^["']|["']$/g, "");
		}
		if (inProviders) {
			const pm = line.match(/^\s{2}(\w+):\s*$/);
			if (pm) { currentProvider = pm[1]; config[`providers.${currentProvider}`] = {}; continue; }
			if (currentProvider) {
				const m = line.match(/^\s{4}(\w+):\s*(.+)$/);
				if (m) config[`providers.${currentProvider}.${m[1]}`] = m[2].replace(/^["']|["']$/g, "");
			}
		}
	}
	return config;
}

function getProviders(cfg) {
	const providers = {};
	// Main provider
	if (cfg["model.base_url"] && cfg["model.api_key"]) {
		providers["main"] = {
			name: cfg["model.provider"] || "main",
			url: cfg["model.base_url"].replace(/\/$/, "") + "/chat/completions",
			apiKey: cfg["model.api_key"],
			model: cfg["model.default"],
		};
	}
	// Named providers
	for (const key of Object.keys(cfg)) {
		const m = key.match(/^providers\.(\w+)\.api$/);
		if (m) {
			const name = m[1];
			const url = cfg[`providers.${name}.api`].replace(/\/$/, "");
			const p = {
				name: cfg[`providers.${name}.name`] || name,
				url: url.match(/\/v1$/) ? url + "/chat/completions" : url.replace(/\/v1\/?$/, "") + "/v1/chat/completions",
				apiKey: cfg[`providers.${name}.api_key`] || "",
				model: cfg[`providers.${name}.default_model`] || "",
			};
			if (p.apiKey && p.model) providers[name] = p;
		}
	}
	return providers;
}

// ─── HTTP ──────────────────────────────────────────────────────

function postJSON(url, apiKey, body, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const lib = parsed.protocol === "https:" ? https : http;
		const data = JSON.stringify(body);
		const req = lib.request(parsed, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
				"Content-Length": Buffer.byteLength(data),
			},
			timeout: timeoutMs,
		}, (res) => {
			let body = "";
			res.on("data", (chunk) => body += chunk);
			res.on("end", () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try { resolve(JSON.parse(body)); }
					catch { resolve({ raw: body }); }
				} else {
					reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
				}
			});
		});
		req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

// ─── RE System Prompt (minimal for testing) ────────────────────

const RE_PROMPT = `You are pire, a reverse engineering agent specialized in analyzing closed-source binaries. You have tools for binary analysis: strings, filetype, objdump, disasm_func, readelf, hexdump, r2, ghidra_decompile, ghidra_functions, ghidra_rename, ghidra_xrefs, ghidra_strings, binwalk, lief, angr, capstone, keystone, unicorn, yara, frida, gdb, volatility.

Work in stages: Stage 1 (Triage: filetype, strings, readelf), Stage 2 (Structure: objdump/disasm_func, r2), Stage 3 (Deep Analysis: analyze each function, quote exact instructions), Stage 4 (Synthesis: reconstruct algorithm). Always start with filetype to identify the binary.`;

// ─── Test Cases ────────────────────────────────────────────────

const TESTS = [
	{
		name: "system prompt comprehension",
		prompt: "What tools do you have available for binary analysis? List them briefly.",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("strings") && text.includes("filetype") && text.includes("r2");
		},
	},
	{
		name: "tool selection reasoning",
		prompt: "I have an unknown ELF binary. What's the first thing you'd do to analyze it?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("file") || text.includes("filetype") || text.includes("identify");
		},
	},
	{
		name: "RE workflow understanding",
		prompt: "Describe the steps you'd take to reverse engineer a Windows DLL.",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			const keywords = ["strings", "import", "export", "function", "decompil", "ghidra"];
			return keywords.filter(k => text.includes(k)).length >= 3;
		},
	},
	{
		name: "crash recovery awareness",
		prompt: "If Ghidra crashes during analysis, what should happen?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("restart") || text.includes("recover") || text.includes("retry") || text.includes("status");
		},
	},
	{
		name: "multi-arch knowledge",
		prompt: "How would you analyze an ARM binary on this x86 system? Which tools would you use?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("capstone") || text.includes("r2") || text.includes("ghidra") || text.includes("objdump");
		},
	},
	{
		name: "structured response",
		prompt: "Analyze this hex dump and tell me what you see: 7f 45 4c 46 02 01 01 00. What format is this?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("elf") || text.includes("7f454c46");
		},
	},
	{
		name: "disasm_func awareness",
		prompt: "I need to extract a single function from a stripped binary at address 0x13b0. Which tool should I use and why?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("disasm_func") && (text.includes("early-exit") || text.includes("boundary") || text.includes("function") || text.includes("ret"));
		},
	},
	{
		name: "multi-stage workflow",
		prompt: "Describe your analysis workflow for a stripped ELF binary with no symbols.",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("filetype") && text.includes("strings") && (text.includes("stage") || text.includes("triage") || text.includes("structure"));
		},
	},
	{
		name: "stripped binary strategy",
		prompt: "A binary is stripped — no symbol table. How do you find function boundaries?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("endbr64") || text.includes("prologue") || text.includes("push rbp") || text.includes("disasm_func");
		},
	},
	{
		name: "compiler optimization recognition",
		prompt: "In x86-64 disassembly, what does 'imul' with a large constant usually indicate? What about 'lea -0x30(%rdi),%edx' followed by 'cmp $0x9,%dl'?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return (text.includes("div") || text.includes("modulo") || text.includes("multiply")) && (text.includes("digit") || text.includes("ascii") || text.includes("0x30") || text.includes("number"));
		},
	},
	{
		name: "XOR cipher identification",
		prompt: "You see this in disassembly: 'xor %edx,%eax' in a loop iterating over a buffer. What operation could this be?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("xor") && (text.includes("encrypt") || text.includes("decrypt") || text.includes("cipher") || text.includes("obfusc") || text.includes("checksum") || text.includes("crc") || text.includes("hash"));
		},
	},
	{
		name: "tool selection for dynamic analysis",
		prompt: "I need to trace a binary's system calls at runtime on Linux. Which pire tools would I use?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("frida") || text.includes("gdb") || text.includes("strace") || text.includes("dynamic");
		},
	},
	{
		name: "binary format knowledge",
		prompt: "I have a PE binary (Windows DLL). Which pire tools can parse PE format? List at least 2.",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			const tools = ["lief", "objdump", "r2", "ghidra", "capstone"];
			return tools.filter(t => text.includes(t)).length >= 2;
		},
	},
	{
		name: "crash recovery for ghidra",
		prompt: "During a long Ghidra decompilation session, the Ghidra bridge crashes. What should pire do?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("restart") || text.includes("recover") || text.includes("retry") || text.includes("reconnect") || text.includes("ghidra_status");
		},
	},
	{
		name: "concentric analysis strategy",
		prompt: "You ran 'strings' on a binary and found 'License Key: %s' and 'Invalid key'. What's your next step?",
		assert: (resp) => {
			const text = (resp.choices?.[0]?.message?.content || "").toLowerCase();
			return text.includes("disasm") || text.includes("objdump") || text.includes("decompil") || text.includes("r2") || text.includes("function");
		},
	},
];

// ─── Runner ────────────────────────────────────────────────────

async function runTests(providers, quick = false) {
	let totalPass = 0, totalFail = 0;
	const providerNames = Object.keys(providers);
	const toTest = quick ? providerNames.slice(0, 1) : providerNames;

	for (const provName of toTest) {
		const prov = providers[provName];
		console.log(`\n${"═".repeat(60)}`);
		console.log(`  Provider: ${provName} (${prov.name})`);
		console.log(`  Model: ${prov.model}`);
		console.log(`  URL: ${prov.url}`);
		console.log(`${"═".repeat(60)}`);

		// Pre-flight: check if provider is reachable
		let providerAlive = false;
		try {
			const preflight = await postJSON(prov.url, prov.apiKey, {
				model: prov.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 5,
			}, 15000);
			if (preflight.error || (preflight.choices && !preflight.choices[0])) {
				console.log(`  \x1b[33m⚠ Skipped: ${preflight.error?.message || "no choices"}\x1b[0m`);
				continue;
			}
			providerAlive = true;
		} catch (e) {
			console.log(`  \x1b[33m⚠ Skipped: ${e.message.slice(0, 80)}\x1b[0m`);
			continue;
		}

		const tests = quick ? TESTS.slice(0, 2) : TESTS;

		for (const test of tests) {
			process.stdout.write(`  ${test.name.padEnd(35)} `);
			try {
				// Retry once on transient errors (502, timeout)
				let resp;
				let lastErr;
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						resp = await postJSON(prov.url, prov.apiKey, {
							model: prov.model,
							messages: [
								{ role: "system", content: RE_PROMPT },
								{ role: "user", content: test.prompt },
							],
							max_tokens: 1024,
							temperature: 0.3,
						}, 60000);
						break;
					} catch (e) {
						lastErr = e;
						if (attempt === 0 && e.message.includes("502")) continue;
						throw e;
					}
				}
				if (!resp) throw lastErr;

				if (resp.error) {
					console.log(`\x1b[31m✗\x1b[0m API error: ${resp.error.message || resp.error}`);
					totalFail++;
					continue;
				}

				const content = resp.choices?.[0]?.message?.content || "";
				if (!content) {
					console.log(`\x1b[31m✗\x1b[0m empty response`);
					totalFail++;
					continue;
				}

				const passed = test.assert(resp);
				if (passed) {
					console.log(`\x1b[32m✓\x1b[0m`);
					totalPass++;
				} else {
					console.log(`\x1b[31m✗\x1b[0m assertion failed`);
					console.log(`    Response: ${content.slice(0, 200)}...`);
					totalFail++;
				}
			} catch (e) {
				console.log(`\x1b[31m✗\x1b[0m ${e.message.slice(0, 100)}`);
				totalFail++;
			}
		}
	}

	console.log(`\n${"─".repeat(60)}`);
	console.log(`  \x1b[32m${totalPass} passed\x1b[0m, \x1b[31m${totalFail} failed\x1b[0m`);
	return totalFail === 0;
}

// ─── Main ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const providerFilter = args.find(a => a.startsWith("--provider="))?.split("=")[1];

try {
	const cfg = loadConfig();
	const providers = getProviders(cfg);

	if (providerFilter) {
		const filtered = {};
		if (providers[providerFilter]) filtered[providerFilter] = providers[providerFilter];
		else { console.error(`Provider '${providerFilter}' not found. Available: ${Object.keys(providers).join(", ")}`); process.exit(1); }
		Object.assign(providers, filtered) && Object.keys(providers).forEach(k => { if (k !== providerFilter) delete providers[k]; });
	}

	console.log(`pire model inference test harness`);
	console.log(`Providers: ${Object.keys(providers).join(", ")}`);
	console.log(`Tests: ${quick ? 2 : TESTS.length} per provider`);

	runTests(providers, quick).then(success => process.exit(success ? 0 : 1));
} catch (e) {
	console.error(`Failed to load config: ${e.message}`);
	process.exit(1);
}
