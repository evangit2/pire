---
name: re-bootstrap-workflow
category: reverse-engineering
description: Bootstrap workflow for reverse engineering a Windows game/application binary — project setup, asset acquisition, format discovery, and Ghidra analysis initiation.
---

# Reverse Engineering Project Bootstrap

> Adapted from the target-specific RE toolkit for general binary analysis.

## Overview

Systematic workflow for starting a new RE project on a Windows binary (game/app). Ensures no steps are missed and all artifacts are preserved for compound progress across sessions.

## Step-by-Step Workflow

### 1. Project Workspace Setup
```
project-re/
├── originals/          # Preserved, never-modified source files
│   ├── installer/
│   └── installed/
├── analysis/
│   ├── ghidra/
│   ├── logs/
│   └── screenshots/
├── docs/               # RESEARCH_LOG, FUNCTION_MAP, etc.
├── reimpl/             # Reimplementation source tree
│   ├── src/
│   ├── include/
│   └── assets/
└── notes/
```

### 2. Acquire & Hash Everything
- Download all original binaries/assets
- Compute MD5 + SHA256 of EVERY file before any modification
- Save to `docs/FILE_HASHES.json` — this is your integrity baseline
- Keep originals in `originals/` — NEVER modify these

### 3. Binary Quick Analysis (before Ghidra)
Run these over the main executable:
```bash
# File type
file <exe>

# Strings extraction — multiple passes
strings <exe> | grep -i '\.dll'      # DLL dependencies
strings <exe> | grep -iE '\.(mesh|xml|cfg|wav|ogg)'  # file format refs
strings <exe> | grep -iE 'direct|d3d|opengl'        # graphics APIs
strings <exe> | grep -E '^[A-Z][a-zA-Z]+::'        # C++ class names
strings <exe> | grep -iE 'menu|level|race|score'     # game logic strings

# PE analysis (install pefile)
python3 -c "import pefile; pe=pefile.PE('<exe>'); ..."
```

### 4. PE Structure Key Checks
- Image base address (for Ghidra rebasing)
- Entry point RVA
- Section layout (names + sizes reveal packing/unusual layouts)
- Import table — list ALL DLLs and key functions
- Resource section — icons, version info, embedded data
- Sections with unusual names may indicate packed/encrypted code

### 5. Custom File Format Reverse Engineering
For unknown binary formats:
- Hex dump first 256-512 bytes
- Look for: magic bytes, length prefixes, null-terminated strings, float arrays (0x3F800000 = 1.0f, 0x40000000 = 2.0f)
- Strings in format headers often name object types (e.g., "PLATFORM", "CAMERALOOKAT")
- Float patterns: look for `00 00 80 3F` (=1.0f) repeated — these are often transformation matrices or scale vectors
- Parse incrementally: identify one field, then reinterpret remaining bytes

### 6. Config/File Analysis
- XML configs: parse fully, document schema
- Binary configs: look for version stamps, known strings, fixed-size records
- Save game formats: compare before/after state changes

### 7. Ghidra Import & Analysis
```bash
/opt/ghidra/support/analyzeHeadless <project_dir> <project_name> \
  -import <binary> -overwrite
```
- This runs auto-analysis (takes minutes for large binaries)
- After completion, connect to Ghidra instance via MCP for decompilation

### 8. Documentation — Create These Files Immediately
- `RESEARCH_LOG.md` — chronological findings
- `FILE_HASHES.json` — integrity hashes
- `FUNCTION_MAP.md` — known functions and their purposes
- `STRUCTS_AND_TYPES.md` — discovered data structures
- `RUNTIME_ENVIRONMENT.md` — DLL deps, registry keys, env vars
- `TODO.md` — next steps, blockers, hypotheses

### 9. Key Patterns for Game RE
- DirectX era: D3D8/D3D9 for rendering, DirectInput for input, DirectSound/BASS for audio
- Game loop: `PeekMessageA` → `GetTickCount`/`QueryPerformanceCounter` timing → render → repeat
- Level formats usually start with a count, then repeated structures with type identifiers
- Mesh formats often contain: vertex count, face count, texture coordinates, normals (3 floats each)
- Physics: look for velocity/acceleration vectors, collision detection strings

### 10. Binary Format String-Scan Technique

When reverse-engineering a binary file format where objects have variable-length data that depends on type, and you can't determine object boundaries from structure alone, use a **two-pass string scan**.

**The problem:** Sequential parsing fails when you don't know the size of each object's data block. Different object types have different data sizes, and there's no explicit size field.

**The solution:**
1. **Pass 1: Collect all strings.** Scan for length-prefixed strings (`[uint32 length][string bytes]`). Strings between 2-60 bytes that match known type names or texture filenames are reliable anchors.
2. **Pass 2: Build objects from string adjacency.** Type strings (START, FLAG, PLATFORM, etc.) create new objects. Texture strings (.png, .bmp) are properties of the previous object. The bytes between a type string and the next string contain position, transform, material, and index data.

**Key insights:**
- Length-prefixed strings create parseable boundaries in an otherwise opaque binary blob
- Don't try sequential parsing — if you hit an unclassifiable string, you'll lose alignment
- Use inter-string gaps to infer structure — the gap size tells you how much data each type carries
- Verify with the smallest test file first
- Handle null-padding: type strings may be null-padded to their declared length — always split on `\0`
- Float vs int ambiguity: look for `0x3F800000` (=1.0f) patterns to identify identity transforms and float fields

### 11. Wine Testing Setup
```bash
# Install Wine
sudo apt install wine wine32
# Run the game (may need DLL overrides)
WINEDEBUG=+loaddll wine <exe> 2>&1 | tee wine_log.txt
# Check for missing DLLs
```

## Lessons Learned
- Always hash files FIRST before any analysis — you'll need to verify originals later
- `objdump -x` gives better PE section info than manual parsing for quick checks
- Custom binary formats in older games often use simple patterns: int32 count, then repeated fixed-size or string-prefixed records
- The BASS audio library (.mo3 format) is common in small 2000s Windows games
- MESHWORLD format: starts with object count (int32), each object has a name string (null-terminated padded to next field), then position/rotation/scale as float32 triples, followed by type-specific data
- MESH format: int32 version, int32 num_objects, then objects with name + transform matrices, then vertex/face data sections marked with MESH_ prefixes

## Pitfalls
- Don't skip hashing — you'll regret it when trying to verify reimplementation accuracy
- Don't assume the installer and installed zip have identical files — check both
- Binary save formats often use fixed-size name fields (null-padded to 64 bytes) — don't try to parse as text
- Scene files reference mesh files by name — they're a scene format, not standalone geometry
