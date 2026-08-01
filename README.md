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
pire targets/xxd/xxd.exe

# Or use the reimplementation pipeline directly
npx tsx packages/re-agent/src/pire-reimpl.ts targets/xxd/xxd.exe
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

Alternatively, create `~/.pire/config.yaml`:

```yaml
base_url: https://api.openai.com/v1
api_key: your-key-here
model: gpt-4o
```

Set `PIRE_MODEL` to override the model at runtime:

```bash
export PIRE_MODEL="your-preferred-model"
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WINEPREFIX` | Wine prefix directory | `~/.wine` |
| `PIRE_CONFIG` | Path to LLM config file (YAML) | `~/.pire/config.yaml` |
| `PIRE_MODEL` | Override model name | From config |
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

## Case Study: Reimplementing xxd

To demonstrate pire's capabilities on a real-world target, we ran it against [**ckormanyos/xxd**](https://github.com/ckormanyos/xxd) v1.2 — a public hex dump utility with both a Windows binary and open source available for verification.

### The target

- **Binary**: `xxd.exe` — 21KB PE32+ executable, MSVC-compiled, 68 functions, 173 strings
- **Source**: 1,188 lines of C (available at the upstream repo for ground-truth verification)
- **Complexity**: Multiple output modes (hex dump, plain hex, C include, binary digits), 15+ command-line flags with interacting behavior (`-l`, `-g`, `-c`, `-s`, `-p`, `-i`, `-b`, `-r`, `-e`, `-E`, `-a`, `-u`, `-d`, `-o`, `-n`)

### How pire was invoked

```bash
WINEPREFIX=~/.wine64 npx tsx packages/re-agent/src/pire-reimpl.ts targets/xxd/xxd.exe
```

That's it — a single command. No manual hints, no human-in-the-loop. The agent receives the binary path and an 80-turn budget.

### The prompt

The agent is given a system prompt establishing it as an expert reverse engineer with a structured workflow:

> You are an expert reverse engineer. Your goal is to FULLY reverse engineer a binary and produce a working open-source reimplementation.

The prompt defines a 7-phase workflow:

1. **Triage** (turns 1–5): Run `filetype`, `strings`, `r2` to understand the binary
2. **Black-box testing** (turns 5–15): Run the binary with various inputs under Wine, observe outputs
3. **Deep analysis** (turns 10–25): Disassemble key functions, understand the algorithm
4. **Write analysis.md** (by turn 25): Document findings
5. **Write reimpl.c** (by turn 30): Write a C source file replicating the binary's behavior
6. **Test** (turns 30+): Compile with `gcc` and compare outputs against the original
7. **Iterate** (remaining turns): Fix and retest

The prompt enforces hard deadlines:
- Turn 25: Must write `analysis.md`
- Turn 30: Must write `reimpl.c`
- Turn 40: Non-`write_file` tool calls are blocked — only writing and testing allowed
- Turn 80: Final deadline

Key guidance in the prompt:
- Match CRLF line endings (`\r\n`) since Windows binaries produce them
- Match exit codes exactly
- If SIMD/SSE instructions are found, use black-box testing rather than tracing `xmm` registers
- Focus on behavior, not instruction-for-instruction matching

### What the agent did (80 turns)

**Turns 1–3 — Triage**: The agent ran `filetype` to identify the PE32+ binary, extracted 173 strings (including the version string and PDB path), and ran `ls` to understand the directory layout. It immediately started running the binary under Wine with a simple `echo "Hello World" > test.txt` input.

**Turns 3–17 — Black-box testing**: This was the most intensive phase. The agent systematically tested every flag:
- Output modes: `-i` (C include), `-ps` (plain hex), `-b` (binary digits), `-e` (little-endian), `-E` (EBCDIC)
- Modifiers: `-l` (length), `-g` (group size: 1, 2, 4, 8), `-c` (columns: 1, 4, 8, 16, 32, 256, 257), `-s` (seek: positive, negative, `+2`), `-o` (display offset), `-u` (uppercase), `-d` (decimal), `-a` (autoskip), `-n` (variable name), `-C` (capitalize)
- Edge cases: empty files, `-l 0`, `-c 0`, `-c 257` (error), `-g 0`, `-g 3` (non-power-of-2 with `-e`), stdin input, nonexistent files, output to file
- Binary data: 256-byte sequential data, null-heavy files, mixed binary content
- Flag interactions: `-b -i` (incompatible), `-b -r` (incompatible), `-e -i` (incompatible), `-ps -r` (reverse), `-b -c 4`, `-i -c 5`, `-d -a`
- Reverse mode: piping hexdump → reverse → original

**Turns 17–58 — Disassembly & analysis**: The agent used Radare2 to disassemble key functions, understand the hex formatting logic, group/byte swapping for little-endian mode, the autoskip (`*`) compression algorithm, and the C include variable name generation from filenames. It identified the version string, PDB path, and compiler (MSVC).

**Turn 59 — Analysis written**: The agent wrote `analysis.md` (5,089 bytes) documenting all flags, behaviors, edge cases, and algorithms.

**Turns 60–67 — Reimplementation**: The agent wrote `reimpl.c` (21,851 bytes) — a complete C implementation covering all output modes and flags. It compiled successfully with `gcc` and began differential testing.

**Turns 67–80 — Testing & iteration**: The agent ran differential tests comparing original vs reimplementation output:
- Plain hex dump: matched
- `-ps` plain hex: matched
- `-i` C include: matched
- `-b` binary digits: matched
- 256-byte binary: matched
- Multiple flag combinations: matched

The agent continued testing edge cases through the final turn, verifying byte-level output with `xxd | head` and `cat -A` comparisons.

### Post-run verification

After the agent completed, we ran an additional 28 differential tests covering all output modes, flag combinations, binary files, and edge cases. Three minor issues were found and fixed:

1. **`-p` alias**: The original accepts both `-p` and `-ps` as synonyms; the reimpl only handled `-ps`
2. **`-i` trailing comma**: The original omits the comma after the last byte; the reimpl was adding one
3. **`-b` default columns**: Binary mode defaults to 6 columns, not 16

After these fixes, **all 28 tests produce byte-identical output**.

### Results

| Metric | Value |
|--------|-------|
| Binary size | 21 KB |
| Source lines (original) | 1,188 |
| Functions analyzed | 68 |
| Agent turns used | 80 / 80 |
| Reimpl size | 21,851 bytes |
| Analysis size | 5,089 bytes |
| Differential tests | 28 / 28 byte-identical |

The reimplementation and analysis files are in `targets/xxd/`.

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
│   └── xxd/               # Real-world target (ckormanyos/xxd v1.2)
├── install.sh             # Cross-platform installer
└── .github/workflows/     # CI + release pipelines
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
