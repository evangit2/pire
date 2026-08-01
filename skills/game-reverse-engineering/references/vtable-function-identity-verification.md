# Vtable-Based Function Identity Verification

Before trusting a Ghidra function name (especially `_Render`, `_Update`, `_Tick` suffixes), verify the function's identity by tracing its vtable slot.

## Method

1. **Find the constructor** that sets the vtable: search for `MOV [reg], &vtable_addr` patterns (e.g., `*(undefined ***)this = &PTR_FUN_004d47b8` in decompilation).
2. **Read the vtable** at the address set by the constructor (4 bytes per slot, little-endian).
3. **Match the slot index** to the function in question:
   - Slot [0] = destructor
   - Slot [1] = Update/Tick
   - Slot [2] = Render
   - Slot [3]+ = class-specific methods
4. **Cross-reference**: the constructor's `UIList_AddItem` calls reveal the class identity (e.g., "WARM-UP ARENA" items = Arena menu, not Tournament menu).

## Pitfall — Misidentified vtable slot

A function named `Foo_Render` may actually belong to a completely different class if the vtable was misidentified during initial analysis. Always trace: constructor → vtable address → slot [N] → function pointer. If the constructor adds items like "ARENA" or "RODENT RUMBLE", the render function is NOT a Tournament menu render, regardless of what Ghidra named it.

## Example (target application)

`0x432D20` was named `TourneyMenu_Render` but is actually `ArenaLevelSelect_Render` — the Arena/Rodent Rumble level selection screen. The real `TourneyMenu_Render` is at `0x450AF0` (vtable[2] of `0x4D83F0`, set by `TourneyMenu_ctor` at `0x4FDA0`). The Arena constructor at `0x42FC40` sets vtable `0x4D47B8` and adds items like "WARM-UP ARENA", "BEGINNER ARENA" — confirming it's the Arena menu, not the Tournament between-races screen.

## When a misidentification is found

1. Rename in Ghidra immediately
2. Search ALL repo files for the old name + address (`grep -rn OldName_0xADDR repo/`)
3. Update these locations (all must be synced):
   - `docs/decompilation/FUNCTION_MAP.md`
   - `analysis/ghidra/renames_backup.json`
   - `analysis/ghidra/decompilations/batch_auto/` (rename the .c file)
   - `hbremap/index.html`
   - `hbremap/content/docs_decompilation_FUNCTION_MAP.md` (generated copy — easy to miss!)
   - Any other docs referencing the function (`grep -rn` to find them all)
4. Add a correction note in docs that previously referenced the old name, explaining what it was renamed to and why
5. Save Ghidra program, commit and push to all remotes
6. **Verification pitfall**: when writing ad-hoc verification scripts that grep markdown tables, use `grep -F` (fixed-string) not regex — the `|` pipe characters in markdown tables are regex alternation operators and will cause false failures.
