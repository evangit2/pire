# Quick Verification Commands

Run these in order to confirm the headless server is healthy, the program is loaded, and decompilation works end-to-end. Use these after startup or after any restart/update.

## 1. Health check
```bash
curl -s http://127.0.0.1:8089/health
```
Expected:
```json
{"status":"healthy","version":"5.2.0-headless","program_loaded":true,"program_name":"target_binary.exe"}
```

## 2. Rename coverage
```bash
curl -s http://127.0.0.1:8089/compare_programs_documentation | jq '.programs[0].documentation_percent'
```
Expected: `99.5` or similar (varies by project). If it drops to ~40 %, the project was re-imported and renames were lost — restore from backup first.

## 3. List a few functions
```bash
curl -s "http://127.0.0.1:8089/list_functions?limit=10"
```
Expected: plain text, one line per function:
```
Vec3_Copy at 00401010
Vec3_Init at 00401040
...
```

## 4. Decompile by address
```bash
curl -s "http://127.0.0.1:8089/decompile_function?address=0x4278E0" | head
```
Expected: full C decompilation (not an error JSON).

## 5. Pattern search (no dedicated search endpoint in headless)
```bash
curl -s "http://127.0.0.1:8089/list_functions?limit=5000" | grep -i "input" | head
```
Expected: filtered list of matching function names and addresses.

---

If any step returns `404` or `{"error":...}`, check the log (`tail -20 /tmp/ghidra-mcp.log`) and refer to the "If Program Not Loaded" section in the main skill.
