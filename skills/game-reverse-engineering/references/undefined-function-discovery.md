# Finding Undefined Functions via Byte Pattern Scanning

When Ghidra's auto-analysis fails to define functions at addresses that have xrefs (e.g., CALL targets referenced from data sections or vtable entries), you can't decompile them directly. Here's the technique to find and define them.

## Problem

`get_xrefs_to()` returns addresses like `0x43F722 [UNCONDITIONAL_CALL]`, but `get_function_by_address()` returns "No function found." The xref address is the CALL instruction itself, not a function entry point — and the containing function wasn't auto-defined by Ghidra.

## Method

1. **Read raw bytes** around the xref address using `read_memory()`. Read 512+ bytes in chunks starting from the nearest known function boundary.

2. **Search for SEH prologues** in the hex dump. The standard MSVC SEH pattern is:
   ```
   6A FF                  PUSH -1           (2 bytes)
   68 xx xx xx xx          PUSH handler     (5 bytes)
   64 A1 00 00 00 00       MOV EAX, FS:[0]  (6 bytes)
   50                      PUSH EAX         (1 byte)
   64 89 25 00 00 00 00    MOV FS:[0], ESP   (7 bytes)
   ```
   Search for the byte sequence `6AFF64a100000000` (or `6aff68` for the shorter PUSH -1 + PUSH imm32 prefix).

3. **Also search for RET + NOP padding** — function boundaries often have `C3` (RET) followed by `90 90 90 90` (NOP padding) then the next function's prologue.

4. **Verify the CALL instruction** at the xref address. A CALL is `E8` + 4-byte relative offset. Compute: `target = call_addr + 5 + rel32` to confirm it matches the known function address.

5. **Create the function** at the discovered prologue address using `create_function()` with `disassemble_first=true`.

6. **Decompile** the newly created function to understand its logic.

## Example (target application)

`Ball_Shatter` (0x408D70) had 2 xrefs: `0x43F722` and `0x43FE36`. Neither was inside a defined function. Steps taken:

1. Read 512 bytes at `0x43F2E0` — found RET + 7 NOPs at `0x43F2E8`, then SEH prologue at `0x43F3C0`
2. Created function at `0x43F3C0` — body size 1369 bytes (0x43F3C0–0x43F919)
3. Confirmed `0x43F722` is within this range — decompiled as `Breaker_Update`
4. Read next chunk at `0x43F900` — found SEH prologue at `0x43F930`
5. Created function at `0x43F930` — body size 2638 bytes
6. Confirmed `0x43FE36` is within this range — decompiled as `Bonkbash_Update`

## Pitfall: Creating function at CALL address

Do NOT `create_function()` at the xref address itself — that's the CALL instruction, not a function entry. The function entry is at the SEH prologue found by scanning backward. Always delete accidentally-misplaced functions and recreate at the correct prologue.

## Tip: Batch read_memory for efficiency

Read 512 bytes at a time and scan the hex string in Python for multiple patterns simultaneously:
- `6aff64a100000000` — SEH prologue (PUSH -1 / MOV EAX,FS:[0])
- `6aff68` — PUSH -1 / PUSH imm32 (start of SEH frame setup)
- `c3909090` — RET followed by NOP padding (function boundary)
