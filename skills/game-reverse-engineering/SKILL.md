---
name: game-reverse-engineering
description: General reverse-engineering techniques for Windows game binaries — dead code detection, nested object verification, modding field validation, and decompilation methodology using Ghidra MCP
triggers:
  - reverse engineer a game
  - find dead code in a binary
  - find unreleased features in a game
  - find hidden features in a game
  - find cut content in a game binary
  - verify a modding offset
  - validate a function actually works
  - trace field writes and reads
  - camera hook
  - first person camera
  - orbit camera
  - determine if a setter has any effect
  - nested object field map
  - object spawning level gating
  - modding add objects to a level
  - catalog globals and their usage locations
---

# Game Reverse Engineering Methodology

## Shutdown/Exit — see `references/app-shutdown-sequence.md`
## Wave Systems — see `references/wavy-bridge-and-flagwaver-systems.md`
## MESHWORLD Headless Rendering — see `references/meshworld-software-rendering.md` + `scripts/meshworld_render.py` (software z-buffer + real textures, Pillow/numpy)

## Input Force System — see `references/input-force-system-modding.md`

## Ambient & Fog Lighting — see `references/ambient-fog-lighting-chain.md`

## CEA Camera Hooks — see `references/cea-camera-system-hooks.md`
## Pendulum/Magnifier — see `references/pendulum-magnifier-object-analysis.md`
## Difficulty & Enemy Spawn Gating — see `references/difficulty-and-enemy-spawn-system.md`
## Bumper Lit System — see `references/bumper-lit-system.md`
## Bass.dll Mod Merging — see `references/bass-proxy-mod-merging.md`
## MESHWORLD Loading Chain — see `references/meshworld-loading-chain-and-ase-parser.md`

To find hidden/cut features: (1) Ghidra function name sweep (debug, cheat, secret, multi, network, test, unused, editor, unlock, mirror, party, demo, survival, medal, rank), (2) string analysis (`strings -n 5 <binary> | grep -iE "<keyword>"`), (3) decompile promising hits (stub functions = abandoned, full implementations with vtable = coded but cut, unlock gating switches).
4. **Cross-reference strings with code** — Scan `.text` section for `PUSH` instructions referencing string VAs (`0x68 + struct.pack('<I', va)`).
5. **Classify by status** — Fully implemented / Stub only / Cut from levels / Unlockable / DRM-embedded.

**Pitfall:** Don't confuse "unused in levels" with "dead code." A feature can be fully coded (constructors, vtables, update logic) but simply not placed in any level file. That's cut content, not dead code. Dead code = writes without reads. Cut content = reads without level placement.

See `the target-re/references/unreleased-features-catalog.md` for a worked example (17 feature categories found in one sweep).

---

## 0b. Pitfall: Misidentifying Infrastructure as Game Features

When sweeping a binary for hidden features, infrastructure code (DRM, crash reporters, auto-updaters) can mimic game features. **Always verify before claiming a feature exists.**

Common false positives:
1. **Winsock imports ≠ online multiplayer** — `socket`, `connect`, `send`, `recv` from WS2_32.dll are often used by DRM activation and crash reporters. Parse the PE import table, then trace which code actually calls these functions.
2. **`*Connection*` / `*Network*` class names** — may be InputDevice wrappers, not network sockets. Check `operator_new` allocation size: ≤32 bytes = trivial data wrapper, not a TCP handler.
3. **`MP` in function names** — `MPMenu` may stand for Multiplayer **Party** (local), not online.
4. **`*unlock*` strings** — may refer to DRM serial-key activation, not hidden game content.
5. **Ghidra auto-names are hypotheses, not facts** — `NetworkConnection_Ctor` was an auto-generated name that turned out to be `InputDevice_Ctor`. A name is a starting point, not proof. See heuristics 5-6 in `references/function-name-verification-methodology.md`.

**Verification protocol:** string/function name → decompile caller → check allocation sizes → verify against PE imports → trace actual usage.

---

## 1. Dead Code Detection (Write-Without-Read Analysis)

A function that only writes to memory without a corresponding read is **dead code** — it produces no lasting effect. A field that gets written once then immediately overwritten by a computed value is **not moddable**.

### Methodology

**Step 1: Decompile the suspected setter**
```c
void __thiscall FUN_004029c0(void *this, float param_1) {
  *(float *)((int)this + 0xC64) = param_1;           // write to Field A
  *(float *)((int)this + 0xC98) = param_1 * ...;     // write to Field B
}
```

**Step 2: Trace each written field in the main update loop**
Find the object's main tick/update function. Search for the same offsets:
- Does the update function **read** `+0xC64` before writing it?
- Does it use the value to influence physics, rendering, or game state?
- Or does it immediately overwrite `+0xC64` with a computed value?

**Step 3: Search the entire codebase for reads**
```bash
# Search all decompilation files for a specific offset
grep -r "0xc98\|0xc9c\|0xca0" analysis/ghidra/decompilations/
```
If **nothing** in the engine dereferences those offsets, they are dead values.

### Decision Matrix

| Condition | Field Type | Moddable? |
|-----------|-----------|-----------|
| Written and READ by update/render loop | Persistent state | **Yes** |
| Written but NEVER READ anywhere | Dead value | **No — setter is dead code** |
| Written then immediately overwritten with computed value | Ephemeral / derived | **No — overwritten each frame** |
| Only read, never written (except init) | Constant / config | **Yes, but one-time** |

### Anti-Pattern: Naming by Cross-Reference Instead of Decompilation

`FUN_004029c0` was historically named `Ball_SetSpeed` because it was discovered through Ball-related cross-references. The decompilation revealed it accessed CollisionMesh offsets (`+0xC64`, `+0xC98`) directly on `this`, proving it is a `CollisionMesh` method, not a `Ball` method.

**Rule:** When naming a function, check which struct offsets its `this` pointer dereferences. If it hits sub-object offsets, name it after the sub-object, not the parent.

### Anti-Pattern: Treating Sub-Object Fields as Inline Parent Fields

`CollisionMesh` was treated as a flat extension of `Ball` because its fields were discovered through Ball decompilations (`Ball_Update` dereferences `*(ball + 0x1A4)` then accesses offsets `+0xCA8` etc.). The constructor at `0x4039E0` reveals it is a **separate object** allocated via `operator_new` + `CollisionMesh_ctor`, with its own `vtable` and an `owner_ball` back-pointer at `+0x10`.

**Rule:** If a field is initialized with `operator_new` + constructor, it is a **pointer to a nested object** with its own field map. Document it as a separate struct, not as inline offsets of the parent.

### Anti-Pattern: Dead Code Field Claims

A function (`Ball_SetSpeed`) was documented as a modding API for changing ball speed. Dead-code analysis showed it writes to `CollisionMesh + 0xC64` and `+0xC98`, but `Ball_Update` (the main physics tick) **never reads those offsets**. The values are dead on arrival — overwritten every frame by computed values or never consumed.

**Rule:** Before documenting a setter as a modding API, verify the target field is **read** by the object's main update/render loop. If nothing reads it, the setter is dead code.

---

## 1b. The Write-Only-Once Trap — When a "Toggle" Flag Is Actually a Pointer Check

A field that is **written only once** at initialization (typically `0` or a pointer) and then **only read** in a conditional branch is a **pointer-availability check**, not a runtime toggle. Setting it to `0` at runtime may appear to have "no effect" because the downstream behavior was already dominated by other systems.

### Detection Pattern

```cpp
// Initialization (once per level load)
*(int*)(scene + 0x3F1C) = 0;                           // default
int cameralocus = Level_FindObjectByName(level, "CAMERALOCUS");
*(int*)(scene + 0x3F1C) = cameralocus;                // 0 = absent, ptr = present

// Main loop (read-only, never written back)
if (*(int*)(this + 0x3F1C) != 0 && use_path != 0) {
    // Spline-based target blending (only runs if object exists)
}
// SAME orbit math runs regardless of the branch above
camera = target + orbit_dir * orbit_distance;
```

### Why "Setting It to 0 Does Nothing"

| Scenario | What Happens | Why It "Does Nothing" |
|----------|-------------|------------------------|
| Level has **no** `CAMERALOCUS` | `0x3F1C` was already `0` | The path block was already skipped; the "rails" feeling comes from the orbit system (`0x29BC` + `0x29C0`) |
| Level **has** `CAMERALOCUS` but it's **near the ball** | `0x3F1C` becomes `0` | The path target ≈ ball position, so disabling the path barely changes the orbit target, and the camera ends up in the same place |
| Level **has** `CAMERALOCUS` far from ball | `0x3F1C` becomes `0` | **This works** — the camera target snaps to the ball, but the orbit distance still pulls the camera away by 350 units |

### The Real Controls

When a path-availability flag seems ineffective, the actual behavior is usually governed by **post-branch parameters** that always execute:

| Offset | Name | Effect |
|--------|------|--------|
| `0x29BC` | Orbit angle | Fixed camera direction `(cos, 0.9, sin)` |
| `0x29C0` | Orbit distance | How far camera sits from target |
| `0x434C/50/54` | Camera offsets | Added to ball position for target |

### Rule

> **A one-time pointer check is not a runtime toggle.** Before declaring a setter "does nothing," verify (1) whether the pointer was already `0`, and (2) what systems run **after** the conditional branch. The perceived effect may come from post-branch code, not the branch itself.

---

## 2. Nested Object Verification

When a field at `this + N` is initialized with `operator_new` + constructor, it is a **pointer to a nested object** with its own field map. Do not treat its fields as inline members of the parent.

### Verification Checklist

1. **Decompile the sub-object constructor** to get its internal field map
2. **Look for owner back-pointer** (`CollisionMesh + 0x10 = Ball*`) — confirms relationship
3. **Find functions that dereference the pointer field** (e.g., `Ball_Update` uses `param_1[0x69]` = `*(ball + 0x1A4)`)
4. **Cross-reference field usage across 2+ functions** that touch the sub-object
5. **Document the pointer chain** for modding: `Ball → +0x1A4 → CollisionMesh → +0xCA8`

### Common Pitfall: Two Velocity Systems

Games often have separate velocity fields:
- **Ephemeral input accumulator** — cleared every frame after processing
- **Persistent physics state** — integrated across frames

Writing to the wrong one produces no visible effect. Always trace the full lifecycle: who writes, who reads, who clears.

### Anti-Pattern: Concluding "No Persistent Velocity" From Only One System

A related trap is analyzing ONLY the ephemeral accumulator system, seeing it zeroed each frame, and concluding "the engine has no persistent velocity." This is wrong if the game has a **second velocity system** on a nested object (e.g., a collision node storing speed + direction that persists across frames).

**Detection:** If the ball keeps moving when it should stop (rolling off a ledge, launched into air), look for a nested object pointer on the ball that stores its own velocity fields. Decompile the main update function and search for `param_1[N]` dereferences where N points to a sub-object — that sub-object likely holds the persistent state.

**Case study (target application, Session 527):** Force accumulators at ball+0x170/0x174/0x178 are zeroed each frame. Analysis concluded "no persistent velocity." But the collision node at ball+0x1A4 stores speed (+0xC64) and direction (+0xC8C/C90/C94) that persist. When no collision is detected (airborne), the update loop's else-branch multiplies persistent speed × existing direction → ball keeps moving. The user pointed this out: "why do I keep moving forward when I roll off an edge?" — proving the analysis was incomplete.

### Pointer Chain Documentation Template

```cpp
// Parent object → pointer field → sub-object → target field
void* ball = playerObject;
void** collisionMeshPtr = (void**)((DWORD)ball + 0x1A4);
void* collisionMesh = *collisionMeshPtr;
float* trueVelY = (float*)((DWORD)collisionMesh + 0xCA8);
```

---

## 2b. Vtable Analysis and Object Lifecycle

The constructor reveals object identity through **vtable assignment** (the first field written is always `this->vtable = &KnownVtable`). The destructor confirms it through **vtable restoration before `operator_delete`**.

### Lifecycle Documentation Pattern

Document four lifecycle functions per object:

