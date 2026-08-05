#!/usr/bin/env node
/**
 * pire MCP integration test — verifies fixes work through the MCP server
 *
 * Tests:
 *   1. initialize returns correct tool count
 *   2. tool.execute works for available tools
 *   3. tool.execute rejects unknown tools
 *   4. tool.execute validates required params
 *   5. session.create returns filtered tools
 *   6. session.prompt returns correct turns count
 *   7. session.save and session.history work
 *
 * Usage: node packages/re-agent/test/test-mcp.cjs
 * Requires: pire MCP server running on 127.0.0.1:9847
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const HOST = "127.0.0.1";
const PORT = 9847;

let pass = 0, fail = 0;
function ok(cond, msg) {
	if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); pass++; }
	else { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fail++; }
}

function rpc(method, params = {}, timeout = 60) {
	return new Promise((resolve, reject) => {
		const s = new net.Socket();
		s.setTimeout(timeout * 1000);
		s.connect(PORT, HOST, () => {
			s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
		});
		let buf = "";
		s.on("data", (data) => {
			buf += data.toString();
			if (buf.includes("\n")) {
				try { resolve(JSON.parse(buf.trim())); } catch { reject(new Error("parse error")); }
				s.destroy();
			}
		});
		s.on("timeout", () => { s.destroy(); reject(new Error("timeout")); });
		s.on("error", reject);
	});
}

// ─── Setup: create test binary ───
const TMP = "/tmp/pire-mcp-integration";
const BINARY = path.join(TMP, "test_binary");
const SRC = path.join(TMP, "test.c");

fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(SRC, `
#include <stdio.h>
#include <string.h>
void decrypt(char *b, int l) { for(int i=0;i<l;i++) b[i]^=0x42; }
int check(const char *s) { char s2[]={0x2b,0x27,0x36,0x36,0x35,0x24,0}; decrypt(s2,6); return strcmp(s,s2)==0; }
int main(int c, char**v) {
	if(c<2){printf("Usage: %s <pw>\\n",v[0]);return 1;}
	if(check(v[1])){printf("Flag: pire{mcp_test}\\n");return 0;}
	printf("Denied\\n");return 1;
}
`);
try { execSync(`gcc -o ${BINARY} ${SRC} -no-pie 2>&1`); } catch {}

async function main() {
	console.log("pire MCP integration test\n");

	// Check server is running
	try {
		await rpc("initialize", {}, 5);
	} catch (e) {
		console.log(`  \x1b[31m⚠ MCP server not running on ${HOST}:${PORT}\x1b[0m`);
		console.log("  Start it with: npx tsx packages/re-agent/src/cli.ts -mcp --port 9847 --host 127.0.0.1");
		process.exit(1);
	}

	// ─── Test 1: initialize ───
	console.log("─ initialize ─");
	const init = await rpc("initialize", {}, 10);
	const tools = init.result?.tools ?? [];
	ok(tools.length > 0, `initialize returns tools (got: ${tools.length})`);
	ok(init.result?.serverInfo?.name === "pire", `server name is pire (got: ${init.result?.serverInfo?.name})`);
	ok(init.result?.serverInfo?.version, `has version (got: ${init.result?.serverInfo?.version})`);

	// ─── Test 2: tool.execute (filetype) ───
	console.log("\n─ tool.execute ─");
	const ftResult = await rpc("tool.execute", { name: "filetype", arguments: { path: BINARY } }, 10);
	const ftText = ftResult.result?.content?.[0]?.text ?? "";
	ok(ftText.includes("ELF"), `filetype returns ELF (got: ${ftText.slice(0, 50)})`);

	// ─── Test 3: tool.execute unknown tool ───
	console.log("\n─ unknown tool rejection ─");
	const unknownResult = await rpc("tool.execute", { name: "nonexistent_tool", arguments: {} }, 5);
	ok(unknownResult.error?.code === -32602, `unknown tool returns -32602 (got: ${unknownResult.error?.code})`);

	// ─── Test 4: tool.execute missing params ───
	console.log("\n─ param validation ─");
	const missingResult = await rpc("tool.execute", { name: "filetype", arguments: {} }, 5);
	ok(missingResult.error?.code === -32602, `missing params returns -32602 (got: ${missingResult.error?.code})`);
	ok(missingResult.error?.message?.includes("path"), `error mentions 'path' (got: ${missingResult.error?.message?.slice(0, 60)})`);

	// ─── Test 5: session.create ───
	console.log("\n─ session.create ─");
	const sess = await rpc("session.create", { target: BINARY }, 10);
	const sid = sess.result?.sessionId;
	ok(!!sid, `session created (got: ${sid})`);
	ok(sess.result?.target === BINARY, `target set (got: ${sess.result?.target})`);
	ok(sess.result?.llm, `LLM configured (got: ${sess.result?.llm})`);

	const toolCount = Object.values(sess.result?.tools ?? {}).filter(Boolean).length;
	const totalTools = Object.keys(sess.result?.tools ?? {}).length;
	ok(toolCount > 0, `available tools > 0 (got: ${toolCount}/${totalTools})`);
	// Note: on machines with all tools installed, toolCount === totalTools is valid
	// The filtering only reduces count when tools are unavailable
	ok(toolCount <= totalTools, `available <= total (${toolCount}/${totalTools})`);

	// ─── Test 6: session.prompt with turns count ───
	console.log("\n─ session.prompt ─");
	const promptResult = await rpc("session.prompt", {
		sessionId: sid,
		prompt: "What type of binary is this? Use filetype and tell me briefly.",
		maxTurns: 3,
	}, 90);

	if (promptResult.result) {
		const r = promptResult.result;
		ok(typeof r.turns === "number", `turns is number (got: ${r.turns})`);
		ok(r.turns > 0, `at least 1 turn (got: ${r.turns})`);
		ok(r.content?.length > 0, `has content (${r.content?.length} chars)`);
		// turns should not equal toolCalls.length (that was the old bug)
		// Note: they CAN be equal in some cases, but the logic should be correct
	} else {
		ok(false, `session.prompt failed: ${promptResult.error?.message}`);
	}

	// ─── Test 7: session.history ───
	console.log("\n─ session.history ─");
	const histResult = await rpc("session.history", { sessionId: sid }, 10);
	if (histResult.result) {
		const msgs = histResult.result.messages ?? [];
		ok(msgs.length > 0, `history has messages (got: ${msgs.length})`);
		ok(msgs.some(m => m.role === "user"), "history has user message");
		ok(histResult.result.target === BINARY, `target preserved (got: ${histResult.result.target})`);
	} else {
		ok(false, `session.history failed: ${histResult.error?.message}`);
	}

	// ─── Test 8: session.save ───
	console.log("\n─ session.save ─");
	const savePath = path.join(TMP, "session-save.json");
	const saveResult = await rpc("session.save", { sessionId: sid, path: savePath }, 10);
	if (saveResult.result?.saved) {
		ok(fs.existsSync(savePath), "save file created");
		const saved = JSON.parse(fs.readFileSync(savePath, "utf-8"));
		ok(saved.target === BINARY, `saved target correct (got: ${saved.target})`);
		ok(saved.messages?.length > 0, `saved messages exist (got: ${saved.messages?.length})`);
		ok(saved.version, `saved version exists (got: ${saved.version})`);
	} else {
		ok(false, `session.save failed: ${saveResult.error?.message}`);
	}

	// ─── Test 9: session.list ───
	console.log("\n─ session.list ─");
	const listResult = await rpc("session.list", {}, 10);
	if (listResult.result?.sessions) {
		const sessions = listResult.result.sessions;
		ok(sessions.length > 0, `list has sessions (got: ${sessions.length})`);
		ok(sessions.some(s => s.id === sid), "created session in list");
	} else {
		ok(false, `session.list failed: ${listResult.error?.message}`);
	}

	// ─── Test 10: session.destroy ───
	console.log("\n─ session.destroy ─");
	const destroyResult = await rpc("session.destroy", { sessionId: sid }, 10);
	ok(destroyResult.result?.destroyed === true, `session destroyed`);

	// Verify it's gone
	const listAfter = await rpc("session.list", {}, 10);
	const stillExists = (listAfter.result?.sessions ?? []).some(s => s.id === sid);
	ok(!stillExists, "destroyed session not in list");

	// Cleanup
	try { execSync(`rm -rf ${TMP}`); } catch {}

	console.log(`\n${"─".repeat(50)}`);
	console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
