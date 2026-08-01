#!/usr/bin/env node
/**
 * pire end-to-end test — real binary analysis with model inference
 *
 * Creates a small test binary, runs actual RE tools on it, then asks
 * the model to analyze the results. Verifies the full pipeline:
 * binary → tool execution → model reasoning → structured output.
 *
 * Usage: node packages/re-agent/test/test-e2e.cjs
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const http = require("http");
const https = require("https");

const TMP = "/tmp/pire-e2e";
const BINARY = path.join(TMP, "test_binary");
const SRC = path.join(TMP, "test.c");

// ─── Config ────────────────────────────────────────────────────

function loadProvider() {
	const cfg = fs.readFileSync(process.env.PIRE_CONFIG || path.join(process.env.HOME, ".pire", "config.yaml"), "utf-8");
	const getUrl = (m) => m ? cfg.match(new RegExp(`\\b${m}:\\s*(.+)`))?.[1]?.trim().replace(/['"]/g, "") : null;
	return {
		url: cfg.match(/base_url:\s*(.+)/)?.[1]?.trim().replace(/['"]/g, "").replace(/\/$/, "") + "/chat/completions",
		apiKey: cfg.match(/api_key:\s*(.+)/)?.[1]?.trim().replace(/['"]/g, ""),
		model: cfg.match(/default:\s*(.+)/)?.[1]?.trim().replace(/['"]/g, ""),
	};
}

function postJSON(url, apiKey, body, timeoutMs = 60000) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const lib = parsed.protocol === "https:" ? https : http;
		const data = JSON.stringify(body);
		const req = lib.request(parsed, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "Content-Length": Buffer.byteLength(data) },
			timeout: timeoutMs,
		}, (res) => {
			let body = "";
			res.on("data", (c) => body += c);
			res.on("end", () => {
				if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); } }
				else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
			});
		});
		req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
		req.on("error", reject);
		req.write(data); req.end();
	});
}

async function postWithRetry(url, apiKey, body, timeoutMs = 60000, retries = 2) {
	let lastErr;
	for (let i = 0; i <= retries; i++) {
		try { return await postJSON(url, apiKey, body, timeoutMs); }
		catch (e) {
			lastErr = e;
			if (i < retries && (e.message.includes("502") || e.message.includes("timeout"))) {
				await new Promise(r => setTimeout(r, 2000));
				continue;
			}
			throw e;
		}
	}
	throw lastErr;
}

// ─── Test binary ───────────────────────────────────────────────

function createTestBinary() {
	fs.mkdirSync(TMP, { recursive: true });
	// Simple C program with identifiable strings and functions
	const cCode = `
#include <stdio.h>
#include <string.h>

void decrypt_flag(char *buf, int len) {
    for (int i = 0; i < len; i++) buf[i] ^= 0x42;
}

int check_password(const char *input) {
    char secret[] = {0x2b, 0x27, 0x36, 0x36, 0x35, 0x24, 0x00};
    decrypt_flag(secret, 6);
    return strcmp(input, secret) == 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("Usage: %s <password>\\n", argv[0]);
        return 1;
    }
    if (check_password(argv[1])) {
        printf("Access granted! Flag: pire{test_flag_12345}\\n");
        return 0;
    }
    printf("Access denied.\\n");
    return 1;
}
`;
	fs.writeFileSync(SRC, cCode);
	execSync(`gcc -o ${BINARY} ${SRC} -no-pie 2>&1`, { encoding: "utf-8" });
	return fs.existsSync(BINARY);
}

// ─── Tools (inline execution) ─────────────────────────────────

function run(cmd, timeout = 30000) {
	return execSync(cmd, { encoding: "utf-8", timeout, maxBuffer: 5 * 1024 * 1024, stderr: "pipe" }).trim();
}

function shEscape(s) { return `'${s.replace(/'/g, "'\\''")}'`; }

// ─── Tests ─────────────────────────────────────────────────────

let pass = 0, fail = 0;
function ok(cond, msg) {
	if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); pass++; }
	else { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fail++; }
}

async function main() {
	console.log("pire end-to-end binary analysis test\n");

	// 1. Create test binary
	console.log("─ Setup ─");
	ok(createTestBinary(), "test binary compiled");

	// 2. Run RE tools
	console.log("\n─ Tool Execution ─");

	const fileOutput = run(`file ${BINARY}`);
	ok(fileOutput.includes("ELF"), `filetype: ${fileOutput.slice(0, 60)}`);

	const stringsOutput = run(`strings -a -n 4 ${BINARY}`);
	ok(stringsOutput.includes("Access granted"), "strings: found 'Access granted'");
	ok(stringsOutput.includes("password"), "strings: found 'password' reference");
	ok(stringsOutput.includes("pire{"), "strings: found flag pattern");

	const readelfOutput = run(`readelf -h ${BINARY}`);
	ok(readelfOutput.includes("Entry point"), "readelf: got entry point");

	const objdumpOutput = run(`objdump -d ${BINARY}`);
	ok(objdumpOutput.includes("<main>:"), "objdump: found main function");
	ok(objdumpOutput.includes("<check_password>:"), "objdump: found check_password function");
	ok(objdumpOutput.includes("<decrypt_flag>:"), "objdump: found decrypt_flag function");

	// r2 analysis
	const r2Output = run(`r2 -qc 'aaa; afl' ${BINARY}`, 60000);
	ok(r2Output.includes("main"), "r2: found main function");
	ok(r2Output.length > 50, `r2: analysis output (${r2Output.length} chars)`);

	// 3. Model inference on tool output
	console.log("\n─ Model Analysis ─");

	const prov = loadProvider();
	const systemPrompt = `You are pire, a reverse engineering agent. Analyze the binary analysis results and provide insights.`;

	// Test 1: Identify binary type from tool output
	const resp1 = await postWithRetry(prov.url, prov.apiKey, {
		model: prov.model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: `A reverse engineering tool produced this output:\n\n\`\`\`\n${fileOutput}\n\`\`\`\n\nWhat type of binary is this? What architecture?` },
		],
		max_tokens: 2048, temperature: 0.2,
	}, 30000);

	const text1 = resp1.choices?.[0]?.message?.content || "";
	ok(text1.toLowerCase().includes("elf"), `model identifies ELF binary (${resp1.choices?.[0]?.message?.content?.slice(0, 40) || "empty"}...)`);

	// Test 2: Identify functionality from strings
	const resp2 = await postWithRetry(prov.url, prov.apiKey, {
		model: prov.model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: `Strings extracted from a binary:\n\`\`\`\n${stringsOutput.slice(0, 500)}\n\`\`\`\nWhat does this binary likely do? What is the flag?` },
		],
		max_tokens: 2048, temperature: 0.2,
	}, 30000);

	const text2 = resp2.choices?.[0]?.message?.content || "";
	ok(text2.toLowerCase().includes("password") || text2.toLowerCase().includes("access"), "model identifies password-checking functionality");
	ok(text2.includes("pire{test_flag_12345}"), "model extracts the flag from strings");

	// Test 3: Analyze disassembly
	const mainDisasm = objdumpOutput.split("<main>:")[1]?.split("\n\n")[0] || "";
	const resp3 = await postWithRetry(prov.url, prov.apiKey, {
		model: prov.model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: `Here is the disassembly of the main function:\n\`\`\`asm\n${mainDisasm.slice(0, 1000)}\n\`\`\`\nWhat functions does main call? What is the control flow?` },
		],
		max_tokens: 2048, temperature: 0.2,
	}, 30000);

	const text3 = resp3.choices?.[0]?.message?.content || "";
	ok(text3.toLowerCase().includes("check_password") || text3.toLowerCase().includes("password") || text3.toLowerCase().includes("call"), "model identifies function calls from disassembly");

	// Test 4: XOR decryption analysis
	const decryptDisasm = objdumpOutput.split("<decrypt_flag>:")[1]?.split("\n\n")[0] || "";
	const resp4 = await postWithRetry(prov.url, prov.apiKey, {
		model: prov.model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: `Here is the disassembly of decrypt_flag:\n\`\`\`asm\n${decryptDisasm}\n\`\`\`\nWhat crypto operation is this function performing? What is the key?` },
		],
		max_tokens: 4096, temperature: 0.2,
	}, 60000);

	const text4 = resp4.choices?.[0]?.message?.content || "";
	ok(text4.toLowerCase().includes("xor"), "model identifies XOR operation");
	ok(text4.includes("0x42") || text4.includes("42") || text4.toLowerCase().includes("0x42"), "model identifies XOR key 0x42");

	// Test 5: disasm_func tool execution on stripped binary
	console.log("\n─ Stripped Binary + disasm_func ─");

	// Build a stripped version
	const STRIPPED = BINARY + "_stripped";
	try {
		execSync(`gcc -O2 -s -o ${STRIPPED} ${SRC} -no-pie 2>&1`, { encoding: "utf-8" });
	} catch {
		execSync(`cp ${BINARY} ${STRIPPED} && strip ${STRIPPED}`, { encoding: "utf-8" });
	}
	ok(fs.existsSync(STRIPPED), "stripped binary created");

	const strippedFile = run(`file ${STRIPPED}`);
	ok(strippedFile.includes("stripped"), "file confirms binary is stripped");

	// Verify no user symbols (PLT/dynamic symbols don't count)
	let strippedSyms = "0";
	try { strippedSyms = run(`readelf -s ${STRIPPED} 2>/dev/null | grep -c 'FUNC.*LOCAL' || true`); } catch {}
	ok(parseInt(strippedSyms) <= 3, `stripped binary has minimal local symbols (${strippedSyms} FUNC LOCAL)`);

	// Find function starts via endbr64 in .text section only
	const textDisasm = run(`objdump -d ${STRIPPED} 2>/dev/null | sed -n '/Disassembly of section .text:/,/Disassembly of section .fini:/p'`);
	const funcStarts = [];
	for (const line of textDisasm.split("\n")) {
		if (line.includes("endbr64") && /^\s+[0-9a-f]+:/.test(line)) {
			const addr = line.trim().split(":")[0];
			funcStarts.push(addr);
		}
	}
	ok(funcStarts.length >= 2, `found ${funcStarts.length} function starts in .text via endbr64`);

	// Extract a function using disasm_func approach
	if (funcStarts.length >= 1) {
		// Use the first function in .text (usually main or _start)
		const targetAddr = funcStarts[0];
		const stopAddr = "0x" + (parseInt(targetAddr, 16) + 8192).toString(16);
		const funcDisasm = run(`objdump -d --start-address=0x${targetAddr} --stop-address=${stopAddr} ${STRIPPED} 2>/dev/null`);

		// Simulate disasm_func: collect until next endbr64
		const funcLines = [];
		for (const line of funcDisasm.split("\n")) {
			if (line.startsWith("/") || line.includes("file format") || line.trim() === "") continue;
			if (line.includes("Disassembly of section")) continue;
			if (line.includes("<.text") || line.includes("<.init") || line.includes("<.fini")) continue;
			if (line.includes("endbr64") && funcLines.length > 0) break;
			funcLines.push(line);
		}
		// Trim trailing nops/padding
		while (funcLines.length > 0 && (/	nop/.test(funcLines[funcLines.length - 1]) || /	xchg/.test(funcLines[funcLines.length - 1]) || funcLines[funcLines.length - 1].trim() === "")) {
			funcLines.pop();
		}

		const instrCount = funcLines.filter(l => /^\s+[0-9a-f]+:/.test(l)).length;
		const exitCount = funcLines.filter(l => /	ret/.test(l) || /	jmp/.test(l)).length;
		ok(instrCount > 5, `disasm_func extracted ${instrCount} instructions from stripped binary`);
		ok(exitCount >= 1, `disasm_func found ${exitCount} ret/jmp exit(s) in function`);

		// Model should be able to analyze the stripped function
		const resp5 = await postWithRetry(prov.url, prov.apiKey, {
			model: prov.model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: `This is a function extracted from a stripped ELF binary using disasm_func. Analyze what it does:\n\n\`\`\`asm\n${funcLines.join("\n").slice(0, 2000)}\n\`\`\`\n\nWhat does this function do? List any function calls you see.` },
			],
			max_tokens: 2048, temperature: 0.2,
		}, 30000);

		const text5 = resp5.choices?.[0]?.message?.content || "";
		ok(text5.length > 50, `model analyzed stripped function (${text5.length} chars)`);
		ok(text5.toLowerCase().includes("call") || text5.toLowerCase().includes("function"), "model identifies function calls in stripped code");
	}

	// Test 6: License checker analysis (if available)
	console.log("\n─ License Checker Analysis ─");

	const licenseBin = "/tmp/pire-targets/license_checker";
	if (fs.existsSync(licenseBin)) {
		// Run triage tools
		const licFile = run(`file ${licenseBin}`);
		ok(licFile.includes("ELF"), "license_checker is ELF");

		const licStrings = run(`strings -a -n 6 ${licenseBin} 2>/dev/null | grep -iE '(license|secret|key|version|usage|valid|invalid)' | head -10`);
		ok(licStrings.length > 0, "license_checker has interesting strings");

		const licReadelf = run(`readelf -d ${licenseBin} 2>/dev/null | grep NEEDED`);
		ok(licReadelf.includes("libc"), "license_checker links libc");

		// Model should identify license checker from strings
		const resp6 = await postWithRetry(prov.url, prov.apiKey, {
			model: prov.model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: `Strings from an unknown binary:\n\`\`\`\n${licStrings}\n\`\`\`\nWhat does this binary likely do?` },
			],
			max_tokens: 1024, temperature: 0.2,
		}, 30000);

		const text6 = resp6.choices?.[0]?.message?.content || "";
		ok(text6.toLowerCase().includes("license") || text6.toLowerCase().includes("key") || text6.toLowerCase().includes("valid"), "model identifies license checker from strings");
	} else {
		console.log("  (skipped — license_checker not built)");
	}

	// Test 7: Multi-stage workflow simulation
	console.log("\n─ Multi-Stage Workflow ─");

	// Stage 1: Triage
	const triageFile = run(`file ${BINARY}`);
	const triageStrings = run(`strings -a -n 4 ${BINARY} | head -10`);
	ok(triageFile.includes("ELF"), "Stage 1: filetype identifies ELF");
	ok(triageStrings.length > 0, "Stage 1: strings extracted");

	// Stage 2: Structure
	const stage2Disasm = run(`objdump -d ${BINARY} 2>/dev/null | head -50`);
	ok(stage2Disasm.includes("Disassembly"), "Stage 2: disassembly produced");

	// Model should be able to describe the workflow
	const resp7 = await postWithRetry(prov.url, prov.apiKey, {
		model: prov.model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: `I'm analyzing a binary. Stage 1 results:\nfiletype: ${triageFile}\nstrings (top 10):\n${triageStrings}\n\nBased on Stage 1, what should I do in Stage 2?` },
		],
		max_tokens: 1024, temperature: 0.2,
	}, 30000);

	const text7 = resp7.choices?.[0]?.message?.content || "";
	ok(text7.toLowerCase().includes("disasm") || text7.toLowerCase().includes("objdump") || text7.toLowerCase().includes("function") || text7.toLowerCase().includes("r2"), "model suggests Stage 2 structural analysis");

	// Summary
	console.log(`\n${"─".repeat(50)}`);
	console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);

	// Cleanup
	try { execSync(`rm -rf ${TMP}`); } catch {}

	process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