| Phase | Function | Vtable Action | Offset | Key Work |
|-------|----------|--------------|--------|----------|
| **Construction** | `Object_ctor` | Sets vtable to live vtable | Known | Allocates sub-objects via `operator_new` + sub-ctor |
| **Destruction** | `Object_dtor` | Restores vtable to base | Known | Calls sub-dtors, frees memory |
| **Update** | `Object_Update` | Calls virtual methods via vtable | Known | Main tick — READ this to find what fields matter |
| **Render** | `Object_Render` | Calls virtual methods via vtable | Known | Visual state — READ this to find display fields |

**Example — CollisionMesh lifecycle:**
- `CollisionMesh_ctor` at `0x4057E0` → sets vtable `0x4CF420`, allocates sub-objects (`CollisionEvent`), initializes velocity/rotation quaternions to zero
- `CollisionMesh_dtor` at `0x405740` → restores vtable `0x4CF3A0` (base), destroys sub-objects
- `Ball_Update` at `0x405E00` → dereferences `*(ball + 0x1A4)` to get CollisionMesh, reads `+0xCA8` (velocity) for physics integration
- `Ball_Render` at vtable+0x10 → reads display quaternion at `+0xC9C` for orientation matrix

### Rule: Destructor as Confirmation
If a destructor restores a **different** vtable than the constructor sets, the object has **virtual inheritance** or **multiple vtable states**. The destructor's restored vtable is the **base class** vtable; the constructor's is the **most-derived** vtable.

---

## 2c. The Context Trap — Ghidra Comments vs Raw Decompiled Code

A decompilation file contains **two layers** of text:
1. **Ghidra-generated raw C** — the actual decompiled machine code rendered as `*(int *)(param_1 + 0xNNNN)` and `param_1[0xXX]` patterns.
2. **Human-written comments** — block headers, inline notes, and offset annotations added by previous RE sessions (e.g. `App+0x5DC = Scene*`).

**The trap:** Human comments can be wrong, outdated, or based on incomplete analysis. They are NOT decompiled code. Treating a comment as verification evidence creates circular validation — you "confirm" an offset by reading a comment that merely assumed it.

### Detection Protocol

When reviewing any `.c` decompilation:
1. **Find the raw C body** — skip the `/* ... */` header block; look for actual statements (`if`, `for`, `=`, function calls).
2. **Only raw C counts** as evidence. A comment saying `App+0x5DC = Scene*` is a hypothesis until a raw C statement like `*(int *)(app + 0x5DC)` appears.
3. **Watch the base pointer** — `0x5DC` in `Ball_Update` is added to `scene` (`*(ball + 0x14) + 0x5DC`), NOT to `App`. The same hex constant can mean completely different fields depending on which base pointer Ghidra chose for `param_1`.
4. **If raw C contradicts the comment, raw C wins.**

### Case Study: `App+0x5DC` (Session 50)

**Comment claim in `decomp_scene_update.c:37`:**
```
 * Read position from App+0x5DC → +0x758/75C/760
```

**Raw C in `decomp_ball_update.c:170`:**
```c
iVar5 = *(int *)((1 - *(int *)(param_1 + 0x18)) * 0xa0 + 0x5dc + iVar8);
// where iVar8 = *(int *)(param_1 + 0x14) = Ball's scene pointer
```

**Analysis:** `0x5dc` is added to `scene`, not to `App`. The comment confused the context — it saw `0x5DC` in a function that ultimately traces back to App and assumed `App+0x5DC`. The raw C reveals `scene + 0x5DC` is a scene-internal field (likely a player-data array at `Scene+0x5DC`).

**Result:** `App+0x5DC = Scene*` was **dead wrong**. The actual `App→Scene` path is unverified from available decompilations; the only verified path is `Ball+0x14 → Scene`.

## Rule

> **Every offset in a modding doc is guilty until proven innocent by raw decompilation.**

When a user challenges an offset, the correct response is verification, not defense.

## Concrete Case Study: Session 50 — App+0x5DC

**Claimed in APP_OBJECT.md:** `App+0x5DC = Scene* currentScene`

**Verification path taken:**
1. Searched raw decomp C for `(int)this + 0x5dc)` → **zero matches in App decomp files**
2. Found `0x5dc` in `decomp_ball_update.c` where it is added to `scene` pointer: `*(int *)((1 - player) * 0xA0 + 0x5dc + scene)` → this is `Scene+0x5DC`, NOT `App+0x5DC`
3. The "App+0x5DC" claim originated from **human-written comments** in `decomp_scene_update.c` that described the field conceptually but never showed it in raw C
4. Corrected `App+0x178` (display_mode) and `App+0x184` (gameUpdateObj) — also found to have zero raw C evidence for being Scene pointers
5. Result: `App→Scene` pointer offset remains **unverified**; only verified path is `Ball+0x14 → Scene`

**Full corrected field map:** See `the target-re/references/app_unverified_offsets.md`

## 3. Modding Field Validation Rules

For a field to be useful for runtime modding, it must satisfy:

**Rule 1: The field is READ by physics/render/game logic.**
A field that's only written and never read is a dead value. Search all decompilations.

**Rule 2: The field is NOT overwritten every frame by a computed value.**
If `Ball_Update` recomputes `roll_friction = f(radius, friction, speed_scale)` and writes it to `+0xC64` every single frame, then writing to `+0xC64` from outside is futile — it survives at most one frame.

**Rule 3: The write survives long enough to affect gameplay.**
One-shot config fields (set at init, never changed) are moddable but don't create dynamic effects. Persistent state fields (velocity, position, flags) are the prime targets for real-time mods.

---

## 3b. Struct Field Confidence Markers

When documenting a large struct layout for modding, apply confidence markers to every field based on verification depth:

| Marker | Meaning | When to Use |
|--------|---------|-------------|
| **✅** | Verified in raw decompiled C | Field appears in actual decompiled code body (not just comments/headers) with read+write operations |
| **⚠️** | Found in comment-only decomp | Field described in Ghidra-generated comment but no raw C body available for that function |
| **❓** | Single-source inference | Field derived from one decompilation only, or offset computed from adjacent fields, needs second-function verification |

### Verification Methodology

1. **Raw C scan**: Search all decompilation files for `param_1 + 0xNNNN` or `*(int *)(param_1 + 0x14) + 0xNNNN` patterns
2. **Ref-count**: Count distinct decompilation files referencing the offset
3. **Int-indexed conversion**: Ghidra often uses `param_1[N]` where `N * 4 = byte_offset`. Convert and verify both forms
4. **Second-function rule**: For ❓ fields, find a second function (update + render, or constructor + update) that touches the same offset

### Example Confidence Annotation

```markdown
| Offset | Type | Name | Description | ✅/⚠️/❓ |
|--------|------|------|-------------|----------|
| +0xCA8 | float[4] | vel_quat | Velocity as rotation quaternion (x,y,z,w) | ✅ (7 refs in 4 files) |
| +0xC9C | float[4] | display_quat | Display orientation quaternion | ⚠️ (only in dtor) |
| +0xCB0 | float | terminal_velocity | Max fall speed | ❓ (inferred from size) |
```

---

## 4. Cross-Reference Strategy

### Offset Arithmetic in Decompilations

Ghidra often uses array-index notation for struct offsets:
- `param_1[0x69]` = `*(ball + 0x1A4)` because `0x69 * 4 = 0x1A4`
- Recognize this pattern: `[N]` where `N * 4` is the byte offset

### Constructor as Ground Truth

Start with the constructor — it shows initialization values and relative field ordering. It answers: "What does this field start as, and what other fields live nearby?"

**Constructor scan checklist:**
1. First write: `this->vtable = &KnownVtable` — confirms object identity
2. Sub-object allocations: `*(this + N) = operator_new(size); SubObject_ctor(...)` — reveals nested objects
3. Field initialization: zero, one, specific constants — reveals field types and purposes
4. Size argument to `operator_new` — total object size in bytes
5. Adjacent-field patterns: `pos.x, pos.y, pos.z` appearing consecutively → `Vec3` field

**Example — CollisionMesh_ctor reveals:**
- Total size: `operator_new(0xCB0)` → 3248 bytes
- Sub-objects: `CollisionEvent` at `+0x18`, `CollisionEvent` at `+0x28`
- Owner back-pointer: `*(this + 0x10) = owner_ball` at offset `+0x10`
- Velocity quaternion: `+0xCA8` initialized to `(0,0,0,1)` (identity quaternion for rotation)
- Physics constants: `+0xC64` (roll_friction), `+0xC68` (slide_friction), `+0xC70` (bounce)
- Display quaternion: `+0xC9C` initialized to `(0,0,0,1)` (identity for render orientation)

### Second-Function Verification

Never trust a single decompilation. Verify with a second function that reads AND writes the same field.
- For velocity: constructor (initializes 0) + ApplyForce (reads+adds) + Update (reads, integrates, writes back)
- Look for adjacent-field patterns (pos→vel→accel chains, quaternion→matrix derivations)

### Multi-File Offset Verification

For comprehensive struct field validation, scan **all** decompilation files for a specific offset pattern:

```bash
# Search all raw decomp C files for a specific byte offset
grep -r "0xca8\|0xcac\|0xcb0" analysis/ghidra/decompilations/

# Search for int-indexed references (multiply by 4 for byte offset)
grep -r "\[0x32a\]" analysis/ghidra/decompilations/  # 0x32a * 4 = 0xCA8
```

**Ref-count methodology:** Count how many distinct decompilation files reference an offset. Higher ref-count = higher confidence:
- **1-2 refs**: Single-source inference, needs verification
- **3-5 refs**: Likely correct, cross-reference with second function
- **6+ refs**: Well-established field, safe for modding documentation
- **0 refs in raw C, only in comments**: Suspect — may be dead code or mislabeled

---

## 4b. AI / NPC Behavior Decompilation

Enemy AI in games is rarely a separate object hierarchy. It is usually the **same base object** as the player (same struct, same physics, same rendering) with behavior overrides via vtable slots or config flags set during level loading.

### Detection Pattern: The "BADBALL" Approach

```cpp
// Level loader finds "BADBALL" entries in MESHWORLD data
// Constructs a normal Ball, then overwrites NPC-specific fields
void* ball = Ball_ctor(operator_new(0xC98), scene);
ball[0x318] = spawn_x;      // home_position (Vec3)
ball[0x31B] = home_dist;    // HOME parameter
ball[0x31C] = chase_dist;   // CHASE parameter
ball[0x31D] = 1;            // is_8ball flag — gates AI in update loop
ball[0x31E] = 0;            // spin_counter
ball[0x31F] = spin_dist;    // SPINDISTANCE parameter
```

### AI Update Function Location

The AI logic lives in a **vtable slot override**, not a standalone AI system:

```cpp
// Ball vtable[0x10] normally points to Ball_Update (0x405E00)
// But the "thunk" at 0x408390 wraps it with AI logic:
//   1. Check ball[0x31D] || scene[0x237] (battle mode)
//   2. If active: find nearest target, compute force, apply via vtable[0x14]
//   3. Then call the real Ball_Update for physics
```

### AI Decompilation Checklist

1. **Find the level loader:** Search strings for enemy type names (`BADBALL`, `NPC`, `Enemy`, `CPU`, `Computer`)
2. **Decompile the loader function:** Look for string compares (`__stricmp`) that parse parameters (`CHASE`, `HOME`, `SIZE`)
3. **Map config fields:** Note which offsets the loader writes — these are the AI config struct
4. **Find the update gate:** Search decompilations for the config flag offset in conditionals (`if (ball[0x31D] != 0)`)
5. **Decompile the gated block:** This is the AI behavior — target selection, force computation, RNG checks
6. **Verify target validity:** The AI often filters targets by state flags (race_active, !is_stunned, !is_teleporting)
7. **Trace force application:** AI calls the same `ApplyForce` vtable slot that player input uses

### Common AI Patterns

