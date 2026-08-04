# pire

Reverse-engineering agent. Give it a binary, URL, or directory and it figures out what to do. It can triage, decompile, document, reimplement, or whatever the task calls for — not locked to one workflow.

## Quick start

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/evangit2/pire/main/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/evangit2/pire/main/install.ps1 | iex
```

The installer detects your platform and asks which components you want (Wine, Ghidra, Frida, JADX, ILSpy, etc.). Use `--all` for everything, `--core` for just the essentials.

**Then run:**
```bash
pire
```

And just tell it what you need:
```
> analyze /bin/ls and write up what it does
> decompile this binary and reimplement it in C
> what does this firmware image contain?
```

## What it does

pire has 36 RE tools available and picks the right ones based on what you ask for. A typical workflow might include some of:

- **Fetch** — download from URL if needed
- **Auto-detect** — identify file type (PE, ELF, Mach-O, APK, .NET, firmware, archive)
- **Triage** — extract strings, map sections, parse imports/exports
- **Disassemble & decompile** — use Radare2, Ghidra, or format-specific tools
- **Document** — write an `analysis.md` describing behavior
- **Reimplement** — write portable C source matching the original's behavior
- **Verify** — compile and run differential tests

But you can also just ask it to extract strings from a file, check entropy, trace a specific function, or anything else the tools support. The workflow adapts to the task.

## Requirements

- **Node.js** 22+
- **Radare2** (always installed)
- An LLM API endpoint (OpenAI-compatible)

Optional (installer prompts for these):
- **Wine** — run Windows PE binaries on Linux/macOS
- **MinGW-w64** — cross-compile Windows binaries
- **Ghidra** — decompiler (large download)
- **Frida** — dynamic instrumentation
- **GDB** — scripted debugging
- **Binwalk** — firmware extraction
- **JADX** — APK/DEX → Java decompiler
- **ILSpy** — .NET → C# decompiler
- **Yara** — pattern matching
- **Volatility** — memory forensics
- **Python RE tools** — capstone, keystone, unicorn, angr, lief

## Install

### Linux / macOS

```bash
# One-liner
curl -fsSL https://raw.githubusercontent.com/evangit2/pire/main/install.sh | sh

# Or clone and run
git clone https://github.com/evangit2/pire.git
cd pire
./install.sh

# Non-interactive options
./install.sh --all     # install everything
./install.sh --core    # core only (node, npm, git, gcc, radare2)
./install.sh --no-wine # skip wine
```

Supports: Ubuntu/Debian, Fedora/RHEL, Arch Linux, openSUSE, Alpine, macOS (Homebrew), WSL, Windows (Git Bash/MSYS2).

### Windows (PowerShell)

```powershell
# One-liner
irm https://raw.githubusercontent.com/evangit2/pire/main/install.ps1 | iex

