# §23 Decompile Before Drawing Conclusions from ASM Patterns

When analyzing complex floating-point logic in raw disassembly (especially FCOMP/FNSTSW/TEST patterns),
ALWAYS decompile the full function via Ghidra before drawing conclusions. Raw ASM dot-product patterns
can be misread without the full decompiled context — and a misread at iteration 1 can cascade into
further misreads at iteration 2 if you trust your own prior wrong analysis instead of going back to the
decompiled source.

## Case Study: SpatialTree_TestFace Three-Iteration Misread (Session 20998)

The `SpatialTree_TestFace` function at 0x463E20 (per-face swept-sphere test) went through **three
wrong iterations** before the correct analysis was reached:

### Iteration 1 — WRONG: "Backface culling gate"
Read the ASM at 0x4640ca as `dot(face_normal, velocity) < 0` and concluded it was a backface culling
gate that prevents type-2 entries when the ball is on the back side of a triangle. This led to an
incorrect claim that "LGP freezes during wall slides." User corrected: "The game does not have
double-sided walls."

### Iteration 2 — WRONG: "Double-sided walls"
After user correction, looked for how back-side hits could still create entries. Concluded the level
geometry must have double-sided walls (triangles facing both inward and outward). User corrected again:
"The game does not have double-sided walls. Please re-evaluate."

### Iteration 3 — CORRECT: "No backface culling at all"
Finally did `create_function` at 0x463E20 → `decompile_function` → read the full decompiled C.
Discovered:
1. **Distance check** uses `Vec3_DotDiffAbs` — **absolute value**, symmetric, does not discriminate
   which side the ball is on
2. **Velocity gate** (the only directional filter) uses `<= 0` — passes when `dot ≈ 0` (falling
   perpendicular to wall normal, or sliding along a wall)
3. The supposed "Gate 2 / face-normal check" was actually a **point-in-triangle edge test**
   (dot product of edge-like vectors), NOT a normal-vs-normal alignment check

There is **NO backface culling** anywhere in the function. The swept sphere simply does not check
which side the ball approaches from. Wall slides create type-2 entries every frame (dot ≈ 0 → passes
`<= 0`). Clip-through from the wrong side while falling also passes (velocity downward, wall normal
horizontal → dot ≈ 0 → passes).

### Root cause of all three errors
Each iteration trusted the *previous iteration's wrong framing* instead of going back to the
decompiled source. The ASM FPU stack tracking (st0/st1/FCOMP/FNSTSW/TEST patterns) is extremely
error-prone for multi-dot-product functions. The decompiled C makes the logic obvious in seconds.

## Ghidra Vtable Indirect Call Pitfall

Ghidra may not auto-discover functions called via vtable indirection. If `get_function_by_address`
returns "No function found," use `create_function` at the address first, THEN decompile. The
`SpatialTree_TestFace` at 0x463E20 was not auto-discovered because it's only called via
`call [eax+0x1C]` (vtable[7] indirect call).

## Rule

`create_function` → `decompile_function` → read the decompiled C → cross-reference against raw ASM.
Never draw conclusions about gate semantics from FCOMP/TEST/JNP patterns alone.

If a user corrects your analysis ("that's wrong" / "please re-evaluate"), do NOT iterate on your
own wrong framing — go back to step 1: `create_function` + `decompile_function` if you haven't
already, or re-read the decompiled C more carefully. A correction means your mental model is wrong,
not that you need to patch one wrong detail with another wrong detail.

## Also Decompile Helper Functions

When the decompiled code calls helper functions (`Vec3_DotDiff`, `Vec3_DotDiffAbs`, `Vec3_Scale`,
`Ray_SphereIntersect`, etc.), decompile THOSE too before guessing what they compute. In this case,
`Vec3_DotDiff(a, b, c)` returns `dot(a - b, c)` — not `dot(a, c) - dot(b, c)` as a standalone. And
`Vec3_DotDiffAbs` wraps the result in `ABS()`. Without decompiling the helpers, the gate conditions
cannot be interpreted correctly.

---

## §24 Systematic Struct-Offset Write Scan

**Full reference:** `references/struct-offset-write-scan.md`

