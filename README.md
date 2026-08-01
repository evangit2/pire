# pire

Autonomous reverse-engineering agent that analyzes Windows PE binaries and produces clean C reimplementations.

## What it does

Give pire a compiled Windows `.exe` and it will:

1. **Triage** — identify file type, extract strings, map sections
2. **Black-box test** — run the binary under Wine with various inputs, observe outputs
3. **Disassemble & decompile** — use Radare2 to trace through functions and understand algorithms
4. **Document** — write a detailed `analysis.md` describing the binary's behavior
5. **Reimplement** — write a portable C source file (`reimpl.c`) that matches the original's behavior
6. **Verify** — compile the reimplementation, run differential tests against the original

## Quick start

```bash
# Install dependencies
./install.sh

# Run the agent on a binary
pire targets/cfgmerge/cfgmerge.exe

# Or use the reimplementation pipeline directly
npx tsx packages/re-agent/src/pire-reimpl.ts targets/imggen/imggen.exe
```

## Requirements

- **Node.js** 22+
- **Radare2** 6.0+
- **Wine** (with a 64-bit prefix)
- **MinGW-w64** cross-compiler (`x86_64-w64-mingw32-gcc`)
- **GCC** (native, for compiling reimplementations)
- An LLM API endpoint (OpenAI-compatible)

## Install

```bash
git clone https://github.com/evangit2/pire.git
cd pire
./install.sh
```

The install script supports Ubuntu/Debian, Fedora/RHEL, Arch Linux, and macOS (via Homebrew).

## Configuration

pire reads LLM configuration from one of these methods (in order):

1. `PIRE_CONFIG` environment variable (path to a YAML config file)
2. `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL` environment variables

Example using environment variables:

```bash
export OPENAI_API_KEY="your-key-here"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4o"
```

Alternatively, set `PIRE_MODEL` to override the model name:

```bash
export PIRE_MODEL="your-preferred-model"
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WINEPREFIX` | Wine prefix directory | `~/.wine` |
| `PIRE_CONFIG` | Path to LLM config file (YAML) | — |
| `PIRE_MODEL` | Override model name | `gpt-4o` |
| `OPENAI_API_KEY` | LLM API key | — |
| `OPENAI_BASE_URL` | LLM API base URL | — |
| `OPENAI_MODEL` | Model name | `gpt-4o` |

## Usage

### Interactive TUI

```bash
pire
```

Launches a chat-first terminal interface. Load a binary with `:load <path>`.

### Autonomous reimplementation

```bash
pire <binary.exe>
```

Runs the full RE pipeline autonomously. Output files are written to the binary's directory:

- `analysis.md` — detailed analysis of the binary's behavior
- `reimpl.c` — C source reimplementation

## Tools

The agent has access to 25+ RE tools:

| Tool | Description |
|------|-------------|
| `filetype` | Identify file type |
| `strings` | Extract ASCII/UTF-16 strings |
| `sections` | List PE sections |
| `imports` | List imported functions |
| `exports` | List exported functions |
| `disasm` | Disassemble at an address |
| `disasm_func` | Disassemble a function |
| `decompile` | Radare2 pseudo-C decompilation (pdc) |
| `r2` | Run arbitrary Radare2 commands |
| `hexdump` | Hex dump at an address |
| `shell` | Run shell commands (wine, gcc, diff, etc.) |
| `write_file` | Save files (source code, analysis) |
| `readelf` | ELF header analysis |
| `objdump` | Object file disassembly |
| `nm` | Symbol table listing |
| ... | and more |

## Test targets

The repo includes several compiled Windows binaries for testing:

| Target | Difficulty | Description |
|--------|-----------|-------------|
| `targets/cfgmerge/cfgmerge.exe` | Medium | INI config file parser (count, get, set, checksum) |
| `targets/imggen/imggen.exe` | Hard | BMP image generator (solid, gradient, checker, rect, circle, noise) |

### Successful reimplementations

- **cfgmerge.exe** — Fully reimplemented. All 4 commands (count, get, set, checksum) match byte-for-byte, including CRLF line endings and exit codes.

## Testing

```bash
# Run the full test suite
node packages/re-agent/test/test-suite.cjs
```

Tests cover:
- Tool registration and lazy loading
- System prompt structure and guidance
- Agent loop mechanics (max turns, deadline enforcement)
- Decompile tool integration
- SIMD/SSE handling guidance
- CRLF/exit code matching guidance

## Architecture

```
pire/
├── packages/
│   ├── re-agent/          # Core RE agent
│   │   ├── src/
│   │   │   ├── index.ts       # Tool registry (25+ tools)
│   │   │   ├── pire-reimpl.ts # Autonomous RE pipeline
│   │   │   ├── cli.ts         # CLI entry point
│   │   │   └── tui.ts         # Interactive TUI
│   │   └── test/
│   │       └── test-suite.cjs # CI test suite
│   ├── coding-agent/      # General-purpose coding agent
│   ├── ai/                # LLM abstraction layer
│   ├── client/            # API client
│   ├── server/            # Local server
│   └── ghidra-mcp/        # Ghidra MCP integration
├── targets/               # Test binaries
│   ├── cfgmerge/
│   └── imggen/
├── install.sh             # Cross-platform installer
└── .github/workflows/ci.yml  # CI pipeline
```

## How it works

The agent uses an LLM-powered loop with hard tool-call deadlines:

1. **Turns 1-25**: Triage, black-box testing, disassembly, decompilation
2. **Turn 25**: Soft deadline — write `analysis.md`
3. **Turn 30**: Soft deadline — write `reimpl.c`
4. **Turn 40**: Hard deadline — non-`write_file` tool calls are blocked
5. **Turns 40-80**: Compile, test, iterate on the reimplementation
6. **Turn 80**: Final deadline

The agent streams LLM responses and includes guidance for:
- SIMD/SSE instruction handling (use black-box testing instead of tracing xmm registers)
- CRLF line ending matching (Windows binaries use `\r\n`)
- Exit code matching
- Error message exact matching

## License

MIT