# Or clone and run
git clone https://github.com/evangit2/pire.git
cd pire
.\install.ps1 -All      # install everything
.\install.ps1 -CoreOnly # core only
```

Uses winget or Chocolatey for package management.

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

Terminal chat interface. Load a binary with `:load <path>`.

### Autonomous reimplementation

```bash
pire <binary.exe>
```

Runs the full RE pipeline. Output files go in the binary's directory:

- `analysis.md` — analysis of the binary's behavior
- `reimpl.c` — C source reimplementation

## Tools

36 RE tools:

| Tool | Description |
|------|-------------|
| `fetch` | Download files from URLs |
| `extract` | Extract archives (zip, tar, 7z, rar) |
| `filetype` | Identify file type, arch, format |
| `strings` | Extract ASCII/UTF-16 strings |
| `objdump` | Disassemble sections |
| `disasm_func` | Disassemble a single function (handles stripped + PE + ELF) |
| `readelf` | ELF header analysis |
| `hexdump` | Hex dump at an address |
| `nm` | Symbol table listing |
| `size` | Section sizes |
| `search` | Pattern search (text or hex) |
| `patch` | Patch bytes at offset (with backup) |
| `hash` | MD5, SHA1, SHA256 |
| `entropy` | Shannon entropy (detect packing/encryption) |
| `diff` | Compare two files |
| `r2` | Run Radare2 commands (persistent session) |
| `ghidra_*` | Ghidra decompilation, functions, xrefs, strings |
| `capstone` | Multi-arch disassembly |
| `keystone` | Multi-arch assembly |
| `unicorn` | CPU emulation |
| `angr` | Symbolic execution |
| `lief` | Parse ELF/PE/Mach-O |
| `binwalk` | Firmware extraction |
| `yara` | Pattern matching |
| `frida` | Dynamic instrumentation |
| `gdb` | Scripted debugging |
| `jadx` | APK/DEX/JAR → Java decompiler |
| `ilspy` | .NET → C# decompiler |
| `volatility` | Memory forensics |
| `shell` | Run shell commands (sandboxed) |

## Case Study: Reimplementing xxd

Ran pire against [**ckormanyos/xxd**](https://github.com/ckormanyos/xxd) v1.2 — a public hex dump utility with both a Windows binary and open source for verification.

### The target

- **Binary**: `xxd.exe` — 21KB PE32+ executable, MSVC-compiled, 68 functions, 173 strings
- **Source**: 1,188 lines of C (available at the upstream repo for ground-truth verification)
- **Complexity**: Multiple output modes (hex dump, plain hex, C include, binary digits), 15+ command-line flags with interacting behavior (`-l`, `-g`, `-c`, `-s`, `-p`, `-i`, `-b`, `-r`, `-e`, `-E`, `-a`, `-u`, `-d`, `-o`, `-n`)

### How pire was invoked

```bash
WINEPREFIX=~/.wine64 npx tsx packages/re-agent/src/pire-reimpl.ts targets/xxd/xxd.exe
```

The agent gets the binary path and an 80-turn budget.

### The prompt

System prompt defines a 7-phase workflow:

1. **Triage** (turns 1–5): Run `filetype`, `strings`, `r2` to understand the binary
2. **Black-box testing** (turns 5–15): Run the binary with various inputs under Wine, observe outputs
3. **Deep analysis** (turns 10–25): Disassemble key functions, understand the algorithm
4. **Write analysis.md** (by turn 25): Document findings
5. **Write reimpl.c** (by turn 30): Write a C source file replicating the binary's behavior
6. **Test** (turns 30+): Compile with `gcc` and compare outputs against the original
7. **Iterate** (remaining turns): Fix and retest

Deadlines:
- Turn 25: Must write `analysis.md`
- Turn 30: Must write `reimpl.c`
- Turn 40: Non-`write_file` tool calls are blocked
- Turn 80: Final deadline

Prompt guidance:
- Match CRLF line endings (`\r\n`) since Windows binaries produce them
- Match exit codes exactly
- If SIMD/SSE instructions are found, use black-box testing rather than tracing `xmm` registers
- Focus on behavior, not instruction-for-instruction matching

### What the agent did (80 turns)

**Turns 1–3 — Triage**: Ran `filetype` to identify the PE32+ binary, extracted 173 strings (including the version string and PDB path), ran `ls` for directory layout. Started running the binary under Wine with `echo "Hello World" > test.txt`.

**Turns 3–17 — Black-box testing**: Systematically tested every flag:
- Output modes: `-i` (C include), `-ps` (plain hex), `-b` (binary digits), `-e` (little-endian), `-E` (EBCDIC)
- Modifiers: `-l` (length), `-g` (group size: 1, 2, 4, 8), `-c` (columns: 1, 4, 8, 16, 32, 256, 257), `-s` (seek: positive, negative, `+2`), `-o` (display offset), `-u` (uppercase), `-d` (decimal), `-a` (autoskip), `-n` (variable name), `-C` (capitalize)
- Edge cases: empty files, `-l 0`, `-c 0`, `-c 257` (error), `-g 0`, `-g 3` (non-power-of-2 with `-e`), stdin input, nonexistent files, output to file
- Binary data: 256-byte sequential data, null-heavy files, mixed binary content
- Flag interactions: `-b -i` (incompatible), `-b -r` (incompatible), `-e -i` (incompatible), `-ps -r` (reverse), `-b -c 4`, `-i -c 5`, `-d -a`
- Reverse mode: piping hexdump → reverse → original

**Turns 17–58 — Disassembly & analysis**: Used Radare2 to disassemble key functions — hex formatting logic, group/byte swapping for little-endian mode, autoskip (`*`) compression, C include variable name generation from filenames. Identified version string, PDB path, and compiler (MSVC).

**Turn 59**: Wrote `analysis.md` (5,089 bytes).

**Turns 60–67**: Wrote `reimpl.c` (21,851 bytes). Compiled with `gcc`, began differential testing.

**Turns 67–80**: Ran differential tests comparing original vs reimpl:
- Plain hex dump: matched
- `-ps` plain hex: matched
- `-i` C include: matched
- `-b` binary digits: matched
- 256-byte binary: matched
- Multiple flag combinations: matched

### Post-run verification

28 additional differential tests. Three issues found and fixed:

1. **`-p` alias**: Original accepts both `-p` and `-ps`; reimpl only handled `-ps`
2. **`-i` trailing comma**: Original omits the comma after the last byte
3. **`-b` default columns**: Binary mode defaults to 6, not 16

After fixes: **28/28 tests byte-identical**.

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

Files in `targets/xxd/`.

## Testing

```bash
node packages/re-agent/test/test-suite.cjs
```

Covers tool registration, lazy loading, system prompt structure, agent loop mechanics, deadline enforcement, decompile integration, SIMD/SSE guidance, CRLF/exit code matching.

## Architecture

```
pire/
├── packages/
│   ├── re-agent/          # Core RE agent
│   │   ├── src/
│   │   │   ├── index.ts       # Tool registry (36 tools)
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
├── install.sh             # Cross-platform installer (Linux/macOS/WSL)
├── install.ps1            # Windows installer (PowerShell)
└── .github/workflows/     # CI + release pipelines
```

## How it works

LLM loop with tool-call deadlines:

1. **Turns 1-25**: Triage, black-box testing, disassembly, decompilation
2. **Turn 25**: Soft deadline — write `analysis.md`
3. **Turn 30**: Soft deadline — write `reimpl.c`
4. **Turn 40**: Hard deadline — non-`write_file` tool calls are blocked
5. **Turns 40-80**: Compile, test, iterate
6. **Turn 80**: Final deadline

Prompt guidance covers SIMD/SSE handling, CRLF matching, exit codes, and error message matching.

## Token efficiency

~5,000 tokens initial input per chat session:

| Component | Tokens |
|----------|--------|
| System prompt | ~1,100 |
| Tool schemas (36 tools) | ~3,800 |
| TUI context | ~150 |
| **Total initial input** | **~5,000** |
| Output cap (`max_tokens`) | 8,192 |

Comparable agentic frameworks typically run 15,000–30,000+ input tokens per message.

## License

MIT