| Pattern | What to Look For | Example |
|---------|-------------------|---------|
| **Seek/Flee** | Direction vector toward/away from target, normalized | `dx = target.x - self.x; if (self.radius < target.radius * 0.9) dx = -dx;` |
| **Spin Wobble** | Sine/cosine added to target position | `target.x += sin(spin_counter) * spin_dist;` |
| **Distance Gating** | Two distance checks: range to target + range from home | `if (dist_to_player < chase_dist && dist_from_home < home_dist)` |
| **RNG Jitter** | Random float gates whether AI runs this frame | `if (RandomFloat() < 0.5) { /* chase */ }` |
| **Nearest Target** | Iterate object list, compute distance, pick minimum | Loop over `scene->ball_list` with `Math_FastDistance2D()` |
| **Self-Exclusion Bug** | AI tick iterates ALL objects including self — distance=0, zero force, motionless | `if (candidate == self) skip;` — check if this guard exists |
| **Respawn State Leak** | Respawn function resets position/active but leaves AI state/target fields stale → AI chases freed/invalid target | Clear `ai_state` and `ai_target` after respawn |
| **Zeroed Config Fields** | Player objects created by different constructor than AI objects — AI config fields (chase_distance, home_radius) may be zeroed | `home_radius=0` → any distance exceeds it → always "return home" |
| **Multiple AI Systems** | Game may have separate AI for NPC enemies vs COMPUTER-controlled players — each with different targeting, self-exclusion, and gating logic | NPC AI tick lacks self-exclusion; COMPUTER AI function has it built in |

### AI-Specific Struct Fields

When documenting AI, create a **separate table** for config fields vs. runtime fields:

```markdown
### AI Config (set once at spawn by level loader)
| Offset | Type | Name | Source |
| +0xC60 | Vec3 | home_position | MESHWORLD spawn pos |
| +0xC6C | float | home_distance | `HOME` tag parameter |
| +0xC70 | float | chase_distance | `CHASE` tag parameter |

### AI Runtime (updated every frame)
| Offset | Type | Name | Purpose |
| +0xC74 | bool | is_8ball | Gates AI execution |
| +0xC78 | float | spin_counter | Angle accumulator for wobble |
```

---

## 5. Ghidra MCP Workflow

**PREFERRED: Native MCP tools.** Call `mcp_ghidra_mcp_*` tools directly — no curl or Python client needed. Use `tool_search(query="ghidra")` to discover available tools, `tool_describe` to get the schema, then call directly.

```
# Decompile the constructor
tool_call: mcp_ghidra_mcp_decompile_function
  address: "0x4039E0"

# Decompile multiple functions at once (comma-separated names or addresses)
tool_call: mcp_ghidra_mcp_batch_decompile
  functions: "Ball_ctor, Ball_Update, Ball_Render"

# Get cross-references to a function
tool_call: mcp_ghidra_mcp_get_bulk_xrefs
  addresses: ["0x4CF3A0"]
```

**FALLBACK: curl via terminal** (if MCP bridge is down):
```bash
curl -s "http://127.0.0.1:8089/decompile_function?address=0x4039E0"
curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0x4039E0&limit=300"
```

**NEVER use browser_navigate/snapshot** — GhidraMCP is a REST API returning JSON, not a webpage.

### Struct Creation via MCP
```python
fields = [
    {"name":"vtable","offset":0,"type":"pointer"},
    {"name":"owner_ball","offset":0x10,"type":"pointer"},
    {"name":"battle_mode","offset":0xC60,"type":"dword"},
    {"name":"roll_friction","offset":0xC64,"type":"float"},
]
client.create_struct("CollisionMesh", 0xCB0, fields)
```

---

## 6. Object Spawning Level-Gating Pattern

Game objects that only appear in specific levels fall into two categories:

**Self-loading objects** (e.g., Bonk, Bumper) call `MeshWorld_ctor` with a hardcoded asset path inside their constructor. They carry their own mesh and collision — the only thing gating them is a mode flag (e.g., `app+0x23C` tournament mode). Patching the flag is sufficient to enable them on any level.

**Scene-dependent objects** (e.g., Tipper, Gluebie, BlockDawg) inherit from `Stands_ctor` and receive a pre-loaded mesh reference (`param_2`) from a scene offset that only gets populated by a specific `BoardLevel*_ctor`. Adding their MESHWORLD names to a level without also patching the level constructor to load the sub-mesh will result in a null pointer dereference.

**How to tell which:** Decompile the constructor. If it calls `MeshWorld_ctor(..., "hardcoded_path")` → self-loading. If it passes `param_2` to a parent ctor like `Stands_ctor(this, param_2)` → scene-dependent.

- `references/object-spawning-level-gating.md` for full details including constructor addresses, scene offsets, and modding workarounds.

### vtable[33] Factory Dispatch — How Board Subclass Controls Object Creation

Beyond the self-loading vs scene-dependent distinction, the broader architecture is: each Board subclass overrides **vtable slot 33** (byte offset +0x84) with a factory function that matches ref names via `__strnicmp`. `Scene_CreateDynamicObjects` (0x0040C430) iterates ALL ref points and calls `board->vtable[33](board, refName, &outObj, &outCol, refEntry)` at instruction `0x0040C4BA`. If the factory doesn't recognize the ref name, it returns NULL and the ref is silently skipped.

**Two separate Board systems**: Race (constructors 0x422xxx) and Arena (constructors 0x41Cxxx), selected by `App+0x237` byte (0=race, ≠0=arena). Each system has its own vtables, factories, and sub-mesh loading. Arena factories handle 8-13 ref types each; Race factories are simpler (most fall through to base factory 0x4133E0 handling only PLATFORM, STANDS).

**Sub-mesh preloading**: Each Board constructor loads MESHWORLD sub-mesh files into board struct slots (+0x4344–0x43B4). Factories access these slots for mesh data. **Factories do NOT null-check these slots** — calling a factory with unloaded slots causes an access violation crash. When building a universal ref loader (DLL that tries all factories), you MUST check slot validity before calling each factory.

**Quality gate**: `App+0x23C` (accessed as `*(int*)(*(int*)(board + 0x878) + 0x23C)`, non-zero = Normal/Frenzied). 7 ref types are quality-gated (TIPPER, BONK, MACE, SAWBLADE, BLOCKDAWG, GLUEBIE, FAN); the rest are always created regardless. To bypass: temporarily set `App+0x23C = 1` before calling the factory, restore after.

Full architecture, all 30 verified vtable[33] entries, factory→slot dependency table, and universal ref loader DLL mod: see `the target-dll-modding/references/universal-ref-loader-pattern.md` and `mods/universal-ref-loader/` in the the target-re repo.

### CEA Runtime Global Spawning (No Level Patch Required)

For CEA-based mods, you can spawn level-specific objects on ANY level at runtime without patching level constructors. The pattern:

