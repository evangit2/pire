# Documentation vs Decompilation Trust Boundary

Existing reverse-engineering documentation (APP_OBJECT.md, SCENE_OBJECT_MODDING.md, etc.) can contain offsets that are wrong, outdated, or contradicted by raw decompiled C. Treat every documented offset as a **hypothesis** until verified against the actual decompilation files.

## The Problem

Offsets in docs accumulate over time from:
- Early Ghidra analysis with incomplete symbol recovery
- Copy-paste between parent and nested object offsets
- Int-indexed notation (`param_1[0x5C]`) misread as byte offsets
- Human error: `0x184` documented as `Scene*` when decomp shows `gameUpdateObj`

When a user asks "is this right?" they have spotted a contradiction or suspect an error. **Never defend the doc.** Always verify.

## Verification Protocol

When asked to verify a documented offset:

### Step 1: Run the automated verifier (preferred)
Use the automated verification script to systematically decompile and score all claimed offsets:
```bash
# See skill support file: references/automated-struct-verification.md
cp /home/evan/.hermes/skills/reverse-engineering/game-reverse-engineering/references/automated-struct-verification.md /tmp/verify_struct.py
# Edit FUNCTION list and CLAIMED_OFFSETS dict, then run
python3 /tmp/verify_struct.py > /tmp/verify_report.md
```

This is faster and more reliable than manual grep for large structs (50+ fields).

### Step 2: Manual raw-C grep (fallback for small structs or spot-checks)
```bash
# Direct byte-offset references in App functions
grep -rn '(int)this + 0x184)' analysis/ghidra/decompilations/app/
grep -rn '(int)param_1 + 0x184)' analysis/ghidra/decompilations/app/

# Array-index references (N * 4 = byte_offset)
grep -rn 'param_1\[0x5' analysis/ghidra/decompilations/app/decomp_app_run.c
```

### Step 2: Check what OTHER offsets in the same doc say
A wrong offset is rarely isolated. If `+0x184` is wrong, check `+0x178`, `+0x180`, `+0x17C` — they may all be shifted or mislabeled.

### Step 3: Find the REAL offset by semantic search
If `Scene*` isn't at `0x184`, search for where scene pointers are actually used:
```bash
# Scene pointer accesses in Ball/Scene decomps (not App decomps)
grep -rn '0x5dc\|0x5DC' analysis/ghidra/decompilations/ball/
grep -rn '0x5dc\|0x5DC' analysis/ghidra/decompilations/scene/
```
Cross-references from Ball/Scene code often reveal the App offset indirectly — e.g., `App+0x5DC` appears in `Ball_Update` as `(1 - player_index) * 0xA0 + 0x5dc + scene`.

### Step 4: Report findings with evidence
Present:
1. The claimed offset and what the doc says it is
2. What raw decomp actually shows at that offset
3. The correct offset (if different) with decomp citations
4. Confidence marker (✅ verified / ❌ contradicted / ❓ unclear)

## Common Offset Confusion Patterns

| Pattern | Example | Fix |
|---------|---------|-----|
| **Int-indexed vs byte** | `param_1[0x5C]` = `0x170` (0x5C * 4), not `0x5C` | Always multiply by 4 for byte offset |
| **Nested object flattened** | `CollisionMesh+0xCA8` listed under Ball | Document pointer chain: `Ball+0x1A4 → CollisionMesh+0xCA8` |
| **Wrong object type** | `App+0x184 = Scene*` when decomp shows `gameUpdateObj` | Verify with `App_Initialize_Full` decomp where the field is assigned |
| **Adjacent-field drift** | Offsets shifted by 4 because a `bool` was padded to `int` | Check constructor for actual allocation sizes |
| **Stale from old build** | Offset valid in v1.0 but shifted in v1.1 | Always state which binary version offsets were derived from |

## Example: Correcting APP_OBJECT.md

**Claimed:**
```
+0x178 Scene* currentScene
+0x184 Scene* loadingScene
```

**Verified against raw decomp:**
- `App+0x178` in `decomp_graphics_init.c` = display mode enum (0x17, 0x18, 0x19, 0x1A), NOT Scene*
- `App+0x184` in `decomp_graphics_init.c:268` = `gameUpdateObj` pointer passed to `App_TickGameUpdate`, NOT Scene*
- `App+0x5DC` in `decomp_ball_update.c:170` = `(1 - player_index) * 0xA0 + 0x5dc + scene` → actual active scene pointer
- `App+0x22C` in `decomp_resource_manifest.c` comment = `LoadingScreenGadget*` (loading screen object)

**Corrected:**
```
+0x5DC Scene* currentScene       ✅ (decomp_ball_update.c, decomp_scene_update.c)
+0x22C Gadget* loadingScreen     ✅ (decomp_resource_manifest.c comment)
+0x184 void* gameUpdateObj       ✅ (decomp_graphics_init.c:268)
```

## Rule

> **Every offset in a modding doc is guilty until proven innocent by raw decompilation.**

When a user challenges an offset, the correct response is verification, not defense.

### Case Study: Session 527 — "Engine has NO persistent velocity" (Wrong Claim)

