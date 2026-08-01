# C DLL Mod Code Review — Common Bug Patterns

Patterns found reviewing the LevelFeatures_Loader v6 mod (sess14954).
These are recurring bug categories that are easy to miss in large C mods
that replicate game internals.

## 1. Float-to-Int Cast Losing IEEE 754 Bits

**Bug:** Storing float values into int arrays via `(int)floatVar` converts
the float to an integer (e.g., `100.0f → 100 = 0x64`). When the game reads
the memory back as a float, it gets `1.4e-43 ≈ 0` — silently wrong, no crash.

```c
// WRONG — badball spawns at (0,0,0) instead of intended position
bb[0x59] = (int)spawnX;        // 100.0f → 100 → game reads as ~0.0f

// CORRECT — store IEEE 754 bit pattern directly
memcpy(&bb[0x59], &spawnX, sizeof(int));
```

**Detection:** Grep for `(int)` casts on float variables assigned to int
pointer slots. Also check for `*(int*)&floatVar` which triggers
`-Wstrict-aliasing` under MinGW — prefer `memcpy`.

## 2. Calling Convention Mismatches Between Duplicate Typedefs

**Bug:** Same game function gets two typedefs with different calling
conventions. One call site corrupts registers silently.

**Detection without Ghidra:** Disassemble the first bytes from the binary:

```python
# MOV ESI, ECX  →  __thiscall (this in ECX, params on stack)
# MOV EDX, [ESP+4]  →  __fastcall (2nd param in EDX)
# MOV EAX, [ESP+4]  →  __cdecl (all params on stack)
```

**Rule:** Never have two typedefs for the same function with different
calling conventions.

## 3. State Zeroing Before File-Open Check

**Bug:** Config-loading zeroes global state before checking if file exists.
If file is locked/missing, all state wiped and stays zeroed.

```c
// WRONG
memset(g_state, 0, sizeof(g_state));
HANDLE h = CreateFileA(...);
if (h == INVALID_HANDLE_VALUE) return;  // state already zeroed!

// CORRECT
HANDLE h = CreateFileA(...);
if (h == INVALID_HANDLE_VALUE) return;  // preserves existing state
memset(g_state, 0, sizeof(g_state));  // safe to zero now
```

## 4. Dead Feature Flags

**Bug:** Feature flag defined in enum, assigned in defaults, listed in
names array — but never checked in the dispatch function.

**Detection:** For each `FEAT_*` enum value, grep the dispatch function for
`if (features & FEAT_*)`. Any flag without a check is dead code.

## 5. Wrong-Array Write in Vtable Patching

**Bug:** When patching multiple vtable slots with separate save-original
arrays, slot N's save code writes to slot M's array.

**Detection:** Verify each save block writes to the correct array variable
matching its slot's purpose.

## 6. Odd RVA Legitimacy

MSVC-compiled code does NOT align function entries to even addresses. An
odd RVA like 0xBA57B is normal if the prologue is valid (e.g., `PUSH ESI;
MOV ESI, [ESP+8]`). Don't reject odd RVAs — only be suspicious of addresses
mid-function (check for valid prologue).

## Verification Script Pattern

After fixes, create a temporary `/tmp/hermes-verify-*.sh` script checking
each fix via grep + MinGW build with -Wall:

```bash
i686-w64-mingw32-gcc -shared -o /tmp/test.dll "$SRC" ... -Wall 2>/tmp/build.log
[ ! -s /tmp/build.log ] && echo "✅ Zero warnings"
grep -q 'memcpy(&bb\[0x5A\]' "$SRC" && echo "✅ Fix #1" || echo "❌ Fix #1"
```

This is ad-hoc verification, not a test suite.
