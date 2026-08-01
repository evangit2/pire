# pire

**Pi + Reverse Engineering** — a fork of the [Pi](https://github.com/earendil-works/pi) agent framework, specialized for analyzing closed-source binaries.

## Architecture

pire replaces Pi's MCP server model with **native agent tools** — Ghidra and Radare2 are not external MCP servers, they're built into the agent as first-class tools with crash recovery and auto-start. All other RE tools (binwalk, angr, capstone, etc.) are lazy auto-detecting wrappers that gracefully degrade if the underlying binary/module isn't installed.

### Native Tools (22 total)

**Core (always available via system tools):**
- `strings` — Extract printable strings
- `filetype` — Identify file type/architecture
- `objdump` — Disassemble ELF/PE sections
- `readelf` — ELF headers, symbols, relocations
- `hexdump` — Raw hex dump
- `r2` — Radare2 commands (aaa; afl, pdf @ main, iz)

**Ghidra (native bridge, crash-resilient, auto-starts):**
- `ghidra_status` — Check connectivity
- `ghidra_decompile` — Decompile functions
- `ghidra_functions` — List all functions
- `ghidra_rename` — Rename functions/variables
- `ghidra_xrefs` — Cross-references to address
- `ghidra_strings` — Search strings in project

**Disassembly & Emulation:**
- `capstone` — Multi-arch disassembly
- `keystone` — Multi-arch assembly (instructions → bytes)
- `unicorn` — CPU emulation (load + step through code)
- `angr` — Symbolic execution (CFG, path finding, constraints)

**Binary Parsing & Forensics:**
- `lief` — Parse ELF/PE/Mach-O (imports, exports, sections, headers)
- `binwalk` — Firmware/embedded file extraction
- `yara` — Pattern matching / signature scanning
- `volatility` — Memory forensics

**Dynamic Analysis:**
- `frida` — Dynamic instrumentation (spawn, attach, trace)
- `gdb` — Scripted debugging

### Crash Recovery

The `GhidraBridge` class:
- Health-checks via `/health` before every API call
- Auto-starts the bundled bridge script if the server is down
- Tracks restart count (max 3 attempts before giving up)
- Reads `GHIDRA_SERVER_URL` env var for custom endpoints

### Auto-Detection

Every wrapper checks at execute time:
- CLI tools: `which(binwalk)` etc.
- Python modules: `python3 -c "import capstone"`
- Returns install instructions if missing, never crashes

## TUI

Lean RE dashboard — not a full coding agent TUI. Launch with `pire <binary>`:

```
┌──────────────────────────────────────────────┐
│ pire v0.2.0  │  target: /bin/ls  │  22 tools  │
├──────────────┼───────────────────────────────┤
│ Tools        │  Output                        │
│ ✓ strings    │  filetype → ELF 64-bit LSB     │
│ ✓ filetype   │  strings → /lib64/ld-linux...   │
│ ✓ r2         │                                │
│ ✗ binwalk    │                                │
│ ✓ capstone   │                                │
├──────────────┴───────────────────────────────┤
│ > strings /bin/ls                            │
└──────────────────────────────────────────────┘
```

TUI commands: `:tools`, `:probe`, `:skills`, `:help`, `:quit`, or type any tool name + args.

## Quick Start

```bash
# Install dependencies
npm install --ignore-scripts

# Build Pi core packages
npm run build

# Start TUI on a binary
npx tsx packages/re-agent/src/cli.ts /bin/ls

# Or use CLI flags
npx tsx packages/re-agent/src/cli.ts --tools
npx tsx packages/re-agent/src/cli.ts --probe
npx tsx packages/re-agent/src/cli.ts --skills
```

### Using Ghidra

1. Open your binary in Ghidra
2. Start the Ghidra MCP plugin (BridgeMCPghidraScript)
3. pire auto-detects the bridge at `http://127.0.0.1:8089/`

Or set `GHIDRA_SERVER_URL` to point to a remote bridge.

### Optional Tool Installation

```bash
# Python RE tools (pick what you need)
pip install lief capstone keystone-engine unicorn yara-python
pip install angr                    # heavy — symbolic execution
pip install frida-tools             # dynamic instrumentation
pip install volatility3             # memory forensics
pip install binwalk                 # firmware extraction

# System tools
sudo apt install gdb radare2 binwalk
```

## Test Suite

```bash
# All tests
npm test --workspace @earendil-works/pi-re-agent

# Individual suites
node packages/re-agent/test/test-suite.cjs    # Source structure + tool registry (69 tests)
node packages/re-agent/test/test-models.cjs   # Real model inference via Hermes (6 tests)
node packages/re-agent/test/test-e2e.cjs      # End-to-end binary analysis (17 tests)
```

The model tests use providers from `~/.hermes/config.yaml` — GLM-5.2 via VT ARC. The e2e test compiles a real test binary with a XOR-encrypted flag, runs tools on it, then asks the model to identify the encryption and key.

## Project Structure

```
pire/
├── packages/
│   ├── ai/                 # LLM provider abstraction
│   ├── agent/              # Agent core
│   ├── tui/                # Pi TUI framework (upstream)
│   ├── client/             # Client library
│   ├── server/             # Server mode
│   ├── coding-agent/       # Coding agent
│   ├── protocol/           # Wire protocol
│   ├── storage/sqlite-node/# Storage
│   ├── ghidra-mcp/         # Ghidra MCP bridge script
│   └── re-agent/           # pire — native RE tools, TUI, CLI
│       └── src/
│           ├── index.ts    # Tool definitions, GhidraBridge, system prompt
│           ├── cli.ts      # CLI entry point
│           └── tui.ts      # Lean RE dashboard TUI
├── skills/                 # 25 RE skills
└── package.json
```

## Attribution

Based on [Pi](https://github.com/earendil-works/pi) by earendil-works.
Ghidra MCP bridge by [LaurieWired](https://github.com/LaurieWired/GhidraMCP).

## License

Inherits Pi's license. See original repository for details.
