# UI-Display-to-Trigger Backward Tracing

## When to Use

When you need to find the mechanism behind a game feature that the user can
observe but can't precisely describe. Instead of guessing at code paths,
start from what the game DISPLAYS to the user and trace backward.

## The Technique

The user suggested this approach for finding target application's "dizzy" mechanic:
"Look at the end screen from time trial mode. It shows a count of how many
dizzied balls you got over the race. If you can find how it writes that, then
track the variable it uses to where it's written, you can find the mechanism."

### Step-by-step

1. **Find the display string** in `.rdata`:
   ```bash
   objdump -s -j .rdata binary.exe | grep -i "keyword"
   ```
   Example: search for "DIZZIED", "BROKEN", "SCORE", etc.

2. **Find the code that references the string** — search for `push 0x<string_address>`:
   ```bash
   objdump -d -M intel binary.exe | grep "4d6dc0"  # address of string
   ```

3. **Decompile the containing function** (may need to create it in Ghidra first):
   ```
   POST /create_function {"address": "0x44E800"}
   GET /decompile_function?address=0x44E800
   ```

4. **Identify what register/variable holds the displayed value**:
   - Look for `mov reg, [struct_ptr + offset]` before the format/push call
   - In the target application case: `mov ecx, [eax+0x2c]` → reads from offset +0x2C
   - Trace backward: `mov eax, [esi+0x8]` → eax = *(esi+8) = data object

5. **Identify the data object type**:
   - Check the constructor (where `this+8 = param_2` is stored)
   - Trace param_2 to the caller
   - In target application: param_2 was a per-player data block at `App + pIdx*0xA0 + 0x5CC`

6. **Search for ALL writes to that offset** on the identified object:
   ```bash
   # Search for mov [reg+0x2C], value or inc/add patterns
   objdump -d -M intel binary.exe | grep "0x5f8\]"  # App-relative offset
   ```
   Also search for byte-pattern scans for increment instructions:
   ```python
   # Search for inc dword [reg+0xNN] and add dword [reg+0xNN], 1
   target = bytes([0xFF, reg_byte, offset])
   ```

7. **Filter results to find the gameplay trigger**:
   - Discard initialization writes (in constructors, set to 0)
   - Discard reads (mov reg, [offset])
   - The remaining write IS the trigger mechanism

## Pitfalls

### Don't get lost in the object hierarchy
The biggest risk is spending too long tracing the data object's type and
ownership chain. In the target application case, the state_obj was passed through
4 layers of function calls before reaching the display function. The key
breakthrough was finding the Board_ctor line that adds `App + pIdx*0xA0 + 0x5CC`
to the board's AthenaList — this revealed the object IS a per-player data
block on the App struct, not a standalone object.

### unaff_ESI in Ghidra decompilation
When Ghidra shows `unaff_ESI` (unaffected ESI), it means the function
inherits ESI from the caller without setting it. This often means the
function is NOT a standalone function but part of a larger body. Check
if the "function" you created is actually inside another function's
body range.

### Adjacent fields share patterns
If you find a counter at +0x2C, check +0x28 (4 bytes before) — it may
be a related counter (e.g., "broken balls" at +0x28, "dizzied balls"
at +0x2C). Both are displayed on the same end screen and follow the
same initialization pattern.

## Success Case

Traced "DIZZIED BALLS:" display string → RaceGoalReached_Render function
→ `*(App + pIdx*0xA0 + 0x5F8)` read → Ball_ApplyTrajectory increment →
Ball_Update bounce counter check. Discovered the dizzy effect is
triggered by hard bounces (bounce_count >= 2), NOT by E:TRAJECTORY
level geometry as previously believed.