When you need ALL code paths that write to a specific struct field (e.g., "what triggers
is_stunned?"), use `objdump` to grep the entire binary for `[reg+offset]` displacement patterns.
This catches writes in functions Ghidra hasn't discovered — run `create_function` on any unknown
addresses, then decompile. Also covers reading float constants from PE `.rdata` via Python
`struct.unpack`.

---

## §25 Trace From UI Display to Trigger (Reverse Data Flow)

When investigating a game mechanic the user can observe on screen (HUD counter, status effect,
score display), start from the **observable output** and trace backward to the cause. This avoids
getting lost in the object hierarchy.

### Technique (validated June 2026, dizzy counter trace)

1. **Find the display string** in `.rdata`:
   ```bash
   objdump -s -j .rdata target_binary.exe | grep -i "DIZZIED"
   ```
2. **Find the code that pushes the string**:
   ```bash
   objdump -d -M intel target_binary.exe | grep "4d6dc0"  # the string VA
   ```
3. **Read the display function** — trace which register holds the displayed value:
   ```asm
   mov eax, [esi+0x8]     ; data source object
   mov ecx, [eax+0x2c]    ; the actual counter value
   push ecx               ; pushed as %d argument
   ```
4. **Search for ALL writes to that offset** — use the systematic struct-offset write scan (§24)
   with byte patterns like `89 XX 2C` (mov [reg+0x2C], reg2).
5. **Filter** to find the increment that fires during gameplay (not init/reset).

### Pitfall: Ghidra Function Overlap

Ghidra auto-creates functions that can OVERLAP. If xrefs to an address return empty, check
whether the address is inside a LARGER function's body. Example: 0x44E800 was auto-created as
a separate function, but it was actually INSIDE RaceGoalReached_Tick (0x44DF70, body to 0x44F063).
No xrefs found because the function boundary was wrong.

### Pitfall: Double vs Float Constants in .rdata

Some `.rdata` constants are read as **doubles** (8 bytes) while others are **floats** (4 bytes).
A float read of a double constant produces garbage (e.g., 0x4CF4E8 as float = -3.2e26, but as
double = 0.03). The instruction disassembly reveals which: `fcomp QWORD PTR` = double,
`fcomp DWORD PTR` = float. When a constant value looks unreasonable, try the other type.

### Pitfall: Two-Pass Loop Architecture

A function may iterate the SAME data structure in TWO separate while loops within one call.
If a check (e.g., "bounce_count > 1") is in Pass 1 but the increment is in Pass 2, the check
fires on the NEXT FRAME, not the same frame. This creates a one-frame delay between the trigger
event and the effect — which can make it appear that the effect happens "on the first fall"
when it actually requires the collision to persist across two frames.

---

## §26 Trace From Texture to Flag (Visual Effect Reverse Tracing)

When investigating a visible game effect (sweat bubbles, particle trail, color flash), start from
the **texture asset** and trace forward to the render condition, then backward to the trigger.

### Technique (validated June 2026, sweat mode trace)

1. **Search strings** for the texture filename:
   ```
   search_strings "sweat"
   → sweat.png at 0x4D32CC
   ```
2. **Find xrefs** to the string address → identifies the resource loader function
3. **Identify the struct offset** where the texture handle is stored (e.g., App+0x344)
4. **Search byte patterns** for that offset to find all code that references it:
   ```
   search_byte_patterns "44 03 00 00"
   ```
5. **Decompile the referencing function** — find the `Sprite_RenderQuad` call and its condition
6. **Identify the gating flags** (e.g., `ball+0x260 != 0 && ball+0x268 != 0`)
7. **Search for writes** to each flag offset using byte patterns:
   - For `mov byte [esi+0x260], 1`: `C6 86 60 02 00 00 01`
   - For `mov byte [esi+0x260], 0`: `C6 86 60 02 00 00 00`
   - Try `C6 80` (eax), `C6 86` (esi), `C6 83` (ebx), `C6 87` (edi) variants
8. **Decompile the containing function** to understand trigger/clear conditions
9. **Read the comparison constants** from `.rdata` to determine threshold values

### Pitfall: Flag Might Be Part of a Larger Struct

The second sweat flag (`ball+0x268`) was NOT a standalone byte — it was the `active` field of a
**RumbleBoard struct** starting at `ball+0x264`. This was only discovered by decompiling
`RumbleBoard_InitTimer` and `RumbleBoard_TickTimer`. When a flag doesn't appear to be set by any
obvious write pattern, check if nearby offsets form a struct by looking at init functions.

### Pitfall: Zero Multiplier Disabling Dynamic Calculation

The sweat trigger condition (`target_speed <= 0.0`) appeared to be a meaningful speed threshold.
In reality, a `.rdata` constant multiplier (`_DAT_004cf3e0 = 0.0`) zeroed out the entire dynamic
speed calculation, making the condition ALWAYS true. When a comparison threshold is 0.0, check
whether the computed value is also always 0.0 due to a zero multiplier in the formula.

## §27 RumbleBoard Toggle Timer Pattern

A common pattern in target application: a small struct (5 fields, 0x11 bytes) that toggles a byte flag
at a configurable interval, used for flashing/blinking visual effects.

### Struct Layout

```
+0x00  dword  vtable
+0x04  byte   active (toggles 0↔1)
+0x08  int    period (toggle interval in ticks)
+0x0C  int    counter (increments each tick)
+0x10  byte   signal (set to 1 when toggle occurs)
```

### Usage

- `RumbleBoard_InitTimer(ptr)` — sets vtable, active=0, period=100, counter=0
- `RumbleBoard_TickTimer(ptr)` — increments counter, toggles active when counter >= period
- Called per-frame from Ball_Update as `RumbleBoard_TickTimer(ball+0x264)`
- The `active` byte gates visual effects (sweat flashing, rumble pulses)
- Default period = 20 ticks (~0.8s at 25fps), overridden after init by Ball_ctor2
