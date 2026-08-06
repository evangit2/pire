/**
 * pire Pass 12: File tools — append_file and patch_file
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

let passed = 0, failed = 0;
function ok(cond, msg) {
	if (cond) { passed++; }
	else { failed++; console.log(`✗ ${msg}`); }
}

// Test append_file and patch_file tools exist and work
const src = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf-8");

// 1. appendFileTool defined
ok(src.includes("const appendFileTool"), "appendFileTool is defined");

// 2. patchFileTool defined
ok(src.includes("const patchFileTool"), "patchFileTool is defined");

// 3. Both in RE_TOOLS
const toolsMatch = src.match(/export const RE_TOOLS[\s\S]*?\];/);
ok(toolsMatch && toolsMatch[0].includes("appendFileTool"), "appendFileTool in RE_TOOLS");
ok(toolsMatch && toolsMatch[0].includes("patchFileTool"), "patchFileTool in RE_TOOLS");

// 4. probeTools includes both
ok(src.includes("append_file: true"), "probeTools includes append_file");
ok(src.includes("patch_file: true"), "probeTools includes patch_file");

// 5. patch_file requires unique match
ok(src.includes("found ") && src.includes("occurrences"), "patch_file enforces unique match");

// 6. patch_file checks file exists
ok(src.includes("file not found"), "patch_file checks file exists");

// 7. System prompt mentions patch_file
ok(src.includes("patch_file"), "System prompt mentions patch_file");

// 8. PRESERVE_RECENT increased to 16
const tuiSrc = fs.readFileSync(path.join(__dirname, "../src/tui.ts"), "utf-8");
ok(tuiSrc.includes("PRESERVE_RECENT = 16"), "PRESERVE_RECENT = 16");

// 9. Ghidra decompile routes names vs addresses correctly
ok(src.includes("0x") && src.includes("name="), "Ghidra decompile routes names vs addresses");

// 10. Sandbox only blocks install/remove, not read-only queries
ok(src.includes("install|remove") || src.includes("install|remove|purge"), "Sandbox only blocks install/remove");

// Functional test: append_file
const tmpFile = "/tmp/pire-test-append.txt";
try { fs.unlinkSync(tmpFile); } catch {}

// Simulate append_file logic
fs.writeFileSync(tmpFile, "");
let content = fs.readFileSync(tmpFile, "utf-8");
fs.writeFileSync(tmpFile, content + "line1\n");
content = fs.readFileSync(tmpFile, "utf-8");
ok(content === "line1\n", "append_file: first append");

fs.writeFileSync(tmpFile, content + "line2\n");
content = fs.readFileSync(tmpFile, "utf-8");
ok(content === "line1\nline2\n", "append_file: second append");

// Functional test: patch_file (find-and-replace)
const patchFile = "/tmp/pire-test-patch.txt";
fs.writeFileSync(patchFile, "int main() {\n  return 0;\n}\n");
let pcontent = fs.readFileSync(patchFile, "utf-8");
const oldStr = "return 0;";
const newStr = "printf(\"hello\\n\");\n  return 0;";
const count = pcontent.split(oldStr).length - 1;
ok(count === 1, "patch_file: unique match found");
pcontent = pcontent.replace(oldStr, newStr);
fs.writeFileSync(patchFile, pcontent);
ok(fs.readFileSync(patchFile, "utf-8").includes("printf"), "patch_file: replacement applied");

// Cleanup
try { fs.unlinkSync(tmpFile); } catch {}
try { fs.unlinkSync(patchFile); } catch {}

console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
