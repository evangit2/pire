# Vtable Slot Verification via Xref Data

## The Trap: Manual Byte Decoding of Vtable Blocks

When determining which function pointer occupies a specific vtable slot (e.g.,
vtable[33] at offset 0x84), the intuitive approach is to read a block of memory
from the vtable address and manually decode the 4-byte little-endian pointers.
**This is error-prone and has caused major misattributions.**

### What Went Wrong (sess10029)

An analysis of target application's 15 level board vtables attempted to identify which
function each level used for vtable[33] (the dynamic object creation slot at
offset 0x84). The approach was:

1. Read 144 bytes (36 entries × 4 bytes) from each board's vtable address
2. Manually compute offset 0x84 = byte index 132
3. Decode the 4-byte pointer at that offset
4. Match against known function addresses

This produced **completely wrong results** — it appeared that 11 of 15 levels
shared just 3 functions. The user immediately flagged this as wrong because
the decompiled code for those "shared" functions only referenced objects from
one specific level each.

### The Fix: Use Xref Data Instead

The correct approach is to use `get_xrefs_to` on each candidate function address:

```
get_xrefs_to(0x0040A5F0) → "From 004d0914 [DATA]"
```

A `[DATA]` xref from a vtable address proves which vtable references the function.
When each function has exactly ONE `[DATA]` xref, it means each is referenced from
exactly one vtable — confirming every level has its own unique function.

### Why Manual Byte Decoding Failed

The 144-byte vtable dump contains all 36 entries packed together. Computing the
correct byte offset for a specific slot requires:
- Knowing the exact vtable start address
- Correctly computing `slot_index × 4` as a byte offset
- Reading the correct 4 bytes at that offset
- Handling any alignment or padding issues

A small offset miscalculation (e.g., reading at byte 128 instead of 132) silently
returns the wrong function pointer — one that happens to be a valid function but
belongs to a different vtable slot. There's no crash or error to signal the
mismatch.

### Correct Verification Procedure

1. **Decompile the function** to understand what it does
2. **Get xrefs to the function address** via `get_xrefs_to`
3. **Match xref source addresses** against known vtable addresses
4. **Confirm**: each function should have exactly one `[DATA]` xref from a vtable
5. **If multiple vtables reference the same function** — THEN it's genuinely shared
6. **If the user says "are you sure?"** — always re-verify via xrefs, never trust
   manual byte decoding

### User Correction Signal

When the user asks "Are you sure this function is used by [levels X, Y, Z]?"
after you've presented a vtable analysis, this is a strong signal that your
vtable slot mapping may be wrong. Immediately switch to xref-based verification
rather than re-reading the same byte blocks.

### Real Example

**Wrong claim**: "FUN_0040A5F0 is shared by Dizzy, Sky, and Neon" (based on
manual byte decoding of vtable blocks)

**Correct finding** (via xrefs):
- `0x0040A5F0` (Dizzy_CreateDynamicObjects) → xref from `0x004D0914` only (Dizzy vtable)
- `0x00410AD0` (Sky_CreateDynamicObjects) → xref from `0x004D104C` only (Sky vtable)
- `0x00416910` (Neon_CreateDynamicObjects) → xref from `0x004D1E74` only (Neon vtable)

Every level has its OWN unique vtable[33] function. None are shared (except
WarmUp and Beginner, which genuinely share one no-op function).
