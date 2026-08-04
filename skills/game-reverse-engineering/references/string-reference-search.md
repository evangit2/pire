# String Reference Search Technique

Find all code that checks for a specific string in a Windows binary.

## Method

1. **Find the string in .rdata**: Search the binary file for the ASCII bytes of the target string.
2. **Calculate its VA**: `VA = image_base + RVA`. For sections where `RVA == RawPtr` (common for .rdata), `VA = image_base + file_offset`.
3. **Search for the VA as a DWORD**: Pack the VA as little-endian 4 bytes (`struct.pack('<I', va)`) and search the entire .text section for occurrences.
4. **Classify each hit**:
   - `0x68` before the DWORD → `PUSH imm32` (push string pointer onto stack)
   - `0xB8-0xBF` before → `MOV reg, imm32` (load string pointer into register)
   - `0xC7 0x44 0x24` before → `MOV [esp+X], imm32` (store to stack slot)
5. **Check surrounding code** for the `__strnicmp` call pattern:
   - `push <length>` → comparison length
   - `push <string_va>` → the string to compare against
   - `push <name_ptr>` → the runtime name to check
   - `call __strnicmp` → the comparison function
   - This identifies prefix-match string comparisons used for collision event dispatch.

## Example: N:BUMPER Analysis (sess1868)

**Goal**: Determine if N:BUMPER is a universal or per-level collision event.

**Step 1**: Found "N:BUMPER" at file offset 0xCFD34 in target_binary.exe.
- .rdata: RVA=0xCF000, RawPtr=0xCF000 → VA = 0x400000 + 0xCFD34 = 0x4CFD34

**Step 2**: Searched .text for `struct.pack('<I', 0x4CFD34)` → found 5 hits, all `PUSH` instructions:
- VA 0x00410463, 0x004111F9, 0x004128B2, 0x00413E09, 0x00415029

**Step 3**: Disassembled code around VA 0x0041045B:
```
6A 08              push 8           ; length = 8
68 34 FD 4C 00     push 0x4CFD34   ; "N:BUMPER"
51                 push ecx        ; meshbuffer name
E8 0A 72 0B 00     call __strnicmp
83 C4 0C           add esp, 12     ; cleanup 3 args
85 C0              test eax, eax   ; check result
0F 85 C9 01 00 00  jnz skip         ; jump if NOT matched
```

**Step 4**: Also found format string "N:BUMPER%d" at VA 0x4CFC9A — the game uses `sprintf` to create numbered bumper names like "N:BUMPER1" through "N:BUMPER5".

**Conclusion**: N:BUMPER is checked via `__strnicmp(name, "N:BUMPER", 8)` — a prefix match. Both "N:BUMPER" (8 chars) and "N:BUMPER1" (9 chars) match. But only 5 level collision handlers contain this check. Arena-WarmUp's handler does NOT — so adding N:BUMPER geometry to Arena-WarmUp produces collision but no bounce effect.

## Key Insight

This technique distinguishes **universal events** (referenced in `DispatchCollisionEvents` at 0x40C5D0) from **per-level events** (referenced only in specific level vtable[29] handlers). The number of string references tells you how many levels support that event.