1. **Hook Ball_Update** at 0x405E22 (6-byte instruction `mov eax, [esi+0x0C5C]`)
2. **Load meshes** via `MeshWorld_ctor(0x461510)` on first spawn (cached in alloc'd memory)
3. **Allocate + construct** the object by calling its constructor directly from the hook
4. **Append to Board+0x2578** (general objects list — initialized on all levels)
5. **Collision** is handled internally by `CollisionLevel_ctorWithLevel(0x465080)` called from within each constructor

Key decision: does the constructor read `mesh+0x878` directly? If yes (Drawbridge), force-set it after MeshWorld_ctor. If no (Trapdoor, Neon objects), no fix needed. See `references/meshworld-uninitialized-field-trap.md` for the decision table.

**Complete worked pattern** with CEA script template, object catalog, and pitfalls: `references/cea-global-object-spawning.md`. Verified across 4 mods (Lifters, Drawbridge, Trapdoor, Neon).

---

## 7. The `__thiscall` Trap — Calling Game Functions from Injected Code

When calling game functions from an injected DLL or reimplementation, **always verify the calling convention**. MSVC-compiled Windows games overwhelmingly use `__thiscall` for member functions (vtable dispatch, constructors, methods). If you call them via `__cdecl` (all args on stack), ECX contains garbage and the function crashes or corrupts state silently.

### Detection

1. **Check the prologue**: `MOV ESI, ECX` or `MOV ECX, [ESP+4]` (thiscall saves ECX as `this`). `__cdecl` and `__stdcall` don't reference ECX for the first param.
2. **Check Ghidra's decompilation signature**: `__thiscall` appears as `void __thiscall ClassName::Method(void *this, int param_1)` — `this` is the implicit first arg in ECX.
3. **Check vtable dispatch**: `(**(code **)(*ptr + offset))()` means the runtime loads `this` into ECX before CALL. If your wrapper doesn't set ECX, the call is wrong.
4. **Disassemble the first bytes**: `51 56 8B F1` = `PUSH ECX; PUSH ESI; MOV ESI,ECX` — saving `this` from ECX is `__thiscall`.

### The Fix

Use `__thiscall` function pointer typedefs when calling game functions from DLL code:

```cpp
// Correct: __thiscall — ECX=first arg, rest on stack
typedef void* (__thiscall *ThisCall_Ctor)(void* thisPtr, int scene);
typedef void  (__thiscall *ThisCall_Method0)(void* thisPtr);
typedef void  (__thiscall *ThisCall_Method1)(void* thisPtr, int arg);

auto BallCtor = (ThisCall_Ctor)0x40AFE0;
void* ball = BallCtor(allocatedMem, (int)scene);   // ECX=mem, stack=scene

auto InitPhysics = (ThisCall_Method0)0x405100;
InitPhysics(ball);                                   // ECX=ball, no stack args

auto ListAppend = (ThisCall_Method1)0x53780;
ListAppend(&scene->ball_list, (int)ball);           // ECX=&list, stack=ball
```

**Wrong** — pushes all args on stack, ECX is garbage:
```cpp
// This will CRASH — game function reads garbage from ECX
CallMethod(0x0AFE0, mem, scene);  // __cdecl: both on stack, ECX=random
```

### target application-Specific Calling Conventions

When injecting code that calls target application functions, use these verified conventions:

| Address | Function | Convention | ECX | Stack Args |
|---------|----------|-----------|-----|------------|
| 0x40AFE0 | Ball_ctor (badball) | __thiscall | mem ptr | scene ptr |
| 0x4039E0 | Ball_ctor2 (player) | __thiscall | mem ptr | scene ptr |
| 0x405100 | Ball_InitPhysicsDefaults | __thiscall | ball ptr | none |
| 0x53780 | AthenaList_Append | __thiscall | list ptr | item ptr |
| 0x403850 | Ball_SetTrajectory | __thiscall | ball ptr | stack pad, Vec3 direction |
| 0x409480 | Ball_OnLevelTransition | __thiscall | ball ptr | none |
| 0x4BA57B | operator_new | __cdecl | N/A | size_t — ⚠️ CRASHES from DLL, use HeapAlloc instead |

### The `__thiscall` Argument-Order Trap

Using the correct calling convention is necessary but not sufficient. You must also match the **stack-argument order** the binary expects. Decompilation filenames, comments, and prior docs often describe parameters conceptually, but the only authoritative source is the disassembly at the call site.

**Why it matters:** If `this` is not in ECX, or if stack arguments are reversed, the function reads garbage silently. This is especially dangerous for hooks and wrappers that never crash immediately — they just produce no visible effect.

### Detection protocol

1. **Read the disassembly at the function start** to see which registers/stack slots are read and how `this` is saved: `55 8B EC` (`__stdcall`/`__cdecl`) is different from `56 8B F1` (`__thiscall` saving ECX).
2. **Read the disassembly at every call site** to see the order arguments are pushed before the `CALL`. For `__thiscall`, `ECX` is set to `this`, then the remaining parameters are pushed in **right-to-left C order** just like `__stdcall`.
3. **Match the address's own prologue variable names.** Example: the prologue of `DispatchCollisionEvents` stores `[esp+0x54]` into `EDI`, reads `ECX` (`this`), then uses `EDI` as the collider object — not the ball. The ball arrives in `[esp+0x5C]` (the second stack argument).

### Case Study: target application `DispatchCollisionEvents` hook

**Address:** `0x0040C5D0`.

**Wrong assumed signature (led to silent failure):**
```cpp
typedef void (__thiscall *createnodizzy_t)(void *this_, void *ball, void *collObj);
```

**Correct signature verified by disassembly:**
```cpp
// ECX = this, EDI = collObj, [esp+0x5C] = ball
typedef void (__thiscall *createnodizzy_t)(void *this_, void *collObj, void *ball);
```

With the wrong order, the hook read `"E:WATER"` from a `Ball*` instead of a `collObj[1]+0x864` name string. No crash — the mod simply did nothing. Reversing the parameters fixed it immediately.

### Rule

> **For every hooked function, verify the exact parameter order from the binary before writing the hook typedef.** Decompilation filenames, comments, and prior docs are hypotheses; the prologue and call sites are proof.

### Constructor Chain Gotcha

`Ball_ctor` (0x40AFE0) is NOT a standalone constructor. It calls `Ball_ctor2` (0x4039E0) internally, then overwrites the vtable to the Ball vtable (0x4CF3A0) and adds Ball-specific init (Vec3_Init, Matrix_Scale4x4). Do NOT call both separately — calling `Ball_ctor` alone is sufficient and correct for badballs.

### The CRT Heap Trap — Never Use operator_new/malloc from a DLL

**`operator_new` (or any CRT allocator) crashes when called from an injected DLL.** The VS2003 CRT's `__heap_alloc` uses Small Block Heap (SBH) with critical sections (`__lock(4)`) that corrupt or deadlock when called from externally-created threads.

Ghidra chain: `operator_new` → `_malloc` → `__nh_malloc` → `__heap_alloc` → `__lock(4)` → `___sbh_alloc_block` (crash point) or `HeapAlloc(DAT_005369C0)`.

Meanwhile, `Ball_dtor` frees via `_free` → `___sbh_find_block` → `HeapFree(DAT_005369C0)`. The private CRT heap handle `DAT_005369C0` is created by `HeapCreate` during `__heap_init`.

**Fix: Use `HeapAlloc` directly on the game's private CRT heap handle, bypassing the CRT entirely:**

```c
HANDLE hCrtHeap = *(HANDLE*)0x005369C0;  // game's CRT heap
void* mem = HeapAlloc(hCrtHeap, 0, 0xC98);  // allocate from game's heap
// Ball_dtor's _free will HeapFree from the same heap — no mismatch
```

`HeapAlloc` is a Win32 API (thread-safe, no CRT state). When `_free` later processes the pointer, the SBH path misses (> SBH threshold for 0xC98), falls through to `HeapFree(DAT_005369C0, 0, ptr)` — same heap.

**General rule for DLL injection:** Never call the game's `operator_new`, `malloc`, `_malloc`, `new`, or any CRT allocator from injected code. Always read the CRT heap handle from the data section and use `HeapAlloc`/`HeapFree` directly.

See `references/thiscall-convention-analysis.md` for the full session analysis.

## 8. Decompilation Cleanup — Structural Fidelity

When converting Ghidra decompiled C into readable reference source (for documentation, modding APIs, or reimplementation), **preserve the original binary's control flow**. Restructuring (enum dispatch, switch tables, function decomposition) makes the code more elegant but hides the actual branching order, predicate complexity, and fallthrough behavior of the original.

### When the user says "make it cleaner"

**Cleaner does NOT mean restructure.** It means:
- Legible variable names
- Section comments
- Named constants instead of magic hex
- Consistent indentation
- Explicit type casts

**It does NOT mean:**
- Replacing a flat `__strnicmp` chain with `enum class` + `switch`
- Factoring repeated pointer arithmetic into accessor methods
- Changing `__thiscall` to `class` methods with early returns

### Example: Event handler chain

Original decompiled C (0x40C5D0):
```c
void __thiscall FUN_0040C5D0(void *this, int *ball, int *collObj) {
    char *name = *(char **)(collObj[1] + 0x864);
    if (__strnicmp(name, "E:JUMP", 6) == 0 && ball[0x202] < 1) { ... }
    if (__strnicmp(name, "E:ACTION", 8) == 0) { ... }
    if (__strnicmp(name, "E:TRAJECTORY", 12) == 0) { ... }
    ...
}
```

**Wrong refactor** (loses original order and semantics):
```cpp
switch (ClassifyEvent(name)) {   // ← introduces a second dispatch layer
    case EventType::Jump: ... break;
    case EventType::Action: ... break;
}
```

**Correct refactor** (same chain, readable):
```cpp
void __thiscall GameObject_HandleCollision(Scene *sc, Ball *ball, int *coll) {
    const char *name = *(const char **)(coll[1] + COLLIDER_EVENTNAME);

    // E:JUMP — bounce upward
    if (__strnicmp(name, "E:JUMP", 6) == 0 && READ_U8(ball, BALL_IMPACT_CNTR) < 1) {
        Sound_Play3D(app->sndJump, ball->x, ball->y, ball->z);
        WRITE_U8(ball, BALL_IMPACT_CNTR, 10);
        ...
    }

    // E:ACTION — generic action with ONCE/SCORE tags
    if (__strnicmp(name, "E:ACTION", 8) == 0) {
        ...
    }
    ...
}
```

### Rules

| # | Rule | Why |
|---|------|-----|
| 1 | **Keep the flat `if`-chain order** | The original's `__strnicmp` sequence is not a switch. It is a flat conditional chain with possible prefix overlap and fallthrough behavior. |
| 2 | **Use `constexpr` offsets and named pointer macros** | Replace `ball[0x2D5]` with `BALL_WATER_FLAG`, but keep the raw pointer arithmetic semantics identical (`PTR_OFF`, `READ_U8`, `WRITE_U8`). |
| 3 | **Section-comment each event family** | Group related checks with block comments (`// === N: notifications ===`) so the flat chain remains scannable. |
| 4 | **Stub unverified offsets; don't guess** | If an offset isn't confirmed by raw decompilation, mark it `constexpr uint32_t X = 0x????; // TODO verify` and leave the body commented out rather than inventing a name. |
| 5 | **Preserve original quirks** | If the binary does `eventName + 2` to skip a prefix, keep that pattern. The quirk may be load-bearing (e.g., bare `DROPIN` matching both `E:DROPIN` and `N:DROPIN` by ignoring the first two chars). |

### Naming convention for cleaned-up files

Store faithful cleanups alongside raw decompilations:

```
analysis/
├── ghidra/
│   └── decompilations/
│       └── scene/
│           └── decomp_collision_events.c    ← raw Ghidra output
└── code_ref/
    └── GameObject_HandleCollision_clean.cpp   ← faithful cleaned version
```

This keeps the authoritative raw C intact while providing a readable reference.

## 9. Vtable-Based Function Discovery

When a function is reached only through vtable dispatch, there are no direct `CALL` instructions to hook or trace. The function address is stored in the object's vtable at a fixed byte offset. To find the caller, read the vtable, not the .text cross-reference list.

### Methodology

1. **Read the vtable from the constructor.** The first assignment in any constructor is `this->vtable = &KnownVtable;`.
2. **Parse slots as DWORDs.** Slot offset `N` is at `vtable + N*4`. Slot 0 = destructor, slot 1..N = virtual methods.
3. **Map the slot to the observed call site.** If `UIList_ActivateCurrentItem` does `call [edi+0x48]`, the target is slot 18 (`0x48 / 4`).
4. **Verify by disassembling the slot target.** A vtable entry that points into data/string literals means you have run past the real slots.

### Example: OptionsMenu slider dispatch

```cpp
// OptionsMenu vtable at 0x004D5E30
// slot 18 (+0x48) = OptionsMenu_HandleButtonClick  (0x004434F0)
// slot 19 (+0x4C) = OptionsMenu_AdjustVolume     (0x00442680)
//
// UIList_ActivateCurrentItem calls slot 18 for normal rows and slot 19 for
// slider rows (via the left/right arrow hitbox path).
```

### Trap: No direct CALLs

A hook that only scans for `E8` (direct near call) targets will miss vtable dispatch entirely. For `OptionsMenu_AdjustVolume`, `objdump -d | grep 'call 0x442680'` finds nothing because the binary never does `CALL 0x442680` directly; it always calls through `[reg+0x4C]`. Hook the function start directly, or hook the vtable slot.

### Trap: Vtable Slots Ghidra Didn't Recognize

Not every vtable slot target appears in `list_functions`. Ghidra's auto-analysis misses functions that are only reachable through vtable indirection — they have no direct `CALL` anywhere in the binary. When reading a vtable, check each slot's address against `list_functions`. If a slot's address is unknown, call `create_function` (POST `/create_function` with `{"address":"0xNNNN"}` or native `mcp_ghidra_mcp_create_function`) to register it, then decompile.

This is especially important after batch-decompiling all known functions — you may have 100% coverage of `list_functions` but still be missing vtable-dispatched functions. See the `ghidra-mcp-headless` skill's `references/vtable-discovery-pipeline.md` for a complete Python pipeline script that reads a vtable, diffs against `list_functions`, creates unknowns, and decompiles them.

## 10. The Partial-Decompilation Trap — Trace Parameters Through the Full Call Chain

When a user questions what a parameter does, **do not re-explain from memory or from a partial decompilation**. A parameter's true role may only become visible 3-4 functions deep in the call chain.

### Case Study: max_dist in Mesh_FindClosestCollision (Session 527)

**Initial (wrong) explanation** came from decompiling only `Mesh_FindClosestCollision` (0x465D90):
- Saw `Vec3_NormalizeAndScale(&direction, 99999.0)` → concluded "ray is always 99999 units"
- Saw `max_dist` packed into `Vec3(d,d,d)` and passed as `param_4` → concluded "per-axis normalization divisor"
- Confidently wrote this to docs and memory

**User pushback:** "that doesn't seem right" — the user changed max_dist from 39 to 5 and got completely different behavior (walls vs floor). If max_dist were just a normalization divisor, changing it shouldn't matter.

**Correct explanation** required decompiling all 5 functions in the chain:
1. `Mesh_FindClosestCollision` — scales dir to 99999, packs max_dist into Vec3
2. `Ball_AdvancePositionOrCollision` — **clamps velocity to max_speed=1000** (not 99999!), applies friction → ~994 units
3. `Ball_InitBattleMode` — sets scale=0.0 (kills gravity), friction=0.555, max_speed=1000
4. Collision callback (0x456890) — calls `AABB_FromSphere` with max_dist as sphere radius
5. `AABB_FromSphere` (0x477330) — `min/max = [origin, origin+vel] ± max_dist ± 0.01`

**Actual role:** max_dist = sphere radius for AABB broad-phase. It controls which triangles the spatial tree returns. With max_dist=39, the AABB is 39 units wide → captures floor 26 units below a horizontal ray. With max_dist=5, the AABB is too tight → floor excluded → walls only.

### Rules

| # | Rule | Why |
|---|------|-----|
| 1 | **When a user questions a parameter, re-decompile the full chain** | Memory and prior docs may be based on partial analysis. The user has empirical evidence you don't. |
| 2 | **Trace through every function the parameter touches** | A parameter may be transformed, clamped, or repurposed at each level. Its role at level N may differ from its role at level N+1. |
| 3 | **Look for clamping/normalization you didn't see at level 1** | `Vec3_NormalizeAndScale(&direction, 99999.0)` at level 1 looked like the final ray length, but level 2 clamps velocity to 1000. |
| 4 | **Look for AABB/broad-phase queries that use the parameter as a radius** | Many collision systems do a two-phase query: broad-phase AABB → narrow-phase intersection. The parameter's role may only appear in the broad-phase function. |
| 5 | **User empirical evidence overrides decompilation confidence** | If the user says "changing max_dist from 39 to 5 changes the result," and your explanation says "max_dist doesn't affect the result," your explanation is wrong. Re-decompile. |

## 11. Verifying External Narrative Claims Against the Binary

When a user (or external document, blog post, or prior agent output) describes how a system works, **do not assume it is correct**. Pasted text about game architecture often contains plausible-sounding errors — invented function names, mislabeled vtable slots, conflated pipelines. Verify every claim against the binary itself.

### Methodology

1. **Extract every concrete claim** from the narrative: function names, addresses, vtable slot indices, struct offsets, calling conventions, "pipeline" descriptions.
2. **Search the binary for each named function.** If a claimed function does not exist (e.g., `GameObject_HandleCollision` when only `Level_HandleCollision` and `Arena_HandleCollision` exist), that is a fabrication — flag it immediately.
3. **Read vtables from constructors.** The constructor's first assignment (`*this = &vtable`) gives you the vtable address. Read the vtable as DWORD pointers to decode slot targets. Do NOT trust labels like "vtable[0x4C] = physics step 1" — decompile the actual function at that slot and verify what it does.
4. **Trace call chains, not just single functions.** A narrative may correctly identify a function's address but wrongly describe its role in the call chain. Example: claiming `Ball_AdvancePositionOrCollision` dispatches to event handlers, when it actually only does geometric mesh intersection — the event dispatch happens elsewhere.
5. **Check struct offset types.** A claim like "bumper slots at scene+0x10E3" may be using a DWORD index (where byte offset = 0x438C), not a byte offset. Verify which form the decompiled code uses.

### Common Error Patterns in External Narratives

| Error Type | Example | How to Detect |
|------------|---------|---------------|
| **Invented function names** | "GameObject_HandleCollision" | Search functions by name pattern; if zero results, it doesn't exist |
| **Mislabeled vtable slots** | "vtable[0x4C] = physics step 1" when it's actually race-end logic | Read vtable from constructor, decompile slot target, verify function behavior |
| **Conflated pipelines** | "Ball_AdvancePositionOrCollision dispatches events" when it only does geometric collision | Decompile the function; check if it reads the name string at collObj+0x864 or calls stricmp |
| **Wrong offset units** | "scene+0x10E3" as a byte offset when it's a DWORD index (×4 = 0x438C) | Check whether the decompiled code uses `[0x10E3]` (int-indexed) or `+0x10E3` (byte offset) |
| **Init vs per-frame confusion** | "bumper physics is in vtable[0x4C]-[0x58]" when bumper slots are populated at init by CreateBumper | Decompile all four vtable[0x4C]-[0x58] functions; check if any reference bumper slots |

### Output Format

Produce a verification table:

| Claim | Verdict | Evidence |
|-------|---------|----------|
| Two collision dispatchers exist | ✅ | Level_HandleCollision @ 0x40DCD0, Arena_HandleCollision @ 0x40E6A0 |
| `GameObject_HandleCollision` exists | ❌ | search_functions("HandleCollision") returns only Level/Arena, no "GameObject" variant |
| vtable[0x4C]-[0x58] are "physics steps 1-4" | ❌ | Decoded BoardLevel8 vtable: [0x4C]=Scene_HandleRaceEnd, [0x50]=Scene_UpdateBallsAndState, [0x54]=NoOp, [0x58]=Scene_ProcessRaceEnd |

### Rule

> **External narrative claims are hypotheses, not facts.** Every concrete claim (address, function name, vtable slot role, struct offset) must be verified against the decompiled binary. Plausible-sounding errors are common, especially when the narrative was generated by an LLM or reconstructed from partial analysis.

---

## 12. Finding and Patching Frame Rate Limiters

Most older Windows games cap FPS through multiple independent mechanisms. To uncap the frame rate, you must find and patch **all** of them — patching only one leaves the bottleneck at the next layer.

### Three Common FPS Limiters

#### Layer 1: Software Frame Limiter (Game Loop)

The game loop typically computes a target frame time from a hardcoded FPS constant and uses `GetTickCount()` to delay/skip frames until enough time has passed.

**How to find it:**
1. Decompile the main game loop (often `App::Run` or `WinMain`).
2. Look for `1000 / X` integer division — the divisor is the target FPS.
3. Trace where the divisor is set — usually in the constructor (`App_Ctor`) as a constant assignment to a struct field.
4. Check for a frame-skip check: `if (GetTickCount() - lastTick < frameTime - margin) skip`.

**Patch:** Change the constant at the assignment site (constructor) to a very high value (e.g., 1000). The constant is usually a 4-byte immediate in a `MOV [reg+offset], imm32` instruction.

#### Layer 2: D3D8/D3D9 Presentation Interval (VSync)

DirectX present parameters include a `PresentationInterval` field that controls vsync. `D3DPRESENT_INTERVAL_ONE` (value 1) syncs to vblank.

**How to find it:**
1. Decompile the graphics initialization function (where `CreateDevice` is called).
2. Look for a write to the present parameters struct at the offset for `PresentationInterval`.
   - D3D8: offset 0x1F8 within the Graphics object (if the object embeds present params inline), or search for `MOV [reg+0x??], 1` near `CreateDevice` calls.
   - The value `1` = `D3DPRESENT_INTERVAL_ONE`, `0` = `D3DPRESENT_INTERVAL_DEFAULT` (driver decides, usually immediate).
3. Also check for a device-reset path (e.g., `Graphics_Reset` after `LostDevice`) — it re-initializes present params and may re-apply vsync.
4. Verify via instruction search: `search_instructions(mnemonic="mov", operand_pattern="0x1f8")` then filter for instructions in graphics init/reset functions that write the constant `1`.

**Patch:** Change the immediate from `01 00 00 00` to `00 00 00 00` at both the init site and the reset site. Use `search_instructions` to find all write sites.

#### Layer 3: Timer Resolution (The Hidden Bottleneck)

`GetTickCount()` returns milliseconds with ~15.6ms granularity (the default Windows timer period). Even with a software limiter set to 1000 FPS (1ms frame time), GetTickCount can't measure sub-15ms intervals → effective cap is ~64 FPS.

**How to detect:**
1. Check if the game imports `timeBeginPeriod` — if it does, it may already set high-resolution timer.
2. Check if the main loop uses `QueryPerformanceCounter` (high-res) or `GetTickCount` (low-res).
3. A game that imports QPC but only uses it in a separate timer object (not the main loop) still has the problem.

**Solutions (in order of preference):**
1. **DLL injection** — Call `timeBeginPeriod(1)` at process start. This globally sets the timer to 1ms resolution. Simplest fix — one function call.
2. **Binary patch** — Replace `GetTickCount` calls in the game loop with `QueryPerformanceCounter`-based timing. Much more invasive: requires rewriting the timing arithmetic to convert QPC ticks to milliseconds.
3. **Accept the limit** — If the target is 60 FPS and the game already targets ~64 FPS via GetTickCount, no fix is needed.

### Methodology: Finding All Three Layers in One Pass

1. **Find the main loop** — Decompile `WinMain`, trace to the `while(!quit)` loop.
2. **Find the FPS constant** — Look for `1000 / X` division in the loop body. The divisor X is the target FPS. Trace backward to where X is written (usually constructor).
3. **Find vsync** — Search for `MOV [reg+offset], 1` instructions in the graphics initialization function. Cross-reference with D3D8 present parameter struct layout.
4. **Find the timer** — Check imports list for `GetTickCount` vs `QueryPerformanceCounter`. Check if `timeBeginPeriod` is imported and called.
5. **Convert VAs to file offsets** — Parse the PE section headers. For most games, `.text` VA=0x1000 maps to rawptr=0x1000 (1:1). Verify via `image_base + section_va` arithmetic.

### Runtime Struct Patching via Global Pointer (DLL Injection Alternative)

Instead of binary-patching the constructor's immediate value, you can
**patch the live struct at runtime** from an injected DLL. This is
preferable when the game re-reads the FPS field every frame (e.g.,
`frame_time = 1000 / app->target_fps` runs inside the loop body).

**Technique:**
1. Find the global pointer to the App/Game object in the `.data` section
   (e.g., `DAT_005341E0` stores `g_App` — set in the constructor).
2. In the DLL, dereference this pointer to get the actual struct address.
3. Use `VirtualProtect` to make the target fields writable, then write
   new values directly.

```c
/* Find g_App pointer at DAT_005341E0 (set by App_Ctor) */
DWORD *pAppPtr = (DWORD *)(0x005341E0 + module_offset);
DWORD appAddr = *pAppPtr;
DWORD *pTargetFPS = (DWORD *)(appAddr + 0x16C);  /* was 100 */
DWORD *pRenderFPS = (DWORD *)(appAddr + 0x170);  /* was 75  */

VirtualProtect(pTargetFPS, 4, PAGE_READWRITE, &old);
*pTargetFPS = 1000;
VirtualProtect(pTargetFPS, 4, old, &old);
```

### Render-Skip Conditional NOP

Beyond the two FPS value fields, the game loop often has a **conditional
jump** that skips `Present` when render timing isn't met. This is a
separate gate from the FPS values — even with FPS set to 1000, the
conditional still checks elapsed time and may skip frames.

**Pattern:** `JBE <skip_present_label>` at a known address.

**Patch:** NOP the 2-byte conditional (`76 5D` → `90 90`):

```c
unsigned char *pJBE = (unsigned char *)(0x0046BF55 + module_offset);
VirtualProtect(pJBE, 2, PAGE_EXECUTE_READWRITE, &old);
memcpy(orig_bytes, pJBE, 2);  /* save for unload */
pJBE[0] = 0x90;  /* NOP */
pJBE[1] = 0x90;  /* NOP */
VirtualProtect(pJBE, 2, old, &old);
FlushInstructionCache(GetCurrentProcess(), pJBE, 2);
```

**Verify the bytes first:** Read the original bytes via Ghidra MCP
(`read_memory`) to confirm they are `76 XX` (JBE rel8) or `0F 86 XX XX XX XX`
(JBE rel32) before patching.

### Three-Part FPS Unlock Summary

| Patch | What | How | Why |
|-------|------|-----|-----|
| Struct field 1 | `App+0x16C`: 100 → 1000 | Runtime write via g_App pointer | Update rate cap |
| Struct field 2 | `App+0x170`: 75 → 1000 | Runtime write via g_App pointer | Render rate cap |
| Conditional NOP | `0x46BF55`: `JBE` → `NOP NOP` | Byte patch in code section | Render-skip gate |

For a complete worked session including exact addresses, original bytes, DLL source, build commands, and gotchas, see `references/fps-unlock-the target-case-study.md`.

### PE Section Mapping for Patching (Binary Patch Alternative)

If you prefer a standalone binary patch instead of DLL injection:

```python
import struct
with open(exe_path, 'rb') as f:
    f.seek(0x3C)
    pe_offset = struct.unpack('<I', f.read(4))[0]
    f.seek(pe_offset + 4 + 2)  # skip sig + machine
    num_sections = struct.unpack('<H', f.read(2))[0]
    f.read(12)  # skip rest of COFF header
    opt_header_size = struct.unpack('<H', f.read(2))[0]
    f.read(2)
    opt_start = f.tell()
    f.seek(opt_start + 28)
    image_base = struct.unpack('<I', f.read(4))[0]
    f.seek(opt_start + opt_header_size)  # section headers
    for i in range(num_sections):
        name = f.read(8).rstrip(b'\x00').decode('ascii', errors='replace')
        vsize, va, rawsize, rawptr = struct.unpack('<IIII', f.read(16))
        f.read(16)
        # To convert VA to file offset:
        # rva = VA - image_base
        # file_offset = rawptr + (rva - va)
```

---

## 13. Building MinGW Cross-Compiled DLL Injection Hooks

When the user asks for a DLL injection shim to hook game functions, use
the `__fastcall` + dummy EDX workaround for `__thiscall` functions, avoid
SEH (use `IsBadReadPtr`), and cross-compile with `i686-w64-mingw32-gcc`.

**See `references/mingw-inline-hook-dll.md`** for the complete pattern:
inline hook engine, ASLR handling, safe pointer reads, DLL injector code,
build commands, and a MSVC→MinGW compatibility table.

Reference implementation: `the target-re/tools/collision_hook/`.
Reference implementation (FPS unlock): `the target-re/tools/fps_unlock/`.

## 14. Custom Physics Mods — Disable Engine Gravity at the Persistent Sub-Object Level

When a proxy DLL needs to override game physics (water buoyancy, low gravity, etc.), target the object's **persistent nested-object state**, not parent fields that the engine clears every frame.

### Case Study: target application `E:WATER` Mod

The first attempt modified `Ball+0x170/174/178` and treated `CollisionMesh+0xC7C` as a byte gravity toggle. Both were wrong:

- `Ball+0x170/174/178` are **ephemeral accumulators** zeroed by `Ball_Update` each frame. Writing them has no lasting effect on physics.
- `CollisionMesh+0xC7C` is a **float** gravity multiplier, not a byte. Set to `0.0f` it disables engine gravity; the default is usually `1.0f` (restored on exit).
- `CollisionMesh+0xC78` is overwritten with the ball radius every frame by `Ball_Update`, so it cannot be used as a tunable gravity strength.

#### Verified offsets

| Offset | Meaning |
|--------|---------|
| `Ball + 0x1A4` | `CollisionMesh*` |
| `CollisionMesh + 0xCA4` | persistent velocity.x |
| `CollisionMesh + 0xCA8` | persistent velocity.y |
| `CollisionMesh + 0xCAC` | persistent velocity.z |
| `CollisionMesh + 0xC7C` | float gravity multiplier |

Also verify which function is the real main tick. `0x405E00` is the actual `Ball_Update` (9,442 bytes, 2,541 instructions). `0x405190` is a **separate checkpoint/target-finding function** called from scene code at 0x41B5CF, 0x41B652, 0x41D7C2, and 0x421042 — NOT a respawn/break cleanup routine as previously documented. It starts with `mov al, byte [esi + 0x324]` (is_8ball early-exit gate) and contains the `[Z]`/`[X]` targeting loop that searches `Scene+0x1518` for nearest checkpoint objects. A decompilation file named `decomp_ball_update.c` was mislabeled — it decompiles `0x405190`, not `0x405E00`.

Full recipe and source: `the target-re/references/water-mod-physics.md`.

## Related Skills

- `the target-re` — Session-specific findings and verified field maps for target application RE
- `ghidra-mcp-headless` — Starting and using the GhidraMCP server
- `ghidra-rename-backup` — Export/import Ghidra renames to git
- `d3d8-com-proxy-logger` — D3D8 API interception for graphics RE
- See `references/level-collision-class-and-raycast.md` in this skill for a portable, game-agnostic guide to using the engine's own level-mesh raycast as a ground check.
- See `references/automated-windows-game-testing-wine-xvfb.md` for running and controlling Windows game binaries under Wine/Xvfb via an MCP server (useful for vision-model assisted RE testing).
- See `references/memory-analysis-suite.md` for adding full read/write/scan/monitor/freeze capabilities to a game-test MCP server — typed memory access, pointer chains, Cheat Engine style value scanning, address symbol resolution, and value freezing.
- See `references/hidden-stack-argument-trap.md` for detecting parameters that Ghidra hides because they are forwarded to tail-called helpers.
- See `the target-re/references/collision-raycast-system.md` for target application-specific collision addresses, constants, and class hierarchy.

## 22. The Fabricated Patch-Address Trap — Verify Every Address Before Writing It Into a Mod

When creating CE scripts, DLL mods, or binary patches, **every address must be verified by decompiling or disassembling the target function before it is written into the patch**. Citing addresses from memory, plausibility, or "it sounds right" produces scripts that silently fail or crash — because the address is either the wrong instruction, the wrong function, or doesn't exist at all.

**The error:** A CE AutoAssembler script to prevent game freezes with many entities was written with three patch addresses:

| v1/v2 Claim | Reality (from actual GhidraMCP decompilation) | Why It Failed |
|-------------|-----------------------------------------------|--------------|
| Patch A at `0x40690F` | `0x4068F5` is the `PUSH 0x14` (operator_new for CollisionNode). `0x40690F` is `MOV ECX,[ESI+0x14]` — a completely different instruction | Patched the wrong instruction; collision node was still created |
| Patch C at `0x005190` | `0x005190` is Ball_FindClosestRespawnPoint entry — a respawn function, not related to the freeze | Unnecessary patch that didn't address the root cause |
| Only one AI loop patched | `Ball_AI_ChaseNearest` (0x408390) has **TWO** O(N²) loops — Loop 1 at 0x4083D9 and Loop 2 at 0x408548 | Only patched one of two loops; freeze persisted |
| Missing alloc patches | `Ball_Update` (0x405E00) allocates at 0x405ECB (trail) and 0x4068F5 (CollisionNode) every frame | Heap fragmentation crash path unaddressed |

**Root cause:** All addresses were cited from plausibility without decompiling the actual functions. The user reported "the script still doesn't stop the game from crashing." v3 was rebuilt entirely from GhidraMCP decompilation — every patch point, skip target, original byte count, and NULL-path existence was verified against the actual disassembly.

### Verification Protocol for Patch Addresses

Before writing any address into a CE script, DLL mod, or skill doc:

1. **Decompile the target function** via GhidraMCP (`decompile_function?address=0xNNNN`)
2. **Disassemble the patch point** via `disassemble_function?address=0xNNNN&count=N` to get exact bytes and instruction boundaries
3. **Verify skip/jump targets exist** by disassembling the target address — confirm the instruction there is the correct post-loop or NULL-path entry
4. **Count the original bytes** you're overwriting — a 5-byte JMP may split a multi-byte instruction (see pitfall #24)
5. **Check NULL/early-exit paths** — if your patch returns a sentinel value (NULL, 0), verify the function already has a code path that handles that value gracefully
6. **Cross-reference struct offsets** — if the patch reads `[Scene+0x29D8]` for ball count, verify that offset is actually the AthenaList size field by decompiling a function that reads it (e.g., `AthenaList_NextIndex`)

### Rule

> **Every patch address in a mod or CE script is guilty until proven innocent by disassembly.** Citing an address from memory or plausibility is fabrication. The user will test it, it won't work, and trust is lost. Always decompile the target function and disassemble the exact patch point before writing the address into any artifact (script, DLL, skill doc, or commit message).

### When Prior Skill Docs Are Wrong

If a reference file in a skill contains unverified addresses from a prior session (as `entity-collision-architecture.md` did with 0x40690F and 0x005190), **rewrite the reference file** with verified addresses. Don't patch around the wrong addresses — replace them entirely. A reference file with fabricated addresses is worse than no reference file because future agents will trust it and propagate the errors.

---

## 23. Raw Binary String-Reference Analysis — Finding Code That Checks a String

When you need to find ALL code that checks for a specific string (e.g., a prefix like `"O:"`, a keyword like `"(NOSHADOW)"`, or an event name), do NOT rely solely on decompiled `.c` files. Decompiled files are a subset of the binary — many functions are never decompiled. The definitive method is to search the raw binary directly.

### The Technique (3 Steps)

**Step 1: Find the string in the .rdata section.**

Read the binary as bytes. Search for the target string as a null-terminated sequence. Record its virtual address (VA = image_base + file_offset).

```python
with open(exe_path, 'rb') as f:
    data = f.read()
IMAGE_BASE = 0x400000

target = b'O:\x00'  # null-terminated "O:"
idx = data.find(target)
va = IMAGE_BASE + idx
print(f'"O:" found at VA 0x{va:06X}')
```

**Step 2: Search for references to that VA in the .text section.**

On x86, a string reference appears as `push 0x004D902C` (opcode `68 2C 90 4D 00`). Search for the VA as 4 little-endian bytes:

```python
addr_bytes = va.to_bytes(4, 'little')  # e.g., b'\x2C\x90\x4D\x00'
start = 0
while True:
    idx = data.find(addr_bytes, start)
    if idx == -1: break
    ref_va = IMAGE_BASE + idx
    if 0x401000 <= ref_va < 0x4CF000:  # .text section
        print(f'  Reference at VA 0x{ref_va:06X}')
    start = idx + 1
```

**Step 3: Disassemble the context around each reference.**

Each reference is typically part of a `push` instruction before a `strnicmp`/`strcmp` call. Decode the surrounding bytes to understand the check:

```python
# Typical pattern: push length; push name; push "O:"; call strnicmp; cleanup; test; jnz skip
# 6A 02          push 2              ; length
# 50             push eax            ; name pointer  
# 68 2C 90 4D 00 push 0x004D902C     ; "O:"
# E8 87 5B 06 00 call strnicmp
# 83 C4 0C       add esp, 0xC        ; cleanup 3 args
# 85 C0          test eax, eax
# 75 07          jnz +7             ; jump if NOT "O:"
# C6 85 62 08 00 00 01  mov byte [obj+0x862], 1  ; set flag!
```

### Case Study: The O: Prefix Error (Session 1863)

**Wrong approach**: Searched only decompiled `.c` files for `"O:"` string comparisons. Found zero matches. Concluded: "O: is a designer convention with no engine behavior." Wrote this to docs and skill.

**Correct approach**: Searched the raw binary for `b'O:\x00'` → found at VA 0x4D902C in .rdata. Searched for `b'\x2C\x90\x4D\x00'` in .text → found at VA 0x461AE7. Decoded the surrounding bytes → `push "O:"; call strnicmp; if match: mov byte [obj+0x862], 1` (sets is_translucent flag). User had already verified this empirically by changing O: to A: in a level file and seeing the ball stop rendering behind tubes.

### Why Decompiled Files Are Insufficient

- 841 KB of .text code, ~800-1200 estimated functions, only ~83 decompiled (6-10% coverage)
- The function checking `"O:"` was at ~0x461680 — never decompiled
- Searching decompiled files can only find checks in functions you've already processed
- The raw binary search finds ALL references regardless of decompilation status

### Rule

> **Never conclude "the engine doesn't check X" based only on decompiled files.** Always do a raw binary string-reference search. Find the string in .rdata, search for its VA as 4 bytes in .text, and decode the context around each hit. This takes 30 seconds and prevents confidently-wrong conclusions.

## 26. Hidden Feature & Debug Tool Analysis

When a user asks "are there any secret developer menus, cheat codes, or debug tools in this game?", use a systematic 5-step methodology: (1) search all function names for debug/cheat/secret/admin/god/console patterns, (2) search the .rdata string table for the same patterns, (3) get cross-references for every hit, (4) decompile referencing functions to determine actual purpose, (5) report what IS and IS NOT in the binary.

**Key insight:** Many "interesting" function/string names turn out to be legitimate game features (e.g., `CreateSecretObjects` → arena unlock mechanic, `SafeMode` → graphics option, `SUPER` → level design parameter for sawblades). Always decompile and verify before declaring something a hidden feature.

- `references/hidden-feature-analysis.md` — Complete methodology, GhidraMCP endpoint reference (parameter quirks for `search_functions` vs `search_strings`), comprehensive search pattern lists, and the target application case study.

## 25. The Decompilation-Derived Data Trap — Verify Catalogs Against Actual Game Data Files

When documenting "all objects that exist in a game" or "all entity types in each level," do NOT derive the list from decompiled factory `__strnicmp` checks alone. The factory code tells you what names the factory *can match*, not what names actually *exist in the shipped data files*. These are different sets, and conflating them produces inflated, fabricated catalogs.

### How the Error Happens

1. You decompile a factory function and see `__strnicmp(refName, "SPEEDCYLINDER", 13)` → you add "SPEEDCYLINDER" to the catalog
2. You see `__strnicmp(refName, "N:BUMPER", 8)` → you add "N:BUMPER" to the catalog
3. But `N:BUMPER` is a **Section 6 entity name** (geometry behavior modifier), not a Section 1 ref point (object spawn marker). The factory checks both systems, and you can't tell which is which from the factory code alone
4. You also can't tell which refs are actually placed in the shipped level files vs. which the factory can handle but no level uses

### The Fix: Parse the Actual Data Files

Always write a spec-compliant binary parser for the game's data format and extract the ground truth from the shipped files. Compare the parsed results against the decompilation-derived lists. The difference between the two reveals:
- **Fabricated entries** — names in the decompilation list that don't exist in any data file
- **Section confusion** — names that exist in a different section of the file than you assumed
- **Missing entries** — names in the data files that the decompilation missed (factory handles them but you didn't decompile that factory)

### Case Study: target application "75 refs" → 46 refs (Session 10859)

Previous documentation claimed "75 unique ref types" across 15 race levels. This was wrong:
- **Actual count**: 46 unique object types (parsed from original MESHWORLD binary files)
- **Inflated by**: counting Section 6 entity names (N:/E:/T: prefixed geometry behavior modifiers) as if they were Section 1 ref points
- **Fabricated entries**: `N:BUMP`, `N:BUMPER`, `N:GLASS`, `N:TENBONUS1/2`, `N:SPINNER`, `N:ONGEAR`, `N:ONROTATOR`, `N:BOUNCE`, `N:SQUAREWOBBLY`, `N:SAWTEETH`, `N:SPINNY`, `N:WAVY`, `EDGECYLINDER`, `FLICKNING`, `VAC-IN` — none of these exist as Section 1 ref points in any race MESHWORLD file
- **Missing entries**: `MOUSETRAP`, `TARBUBBLE`, `FANSLOW`, `SAW-BREAK`, `LAUNCH`, `SIGN-TARPIT`, `PILLAR`, `MAGNIFYER` — these exist in the data files but were not in the decompilation-derived list
- **Wrong level assignments**: `BUMP`/`BUMPER` listed for Beginner (Beginner has NO object refs), `BONK` listed for Intermediate (BONK is only in Expert and Master), `SAW`/`SAW2` listed for Expert (these are Toob-only)

### Rule

> **Decompilation tells you what code *can do*. Data files tell you what the game *actually does*.** When documenting a catalog of game objects, entity types, or content per level, always verify against the actual shipped data files using a spec-compliant parser. Decompilation-derived lists are hypotheses; parsed data is ground truth.

## 16. The Fabricated Call-Chain Trap — Verify Xrefs Before Documenting Function Behavior

When documenting what a function does, **always verify who calls it** using GhidraMCP's `get_function_xrefs` endpoint. A function's purpose is defined by its call chain, not by a guessed name or a plausible-sounding narrative. Failing to verify xrefs leads to fabricating relationships between functions that don't exist.

### Case Study: Ball_Shatter and E:JUMP (Session 2093)

**The error:** I decompiled `Ball_Shatter` (0x408D70) and described it as "a power-up triggered by E:JUMP collision objects." This was completely fabricated — E:JUMP does NOT call this function. The E:JUMP handler (in `DispatchCollisionEvents` at 0x40C5D0) does something entirely different: plays a 3D sound, applies upward force, adds +200 score.

**Root cause:** I assumed the call relationship based on:
- The function name "Ball_Shatter" sounding like a power-up
- Superficial similarity between "split" and "jump" game mechanics
- Not checking xrefs at all

**The fix:** Verified xrefs via `curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0x408D70"`:
```
From 0043fe36 [UNCONDITIONAL_CALL]
From 0043f722 [UNCONDITIONAL_CALL]
```
Both call sites are inside `FollowBall_Update` (0x43ECC0) — a MeshNode vtable method, not a collision handler.

### Verification Protocol

Before documenting a function's behavior:

1. **Get xrefs**: `curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0xADDR&limit=50"`
2. **Find containing function**: If xref addresses aren't function starts, search the function list for the nearest function before each address: `curl -s "http://127.0.0.1:8089/list_functions?page=1&limit=5000" | grep -i <pattern>`
3. **Decompile the caller**: Read the calling function to understand the context in which the target is invoked.
4. **Verify CALL opcodes in raw binary**: Confirm xref accuracy by checking the bytes at the call site:
   ```python
   # Read bytes at the xref address
   off = call_site_va - IMAGE_BASE
   byte = data[off]
   if byte == 0xE8:  # CALL rel32
       rel32 = struct.unpack_from('<i', data, off + 1)[0]
       target = call_site_va + 5 + rel32
       assert target == expected_function_va
   ```
5. **Check vtable dispatch**: If no direct CALL xrefs exist, the function is called through a vtable. Read the vtable from the constructor and map slot offsets to function pointers.

### Rule

> **Never document a function's purpose without verifying who calls it.** A function name is a hypothesis about behavior. Xrefs are proof of the call chain. If the call chain contradicts the function name, the call chain wins — rename the function in Ghidra and correct the docs.

### When Ghidra Inlines Calls

Ghidra's decompiler may inline calls, making them invisible in the decompiled C output. The `get_function_xrefs` endpoint still returns the correct call sites from the binary's call graph. If the decompiled C doesn't show a call but xrefs say one exists, trust the xrefs — the call is there in the machine code.

## 17. Vtable Reachability Analysis — Destructor vs Constructor Vtables

A function found in a vtable slot may **never be dispatched during gameplay** if that vtable is the destruction-time vtable rather than the runtime vtable. In C++, during object destruction, the vtable pointer is swapped to a base-class vtable to prevent calling overridden methods on a partially-destroyed object. A function that exists only in the destruction-time vtable is unreachable through virtual dispatch during normal operation.

### The Trap

You decompile a function, find it in a vtable at slot N, and conclude "this is called every frame." But if you checked the **destructor's vtable** instead of the **constructor's vtable**, the function may be dead code.

### Case Study: Ball_Shatter (Session 2232)

**Function:** `0x408D70` — allocates 3 `Ball_Split` objects in a loop, sets AI flags, adds to ball list.

**Found in:** Vtable `0x4D4F38` at slot 11. This vtable is set by `MeshNode_SimpleDtor` (0x434270), whose only code is:
```asm
mov dword [ecx], 0x004D4F38   ; set destruction vtable
jmp Level_Cleanup               ; tail-call cleanup
```

**NOT found in:** The **constructor** `FollowBall_Ctor` (0x43EBC0) sets vtable to `0x4D5D24`, which has only **9 code entries** (slots 0–8). After that it's float constants — the vtable ends at slot 8. Slot 11 does not exist in the runtime vtable.

**Conclusion:** `FollowBall_Update` (0x43ECC0) at slot 11 of the destruction vtable is **unreachable through virtual dispatch during normal gameplay**. The function `Ball_Shatter` it calls may be dead code or cut content.

**User confirmation:** "There's no point in the game where a single ball is turned into multiple balls." This external evidence matched the binary analysis — the code exists but is never reached.

### Methodology: Which Vtable Is Active at Runtime?

1. **Read the constructor** — the first assignment is always `this->vtable = &RuntimeVtable`. This is the vtable active during normal gameplay.
2. **Read the destructor** — it sets a different vtable (`this->vtable = &DestructionVtable`) before calling cleanup. This is only active during destruction.
3. **Check slot count** — the runtime vtable may have fewer entries than the destruction vtable. After the last code-pointer entry, remaining data is floats/constants (not vtable slots).
4. **Verify a slot exists in the runtime vtable** — if the function is at slot N in the destruction vtable but the runtime vtable ends before slot N, the function is **never dispatched during gameplay**.

### Determining Vtable End

Code pointers in target application are in range `0x401000–0x4CF000`. After the last valid code pointer, the vtable data transitions to floats (values like `0x3F800000` = 1.0f, `0xCCCCCCCD` = magic division constant). These are NOT vtable entries — they are a different data structure that happens to follow the vtable in memory.

```python
def vtable_slot_count(raw, vtable_va, image_base=0x400000):
    """Count real code-pointer entries in a vtable."""
    off = vtable_va - image_base
    count = 0
    while off + 4 <= len(raw):
        val = struct.unpack_from('<I', raw, off)[0]
        if 0x401000 <= val <= 0x4CF000:  # code address range
            count += 1
            off += 4
        else:
            break
    return count
```

### Rule

> **Always check the constructor's vtable, not just any vtable that contains the function.** A function in the destruction-time vtable but absent from the runtime vtable is unreachable through virtual dispatch during normal gameplay. Treat it as potentially dead code until you find a non-virtual direct call site.

### When the Function IS Reachable but Still Suspicious

Even when a function IS in the runtime vtable, verify that the code path reaching the call is conditionally reachable. Trace the caller and check for guard conditions. In the Ball_Shatter case, even if FollowBall_Update were reachable, it has guards:
- `+0x324 == 0` (in-tube flag must be false)
- `+0x744 == 0` (camera shake timer must be expired)

These conditions may never be simultaneously true during gameplay, making the function effectively dead even if technically callable.

---

## 18. User Game Knowledge as First-Class Evidence

When a user who has played the game extensively says "there's no point in the game where X happens," treat this as **strong evidence** that the code may be dead/cut content — even if the binary contains the allocation logic and appears functional.

### Why This Matters

LLM-driven RE tends to reason from code patterns: "this function allocates 3 objects and sets AI flags, therefore it creates 3 AI balls during gameplay." This reasoning is valid about **what the code does** but invalid about **when the code runs**. Code can exist in a binary without ever being executed:

- **Cut content** — developer implemented a feature, then disabled it by removing the trigger but leaving the implementation.
- **Debug/test code** — developer-only paths that are never reached in release builds.
- **Dead branches** — guard conditions that are never simultaneously true.
- **Destruction-only vtables** — functions that only exist in a vtable set during object destruction (see §17).

### Protocol

When the user challenges a function's purpose:

1. **Don't defend the existing documentation.** The user has empirical knowledge you don't.
2. **Check reachability** — is the function actually called during gameplay? (vtable analysis, xref verification, guard condition tracing)
3. **Check for dead code patterns** — destruction-only vtables, unreachable guards, cut content markers.
4. **If reachability can't be confirmed, say so.** "The code exists and does X, but I cannot confirm it's ever executed during gameplay" is a more honest answer than confidently documenting a gameplay mechanic.

### Case Study

User: "Are you sure that function 0x408D70 splits an 8 ball into three balls? There's no point in the game where a single ball is turned into multiple balls."

**Wrong response:** Defend the existing docs — "The decompilation shows it allocates 3 Ball_Split objects..."

**Correct response:** Investigate reachability. Check whether the vtable containing the function is the runtime vtable or the destruction vtable. If the function is unreachable, acknowledge it may be dead code and update the docs accordingly.

### Rule

> **User gameplay knowledge overrides decompilation-pattern reasoning.** A function that "looks like it does X" but is never reached during gameplay is not a gameplay mechanic. Always verify reachability before documenting a function as a live feature.

---

## 19. Batch Decompilation at Scale

When the user asks to decompile and document all (or hundreds of) functions in a binary, use a systematic batch workflow: fetch the full function list, diff against already-documented files, process in batches of 10 (decompile + get xrefs + write analysis file with standardized header), maintain a JSON function database for progress tracking, and commit+push+report after every batch. Each analysis file must include the full Ghidra signature, parameter descriptions, struct offsets, and cross-reference summary — not just the function name.

**See `references/batch-decompilation-workflow.md`** for the complete workflow including Python batch-fetch code, analysis file template, JSON database schema, commit cycle, and common Athena Engine function patterns.

### Fast Bulk Decompilation (3000+ functions)

For pure decompilation without per-function analysis, `execute_code` with a tight loop of `urllib.request.urlopen` calls is fastest (~3 funcs/sec). The 5-minute `execute_code` timeout processes ~900 functions per call. Write each result as `{FuncName}_0x{ADDR}.c` in a `batch_auto/` subdirectory.

**Key technique:** Use `execute_code` to fetch+write in bulk (no per-function tool calls), then check how many remain, then repeat. Each iteration finishes ~900 functions. Total time for ~3300 functions: ~3 minutes of execute_code calls.

**Pitfall:** The `execute_code` 5-minute timeout will kill scripts that try to process too many functions in one call. Break into iterations that each handle ~900, check remaining count between iterations.

**Pitfall:** The `Unwind@` functions (exception unwinding records) have non-standard addresses like `0x004cdc4c` — they still decompile fine via `decompile_function?address=0xADDR`, just use the address as-is.

### Function Name Verification After Batch Decompilation

**ALWAYS verify function names after batch-decompiling.** Function names in Ghidra can be auto-generated, manually-assigned-but-wrong, or misleadingly named after just one of many behaviors. When a user says "beware, names can be misleading" or "double check the names," apply systematic misnomer detection.

**See `references/function-name-verification-methodology.md`** for the complete heuristics, batch scanning script, false-positive awareness, and confirmed misnomer catalog. Key heuristics:

**For deep analysis of individual critical functions** (when the user says "go through this three more times" or "take a decent amount of time on longer functions"), **see `references/deep-function-analysis-methodology.md`**. It covers the three-pass method (structure → parameters/offsets → constants/globals), resolving `PTR_DAT_`/`_DAT_` symbols from the raw binary, converting hex immediates to float, and vtable-dispatch categorization. Key heuristics:

1. **Constructor call counting** — `CreateX` with 3+ distinct `_ctor` calls is a multi-object factory
2. **Rendering call detection** — `Tick`/`Update` with 3+ `Matrix_Scale4x4` calls is actually a render function
3. **String literal mismatch** — function name says one concept, 199 string literals say another
4. **Event handler detection** — `CreateX` with 0 `operator_new` but 5+ `__stricmp` calls is a handler, not a factory
5. **Xref context** — 28+ call sites from unrelated subsystems = general-purpose handler

**False positive awareness:** D3D8 vtable dispatches (`(**code**)` patterns) make `Render` functions appear to have "no draw calls" — they ARE render functions, just using indirect calls. Do not flag these.

### Deep Analysis of Critical Functions After Batch Decompilation

After batch-decompiling and scanning for misnomers, the user may ask to "go through the critical functions three more times" to make 100% sure the analysis is accurate. This is a different workflow from the batch scan — it's a focused deep-dive on individual functions. Apply the three-pass method from `references/deep-function-analysis-methodology.md`:

1. **Pass 1 (Structure):** Read the full decompilation, identify all branches, gate conditions, and dispatch patterns.
2. **Pass 2 (Parameters/Offsets):** Trace every struct offset read/written. Verify the calling convention by decompiling a caller. Document sub-object pointer chains.
3. **Pass 3 (Constants/Globals):** Resolve every `_DAT_`, `PTR_DAT_`, and hex immediate by reading the raw binary at the VA. Convert hex to float. Categorize vtable dispatch calls by resource type.

The output is a structured document (`CRITICAL_FUNCTION_ANALYSIS.md` in the repo) with: calling convention, parameter table, all struct offsets accessed (with read/write direction and field meaning), all event/dispatch branches with conditions and actions, verified constants, and call site list.

## 21. Parameter Discovery via RET N and Call-Site Disassembly

When a user asks "what are ALL the parameters to function X," Ghidra's decompiler often shows `undefined4` for every param and doesn't reveal their true types. The definitive answer requires combining disassembly, decompilation, call-site analysis, and call-chain tracing.

### The RET N Technique (Parameter Count)

For `__stdcall` and `__thiscall` functions, the `RET N` instruction at the function epilogue tells you exactly how many bytes the function cleans from the stack. Each parameter is 4 bytes (32-bit).

```
RET 0x3C  →  0x3C = 60 bytes  →  60 / 4 = 15 stack parameters
```

For `__thiscall`, add 1 for the `this` pointer in ECX (not on the stack). So `RET 0x3C` with `__thiscall` = 15 stack params + 1 `this` = 16 total parameters.

**Verify calling convention from the prologue:**
- `MOV ESI,ECX` or `MOV EDI,ECX` → `__thiscall` (ECX = `this`)
- `PUSH EBP; MOV EBP,ESP` → `__stdcall` or `__cdecl` (all params on stack)
- `RET N` (N > 0) → `__stdcall` or `__thiscall` (callee cleans stack)
- `RET` (N = 0) → `__cdecl` (caller cleans stack)

### Call-Site Push Sequence Analysis

Disassemble a caller to see the exact push order before the `CALL`. Parameters are pushed right-to-left (C calling order), so the LAST push before CALL is the FIRST parameter.

Watch for `SUB ESP,0x14` blocks (20 bytes = 5 DWORDs) — these reserve stack space for by-value struct parameters. A `Vec3` or transform object passed by value occupies 5 DWORDs: `[vtable_ptr, data0, data1, data2, data3]`.

```asm
; Example: caller pushing params for UI_DrawTextCentered (thiscall, 15 stack params)
; Two SUB ESP,0x14 blocks create two 5-DWORD struct params on the stack
SUB ESP,0x14        ; reserve 20 bytes for transform_obj1 (params 6-10)
...
CALL Matrix_Scale4x4 ; fills transform_obj1 = [vtable, R, G, B, A]
SUB ESP,0x14        ; reserve 20 bytes for transform_obj2 (params 11-15)
...
CALL Matrix_Scale4x4 ; fills transform_obj2 = [vtable, R, G, B, A]
PUSH 3              ; param_5 (shadow_offset_y)
PUSH 3              ; param_4 (shadow_offset_x)
PUSH 0x84           ; param_3 (y)
PUSH 0x1EA          ; param_2 (x)
PUSH 0x4D6D5C       ; param_1 (text string ptr)
MOV ECX, font_obj    ; param_0 (this)
CALL UI_DrawTextCentered
```

### Call-Chain Tracing for Parameter Types

After counting parameters, trace them through the call chain to determine their types and purposes:

1. **Decompile the target function** — note which params are passed to sub-functions and how.
2. **Decompile the sub-functions** — follow each parameter to see what operations are performed on it.
3. **Check the deepest function** — the real meaning often appears 3-4 functions deep (see §10, the Partial-Decompilation Trap).
4. **Verify with multiple callers** — decompile 2-3 different callers to see what values they pass for each parameter. Constants like `0x3F800000` (1.0f) vs `0` reveal the semantic difference between params.

### The Overwritten-Parameter Trap — When a "Required" Param Is Actually Ignored

After counting parameters via RET N and tracing their types through the call chain, check whether each parameter is actually **read** by the function body. Some functions overwrite incoming parameters on the stack before using them, effectively ignoring the caller's value.

**Detection:** Decompile the function and check if any parameter is immediately overwritten:
```c
// Ghidra shows param_6 being copied into a stack struct, but the FIRST DWORD
// of that struct is set to a hardcoded constant BEFORE the copy:
SUB ESP,0x14        ; reserve 20-byte struct on stack
MOV EAX,ESP
MOV dword ptr [EAX],0x4cf300   ; overwrites param_6 with constant!
MOV ECX,[ESP+0x5C]             ; reads param_7 (the REAL data)
MOV [EAX+0x4],ECX               ; stores param_7 into struct[1]
```

**Case Study: UI_DrawTextCentered (0x409C60).** Previous documentation claimed params 6 and 11 (vtable pointers for color structs) were "required" and would crash if not set to `0x4CF300`. Disassembly revealed both are overwritten with a hardcoded `0x4CF300` immediate inside the function body — the caller's values are never read. Passing 0 or NULL works fine. The actual color data lives in the adjacent params (7–10 for text RGBA, 12–15 for shadow RGBA).

**Rule:**
> **A parameter that is overwritten before use is not "required" — it's a placeholder.** Previous documentation claiming it must be a specific value is wrong. Verify by checking the function body's write sequence, not just the parameter count.

### The Struct-Expansion Pitfall for Call Wrappers

When a function expects N individual DWORDs on the stack (verified via RET N), but a mod API wrapper passes some of them as a struct, the stack may be misaligned. A `Color { float r,g,b,a; }` struct (16 bytes) can be passed as:
- **4 individual floats** (4 DWORDs pushed) — correct
- **1 pointer** (1 DWORD pushed) — wrong, produces N-3 params instead of N

The function's RET N will try to clean N×4 bytes but only (N-3)×4 were pushed → stack corruption. This is the **most common cause of silent failure** when calling engine text/rendering functions from a mod API wrapper like `CallMethod`.

**Rule:**
> **When calling engine functions via a generic `CallMethod` wrapper, always expand structs to individual primitive arguments.** Never pass a struct by value through a generic wrapper — the wrapper may not know to push each field separately.

### Tools Required

- `disassemble_function?address=0xNNNN` — get raw asm, find `RET N` and prologue
- `decompile_function?address=0xNNNN` — get C pseudocode for function body
- `read_memory?address=0xNNNN&length=N` — read vtable entries, decode float constants, read string data
- `get_function_xrefs?address=0xNNNN` — find callers to decompile for call-site analysis
- `create_function` (POST) — if a vtable slot points to undetected code, create the function first

---



When the user asks to catalog all global variables in a binary, use the `list_globals` and `list_data_items_by_xrefs` endpoints, then resolve xrefs for each global via POST `get_bulk_xrefs`. Filter out system entries (TEB, IAT, string constants, vtable dtor pointers, exception tables, RTTI) to isolate game-specific globals.

### Workflow

1. **List segments** to identify `.data` (mutable globals) vs `.rdata` (read-only data) ranges.
2. **List globals** via `list_globals` — returns labeled symbols.
3. **List all data items** via `list_data_items_by_xrefs` — includes auto-named `PTR_`/`DAT_` items, sorted by xref count.
4. **Categorize** by name pattern and address range (see table below).
5. **Batch-fetch xrefs** via POST `get_bulk_xrefs` for all game-relevant addresses (20 per batch).
6. **Resolve xref addresses** to function names via binary search on the function list.
7. **Decompile key functions** to understand each global's actual purpose (e.g., is `PTR_OBJ_VTABLE` a vtable, an RNG state, or both?).
8. **Document** each global with: address, type, size, xref count, description, and list of usage locations (function+offset).

### Categorization Filters

| Exclude | Pattern | Why |
|--------|---------|-----|
| TEB entries | address `0xFFDFF000-0xFFDFFFFF` | System thread environment block |
| IAT imports | `PTR_*` at `0x004CF000-0x004CF2FF` | Windows API import thunks |
| String constants | `s_*` with `[string]` type | Read-only string literals |
| Vtable dtors | `PTR_*Dtor*`, `PTR_*ScalarDtor*` | C++ virtual destructor function pointers |
| Exception tables | type starts with `FuncInfo`, `UnwindMap`, `HandlerType` | MSVC SEH tables |
| RTTI | `RTTI_*`, `TypeDescriptor` | C++ runtime type info |
| Resources | `Rsrc_*` | Icons, cursors, embedded DLL |

### Key Technique: Decompiling to Identify Global Purpose

Globals with auto-generated names (`PTR_PTR_004f7188`, `PTR_OBJ_VTABLE`) give no hint to their purpose. Decompile 2-3 functions that reference them:

- `PTR_OBJ_VTABLE` used as `RNG_Rand(&PTR_OBJ_VTABLE, ...)` → it's an RNG state table
- `PTR_PTR_004f7188` used as `Math_Atan2Angle(&PTR_PTR_004f7188, x, z, ...)` → trig lookup table
- `PTR_PTR_004f7448` used as `AthenaString_Format(0x4f7448, &format)` → string format table

Static init functions (typically at `0x004CE4XX-0x004CE5XX`) reveal what each global points to:
```c
void FUN_004ce500(void) {
    PTR_OBJ_VTABLE = (undefined *)&PTR_LAB_004d8f88;  // sets to vtable in .rdata
    return;
}
```

For full curl recipes and the xref resolution script, see the `ghidra-mcp-headless` skill's `references/data-and-global-analysis.md`.

## 24. The Uninitialized MeshWorld Field Trap — Force-Set Deep Struct Fields After MeshWorld_ctor



- `references/multi-file-offset-verification.md` — Deep-dive on raw-C ref-count methodology.
- `references/doc-vs-decomp-trust-boundary.md` — When existing RE docs contain wrong offsets; verification protocol for user challenges.
- `references/radare2-cross-reference-verification.md` — Using radare2 to independently verify Ghidra decompilation against the raw binary: call targets, offset mappings (the int* trap), collision type dispatch, arithmetic idioms, epilogue, and mislabeled file detection.
- `references/automated-struct-verification.md` — Python script template for systematic struct verification via GhidraMCP.
- `references/windows-registry-analysis.md` — Analyzing Windows registry persistence in games.
- `references/d3d8-texture-filtering-complete.md` — Complete D3D8 texture filtering analysis.
- `references/d3d8-texture-filtering-binary-analysis.md` — Binary hex-pattern technique for finding D3D8 filtering state in raw executables.
- `references/grounded-state-detection.md` — Reliable ground-state detection for custom jump mechanics.
- `references/level-collision-class-and-raycast.md` — Reusing the engine's own ray-vs-level-mesh probe for ground checks.
- `references/save-function-hook-selection.md` — Choosing the right save hook for mod settings.
- `references/fps-unlock-the target-case-study.md` — Worked example of finding/patching a frame-rate cap in `target_binary.exe`.
- `references/meshworld-uninitialized-field-trap.md` — Worked example of the MeshWorld +0x878 uninitialized field crash when globalizing the Drawbridge object (force-set App pointer after MeshWorld_ctor). Includes decision table for when the fix is NOT needed.
- `references/cea-global-object-spawning.md` — Complete CEA script pattern for spawning level-specific objects globally via Ball_Update runtime hooks. Object catalog, mesh loading, constructor calling conventions, and pitfalls.
- `references/automated-windows-game-testing-wine-xvfb.md` — MCP server that controls a Windows game running under Wine/Xvfb for vision-assisted RE testing.
- `references/memory-analysis-suite.md` — Full memory analysis suite pattern for MCP servers: typed r/w, pointer chains, value scanning, monitoring, freezing, and address symbol registries.
- `references/function-name-verification-methodology.md` — Heuristics for detecting misnamed functions after batch decompilation, with batch scanning script and confirmed misnomer catalog.
- `references/deep-function-analysis-methodology.md` — Three-pass method for thoroughly understanding individual critical functions: resolve PTR_DAT_/_DAT_ globals from raw binary, convert hex immediates to float, categorize vtable dispatch calls, and produce structured parameter/offset documentation.
- `references/hidden-feature-analysis.md` — Systematic search for hidden developer menus, cheat codes, debug toggles, and easter eggs in game binaries. GhidraMCP endpoint quirks, comprehensive pattern lists, and the target application case study.
