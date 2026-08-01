# objdump Fallback: Disassemble Without GhidraMCP

When GhidraMCP is down (port 8089 refused) and you need to disassemble
a crash address **right now**, use `objdump` on the original EXE.
This is fast (~1s), requires no Ghidra server, and works on any PE binary.

## When to Use

- GhidraMCP server is down and restarting it is taking too long
- You need a quick disassembly around a crash address
- You need to verify what instructions are at a specific address

## Command

```bash
# Disassemble 0x60 bytes around a crash address (Intel syntax)
objdump -d -M intel \
  --start-address=0x49A480 \
  --stop-address=0x49A560 \
  ~/the target-re/originals/installed/extracted/target_binary.exe
```

Output format: `ADDR:  BYTES  INSTRUCTION` — same as Ghidra disassembly
but without function names, labels, or decompilation.

## PE Crash Address Conversion

target application crash reports give: `CRASH_ADDRESS: 0001:0009A4EA`

- `0001` = PE section index (section 1 = `.text`)
- `0009A4EA` = RVA (relative virtual address)
- Absolute address = ImageBase + RVA = `0x400000 + 0x9A4EA = 0x49A4EA`

The EXE's image base is `0x400000` (standard for 32-bit PE). Verify with:
```bash
objdump -p ~/the target-re/originals/installed/extracted/target_binary.exe | grep ImageBase
```

## Limitations vs GhidraMCP

| Feature | objdump | GhidraMCP |
|---------|---------|-----------|
| Disassembly | ✅ | ✅ |
| Function names | ❌ (raw addresses) | ✅ |
| Decompilation (C) | ❌ | ✅ |
| Cross-references | ❌ | ✅ |
| Speed | ~1s | ~1s per function |
| Requires server | No | Yes |

**Strategy:** Use objdump for immediate crash diagnosis when the server
is down. Use GhidraMCP for deeper analysis (function identification,
decompilation, xrefs). The two are complementary, not substitutes.

## GhidraMCP Startup Troubleshooting

If the server is down, the correct restart command is in the SKILL.md
"One-Line Start" section. Common failures when trying alternatives:

- `analyzeHeadless` alone does NOT start the MCP HTTP server — it only
  runs analysis scripts. The MCP plugin must be loaded via the Java
  classpath approach in the SKILL.md.
- Ghidra GUI via Xvfb (`ghidraRun`) exits immediately without starting
  the MCP HTTP server in headless environments.
- OSGi script compilation (`-postScript`) fails with `ClassNotFoundException`
  on Ghidra 12.0.4 for Java scripts placed in `/tmp` — the OSGi classloader
  can't find them. Python/Jython scripts may also fail with "Invalid script".
- **Do NOT spend 10+ minutes trying to restart GhidraMCP.** If the
  one-line start command from SKILL.md doesn't work, pivot to objdump
  for immediate needs and debug the server issue separately.