**Claimed in skill docs (Pitfall #36):** "Engine has NO persistent velocity — 0x17C/0x184 are display-only deltas, not momentum."

**User challenge:** "If the game doesn't have any persistent velocity, then why do I keep moving forward when I roll off an edge?"

**What happened:** The prior analysis only looked at the force accumulators (0x170/0x174/0x178) which ARE zeroed each frame, and concluded "no persistent velocity exists." But the ball's persistent velocity lives on a **different object entirely** — the collision node at `ball+0x1A4`. The collision node stores speed (+0xC64) and direction (+0xC8C/C90/C94) that persist across frames and only change on collision. When airborne (no collision), the else-branch uses the persistent speed × existing direction → ball keeps moving forward.

**Lesson:** When a user's empirical observation contradicts your analysis, the analysis is wrong — not the user. The error came from only tracing the force accumulator pipeline and never looking at the collision node's velocity fields. A broader decompilation search for `param_1[0x69]` (= ball+0x1A4) would have revealed the second velocity system immediately.

**Resolution:** Pitfall #36 was corrected, the physics pipeline reference was updated with collision node velocity fields, and the jump mod's air-momentum approach (saving 0x17C/0x184 display deltas and re-injecting as force) was marked as the wrong mechanism.

### Case Study: Session 19207 — Fabricated Functional Relationship (Ball_Shrink ≠ Falling)

**Claimed:** "Ball_Shrink (0x402200) also sets radius to 13.0 when the ball is falling off an edge."

**User challenge:** "The ball doesn't shrink when it's falling off an edge. Can you show me where you got that information and any relevant code?"

**What happened:** I had conflated two completely separate game systems in memory:
- **Ball_Shrink/Ball_Grow** (0x402200/0x402270) — exclusively the Odd Race pipe shrink/grow mechanic (E:SHRINK/E:GROW collision events). Sets ball+0xC4C=1, radius=13.0, physics_scale=2.5.
- **Ball_Shatter** (0x408D70) — what actually happens when a ball falls off an edge. Spawns debris, sets ball+0x2E8=1, but NEVER writes to ball+0x284 (radius) or ball+0xC4C (is_shrunk).

I claimed Ball_Shrink was called during falling, when in fact only Ball_Shatter is. The error came from a stale memory entry that said "falling=13.0 (set by Ball_Shrink 0x402200)" — fabricating a causal link between the Odd Race shrink mechanic and the fall/shatter system.

**Verification against decompiled source confirmed:**
- Ball_Shatter (0x408D70): sets ball+0x2E8=1, spawns debris, copies radius to debris — but never writes to ball+0x284 or ball+0xC4C
- Ball_FallUpdate (0x408830): reads ball+0x284 and ball+0xC4C but never writes to them
- Ball_SplitAndExplode (0x409480): same — copies radius to split particles but doesn't modify the original

**The fabrication spread:** The wrong "falling=13.0" claim had propagated to ~22 files: docs, HTML knowledge graph, skill reference files, and agent memory. Correcting it required 6 git commits across 2 remotes + skill patches + memory updates. This illustrates how a single fabricated functional relationship metastasizes across all knowledge stores.

**Lesson:** This is the same class of error as fabricating addresses — but for functional relationships. The rule "function name=hypothesis, xrefs=proof" extends to: **function behavior claims must be verified by reading the actual decompiled function body, not inferred from field overlap.** Two functions writing to the same field (Ball_Shrink writes radius=13.0, Ball_Shatter copies radius to debris) does NOT mean they're part of the same system.

**Resolution:** All 22 files corrected. Memory entries updated to explicitly state "Ball_Shatter NEVER writes to ball+0x284 or ball+0xC4C." The skill's ball-shrink-grow-system.md reference now includes a "What Does NOT Happen" section and explicit "NOT related to falling off edges" disclaimers.

### Case Study: Session 20934 — Code-Derived Behavioral Claim Contradicted by Real-World Behavior (Backface Culling Gate)

**Claimed:** "The backface culling gate at 0x4640b4 is why wall-slide shortcuts work — it prevents LGP from updating during wall slides, freezing the LGP at the initial wall contact point."

**User challenge:** "Actually, the wall slide shortcuts work by resetting the LGP on the wall below the floor."

**What happened:** I traced the SpatialTree collision substep (vtable[7] at 0x463E20) and found a real directional filter at 0x4640b4 that only creates type-2 entries when `dot(face_normal, ball_velocity) < 0`. From this code analysis alone, I constructed a behavioral explanation: during wall slides, velocity is parallel to the wall, so `dot ≈ 0`, so no type-2 entries are created, so LGP freezes. This was a plausible-sounding theory built entirely from static code analysis.

**Why it was wrong:** The user's empirical knowledge of the game contradicted my theory. Wall-slide shortcuts work by getting the LGP to update to a point on the wall *below* the track surface — meaning LGP does update during wall contact at some point, just not continuously every frame. My "frozen at initial contact" explanation was wrong.

**Root cause:** I found a real code pattern (the backface culling gate) and constructed a behavioral narrative around it without checking against real-world game behavior. The gate is real and does filter entry creation — but I over-extrapolated from one code path to explain an entire gameplay mechanic without considering:
- Whether there are additional code paths that write LGP outside the type-2 entry loop
- Whether `Ball_FallUpdate` has its own LGP update path
- Whether the swept-sphere re-impacts the wall at intervals during a slide
- Whether other entry types (type 5) affect LGP

**Lesson:** Code-derived behavioral claims are **hypotheses, not facts**. A filter found in one code path does not explain all observed behavior. When you find a code pattern that *could* explain a behavior:
1. **Mark it as a hypothesis** — say "this may explain" not "this is why"
2. **Check against real-world behavior** — if a player says the behavior differs, the code analysis is incomplete, not the player
3. **Look for additional code paths** — there may be other writers, fallback paths, or different entry types that achieve the same effect
4. **Document what is and isn't verified** — separate "this code exists" (verified) from "this code causes behavior X" (hypothesis)

This is a distinct pattern from the fabrication trap (§22): in fabrication, the error is inventing an address/xref. Here, the error is constructing a complete behavioral narrative from a single verified code pattern without empirical confirmation.

**Resolution:** All documentation updated to mark the backface culling gate as a real but incomplete explanation. Open Question sections added to `ball-respawn-state-machine.md` and `BALL_RESPAWN_SYSTEM.md` listing what is and isn't verified.
