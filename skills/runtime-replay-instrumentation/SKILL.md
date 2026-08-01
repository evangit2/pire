---
name: runtime-replay-instrumentation
description: Runtime recording and playback instrumentation — NOP-gate patching, frame-accurate replay state, and multi-segment recording.
---

# Runtime Replay Instrumentation

> Adapted from the target-specific RE toolkit for general binary analysis.


# Time Warp — Multi-Segment Ghost System

Implements a "Time Warp" custom race where the player warps to the same level
multiple times, each time racing against a ghost of their previous route.

Related to: `the target-dll-modding` (parent skill for all the target DLL mods),
`game-reverse-engineering` (Ghidra decompilation methodology)

**Reference**: `references/ghost-ball-lifecycle-pitfalls.md` — 6 common bugs
when creating/managing ghost Ball structs (AthenaList remove, BTT_DTOR leak,
NULL BTT crash, rendering paths, ternary bugs, PAGE_READWRITE).

**Reference**: `references/hbplus-port-parity-checklist.md` — exact checklist
for porting the target.dll Time Warp mod to the application, including the
two easy-to-miss pieces (Tournament BTT creation hook and the `0x41B690`
recording NOP patch).

**Reference**: `references/code-review-bug-patterns-v4.md` — 13 bug patterns
across v3-v5 code reviews (DCE stack offset, Tournament goal gate,
party mode DWORD read, Ghost 2 race condition, thread exit signal,
VirtualFree leak, multiplayer ball count, Ghost 1 bracket mismatch,
background thread races, missing level-transition cleanup,
TOCTOU on CS, mid-frame re-entrancy, hardcoded timer bonuses).

**Reference**: `references/fix-patterns-v5.md` — exact fix code for the 4
bugs found in the July 2026 code review (Ghost 1 bracket mismatch,
background thread race, missing level-transition cleanup with Ghost 2
capture survival, Ghost 2 TOCTOU race on pending flag). Includes
the re-probe pattern, thread-to-frame migration, board-valid→NULL
cleanup detection, and pending-flag-in-creation pattern.

**Reference**: `references/hbplus-port-bugfix-patterns.md` — 4 bugs found
when reviewing the the app port (July 2026): onSceneEnd wiping the Ghost 2
capture mid-warp, onSceneEnd restoring one-time session caves (breaks
timer freeze + TT-recording NOP for the whole session), ghost pre-injection
destroyed by App_StartPracticeRace's own cleanup (with full disassembly),
and the dead-code multi-segment goal-touch handler + C++ declaration-order
gotcha.

**Reference**: `references/hbplus-port-code-review-aug2026.md` — 6 bugs
found in the August 2026 code review of the plus_time_warp the app port:
ghost-mode code cave with wrong JZ/JNZ displacements and mid-instruction
JMP target, party mode DWORD reads in 4 locations, absolute address
instead of RVA in GHOST_MODE_PATCH_ADDR, ghost 2 pending flag cleared
before create completes, and `extern`/`static` linkage mismatch on
g_ghostFromEvent. All demonstrated by source-level comparison of the
port against the game binary and the original target.dll proxy.

**Reference**: `references/hbplus-port-levelmap-and-tournament-gaps.md` —
3 bugs found in the THIRD review of plus_time_warp (Aug 2026, post
commit 188211b7): the levelMap `levelN` entries assume sequential
file→race order (level4=Tower NOT Dizzy — authoritative file→race table
included), Tournament BTT created without race_name so segments never
save, and `g_ghost1` state never cleared in onSceneEnd (dangling-BTT
risk). Also covers the "never assume level file numbering == race order"
lesson and the 0x4F7080 race-table read technique.

**Reference**: `references/cross-reference-code-review-technique.md` —
the general technique used in the August 2026 review: reading game binary
bytes to verify code cave displacements, source-to-source comparison for
port consistency, and JMP target verification for instruction boundaries.

**Reference**: `references/hbplus-port-fix-session-20260801.md` — the
implementation session that fixed the 3 bugs: race-number-only levelMap
(strtol validation), tournament temp-`[N]`-only enforcement
(`is_tournament_active()` idiom, 3 edit sites), ghost1 cleanup with the
PHASE_LOAD mid-warp guard, plus the the app mod Wine crash-test procedure and
the git-state gotcha when a prior session already committed part of the
changes under an unrelated message.

## Core Concept

- Player races → hits WARP(samelevel) trigger → level reloads
- After warp: Ghost 2 (heliotrope purple #db03fc) appears, replaying the
  route the player just took
- In Time Trial: Ghost 1 (normal color, best time) also active
- Ghost triggers (`GT:` S1 ref points) let ghost balls interact with the world

## Tournament Mode Recording (Ghidra-verified, sess_XXX)

`Scene_UpdateBallsAndState` (0x41B540) gates BTT recording on two checks
at the end of the function:

```asm
0041b684: MOV EAX,[EBX + 0x878]      ; EAX = App
0041b68a: MOV EDX,[EAX + 0x220]      ; EDX = profile
0041b690: MOV CL,[EDX + 0x11]        ; CL = profile->isTimeTrial  ← CHECK 1
0041b693: TEST CL,CL
0041b695: JZ 0x0041b708              ; skip recording if NOT TT
0041b697: MOV CL,[EAX + 0x234]      ; CL = App->partyMode         ← CHECK 2 (KEEP)
0041b69d: TEST CL,CL
0041b69f: JNZ 0x0041b708             ; skip recording if party
0041b6a1: MOV ECX,[EAX + 0x5dc]      ; ball ptr
0041b6a7: PUSH ECX
0041b6a8: MOV ECX,[EAX + 0x90c]      ; BTT recording
0041b6ae: CALL 0x00427810            ; BestTimeTracker_RecordSnapshot
```

### NOP Patch: Enable recording in Tournament

- **Address**: 0x41B690
- **Original bytes**: `8A 4A 11 84 C9 74 71` (7 bytes)
- **Patched**: `90 90 90 90 90 90 90` (7x NOP)
- **Effect**: Recording runs in Tournament mode (party check at 0x41B697 stays intact)
- **Do NOT set `profile+0x11=1`** — that would confuse other game systems into
  thinking it's Time Trial. NOP the check instead.

### Also need: Create BTT in Tournament (hook App_StartTournamentRace)

`App_StartTournamentRace` (0x4288B0) does NOT create a BTT at App+0x90C.
It destroys any existing App+0x90C and App+0x910, then sets both to NULL.

After the NOP patch, the recording code at 0x41B6AE calls
`BestTimeTracker_RecordSnapshot(App+0x90C, ball)`. If App+0x90C is NULL, crash.

**CRITICAL**: Do NOT just create the BTT once at init and hope it persists.
`App_StartTournamentRace` destroys existing BTTs on EVERY tournament race
start. You must hook `App_StartTournamentRace` and create a fresh BTT
AFTER the trampoline call returns. The hook pattern:

```c
void tournament_hook_impl(DWORD app) {
    // Call original via trampoline
    __asm__ volatile("movl %0, %%ecx\\n call *%1\\n"
        : : "r"(app), "r"((void*)g_tournamentTrampoline)
        : "eax", "ecx", "edx", "memory");

    // After return: App+0x90C is NULL. Create fresh BTT.
    void *btt = game_operator_new(0x528);
    call_btt_ctor(btt);
    if (*(DWORD*)btt != 0x004D262C) { game_free(btt); return; }
    *(DWORD*)((char*)btt + 0x524) = NO_TIME;  // best_time
    *(DWORD*)(app + 0x90C) = (DWORD)btt;
}
```

Hook installation: 7-byte detour (E9 + rel32 + 2x NOP) on `0x4288B0`.
Verify signature `6A FF 68` (PUSH -1; PUSH imm32) before patching.
Trampoline copies original 7 bytes + JMP back to 0x4288B7.

**Why not just create BTT at init time?** Because `App_StartTournamentRace`
runs every time a tournament race starts (including same-level warps that
call `App_StartPracticeRace`). If you create the BTT only once at init, the
game will destroy it on the next race start, leaving App+0x90C = NULL again.

## Multi-Segment Ghost File Naming

A Time Warp level attempt = multiple runs (warp -> reload -> warp -> goal).
Each run segment is saved separately.

| Format | Meaning |
|--------|---------|
| `LevelName[N].ghost` | Temporary (brackets) — current attempt in progress |
| `LevelName(N).ghost` | Confirmed best (parentheses) — from a completed best attempt |

### During an attempt

- Run 1 -> warp -> save `LevelName[1].ghost`
- Run 2 -> warp -> save `LevelName[2].ghost`
- Run N -> goal -> save `LevelName[N].ghost`

### On goal touch — compare total clock time

- **No previous best** (no `(N)` files exist): rename all `[N]` -> `(N)` — first record
- **New time < previous best**: delete old `(N)` files, rename `[N]` -> `(N)`
- **New time >= previous best**: delete all `[N]` files — discard attempt

### Total time calculation

- **Time Trial**: App+0x5E8 counts UP — total time = timer value at goal touch
- **Tournament**: Sum of individual segment times from BTT headers

## Ghost 1 — Seamless Chaining Across Warps

Ghost 1 (normal colored) plays back the best attempt across multiple segments.

### On same-level warp

1. Save Ghost 1's current playback index (BTT+0x41C) before App_StartPracticeRace
2. Let App_StartPracticeRace run (it destroys/recreates App+0x910)
3. After it returns: load the correct segment `(N)` file into new BTT at App+0x910
4. Set playback index to the saved value (resume from same frame)

### On segment end (playback index >= segment frame count)

1. Advance to next segment (N+1)
2. Load `(N+1).ghost` file
3. Destroy old BTT at App+0x910 (BTT_DTOR 0x4278C0, flags=1)
4. Create new BTT from segment file
5. Set playback index to 0

## Ghost 2 — Standalone Secondary Ghost Ball

Ghost 2 is always the most recent run segment. Only appears on same-level warp.

### Creation (after warp loads the same level)

```c
DWORD ball = (DWORD)game_operator_new(0xC60);  // 0x4BA57B
// Ball_ctor — __thiscall(ball, scene), RET 0x4
__asm__ volatile(
    "push %1\\n\\t"
    "movl %0, %%ecx\\n\\t"
    "call *%2\\n\\t"
    : : "r"(ball), "r"(sceneAddr), "r"(0x4039E0)
    : "eax", "ecx", "edx", "memory"
);
// Ghost fields (matching Board_ctor at 0x419636)
*(DWORD*)(ball + 0x18) = 0xFFFFFFFF;  // playerID = -1
*(float*)(ball + 0x278) = 0.5f;       // gravity scale
*(float*)(ball + 0x284) = 26.0f;      // radius
*(float*)(ball + 0x188) = 1000.0f;    // max_speed
*(float*)(ball + 0x2FC) = 0.45f;      // alpha
// Heliotrope purple #db03fc
*(float*)(ball + 0x2AC) = 219.0f/255.0f;
*(float*)(ball + 0x2B0) = 3.0f/255.0f;
*(float*)(ball + 0x2B4) = 252.0f/255.0f;
// Add to ball AthenaList at board+0x29D4
call_alist_append((DWORD*)(board + 0x29D4), (void*)ball);
```

### Per-frame playback (frame epilogue hook)

**CRITICAL: Zero force accumulators every frame.** When Ghost 2's ball is in
the ball AthenaList, the game's physics engine applies forces and gravity
every frame. If you only write position, the engine pushes the ball away,
causing jitter and desync. Zero `ball+0x170/0x174/0x178` every frame:

```c
if (g_ghost2.active && g_ghost2.ball && g_ghost2.playbackIdx < g_ghost2.frameCount) {
    DWORD *snap = &g_ghost2.snapshots[g_ghost2.playbackIdx * 10];
    DWORD ball = g_ghost2.ball;
    *(float*)(ball + 0x164) = *(float*)&snap[0];  // pos_x
    *(float*)(ball + 0x168) = *(float*)&snap[1];  // pos_y
    *(float*)(ball + 0x16C) = *(float*)&snap[2];  // pos_z
    *(float*)(ball + 0x170) = 0.0f;                // ZERO velocity accumulators
    *(float*)(ball + 0x174) = 0.0f;
    *(float*)(ball + 0x178) = 0.0f;
    g_ghost2.playbackIdx++;
}
```

### Cleanup (on level transition — board pointer changes)

**CRITICAL**: Remove the ball from the AthenaList BEFORE calling Ball_DTOR.
If you skip the removal, `Ball_Render` iterates the AthenaList next frame
and hits a dangling pointer to freed memory → use-after-free crash.

```c
// 1. Remove from ball AthenaList at board+0x29D4
//    AthenaList_Remove = 0x4534D0, __thiscall(list, item)
call_alist_remove((DWORD*)(board + 0x29D4), (void*)ball);

// 2. Call Ball deleting destructor: vtable[0] at 0x402A50
call_ball_dtor(ball);  // __thiscall(ball, flags=1)

// 3. Free BTT if standalone: BTT_DTOR (0x4278C0) with flags=1
// 4. Free snapshot array: free() (malloc'd, game doesn't own this)
```

**AthenaList_Remove** (0x4534D0): `__thiscall(this=list, param=item_ptr)`.
Reallocates internal array without the item, decrements count, fixes all
iterator indices. Safe to call even if item is not in the list (no-op).

## Ghost Triggers (GT: S1 Ref Points)

S1 entries with `GT:` prefix create proximity triggers for ghost balls.

| Trigger | Effect |
|---------|--------|
| `GT:COLOR(#hex)` | Change ghost ball color |
| `GT:RESET` | Reset ghost playback to frame 0 |
| `GT:SPEED(float)` | Adjust playback speed multiplier |
| `GT:STOP` | Freeze ghost at current frame |
| `GT:START` | Resume ghost playback |

Fires on entry (was outside, now inside). 60-frame cooldown per trigger.
Checks both ghost balls independently.

## Mode Support

| Mode | Ghost 1 | Ghost 2 | Recording |
|------|---------|---------|-----------|
| Time Trial | Yes (native) | Yes (after same-level warp) | Yes (native) |
| Tournament | No | Yes (after same-level warp) | Yes (with NOP + BTT hook) — temp `[N]` segments only, never promoted, never clobbers TT records |
| Party | No | No | No (party check intact) |

### Ghost 1 vs Ghost 2 rendering paths (important)

- **Ghost 1** (normal colored) lives at `board+0x361C` (native ghost slot).
  `Level_UpdateAndRender` (0x40B600) renders it ONLY when:
  `profile+0x11 != 0 && App+0x234 == 0 && App+0x910 != NULL`
  (i.e. Time Trial, not Party, playback buffer exists).
  To make Ghost 1 appear in ALL modes, the original target.dll proxy NOPs the
  checks at `0x40B7F5` + `0x40B7FF` (intentional — that's the Time Warp
  design). The the app port instead uses a code cave with a `g_ghostFromEvent`
  flag so only E:GHOST-event ghosts render everywhere; normal Ghost 1 stays
  TT-only. Choose the mechanism that matches your intent — see pitfall #2.
  Ghost 1 should only appear in Time Trial unless you deliberately enable it
  elsewhere.

- **Ghost 2** (heliotrope purple) lives in the ball AthenaList at
  `board+0x29D4`. `Ball_Render` iterates this list unconditionally every
  frame and renders ALL balls regardless of game mode. So Ghost 2 renders
  in both TT and Tournament without any NOP patches. Gate Ghost 2 creation
  on `App+0x234 == 0` (not party) in your mod code.

### BTT cleanup — always call BTT_DTOR before zeroing pointers

When you destroy a BTT at `App+0x90C` or `App+0x910` (e.g. during warp
level transition), you MUST call `BTT_DTOR` (0x4278C0, flags=1) on the old
BTT before zeroing the pointer. Just doing `*(DWORD*)(app+0x90C) = 0`
leaks the 0x528-byte BTT struct + all its AthenaList snapshot allocations.

```c
DWORD oldBtt = *(DWORD*)(app + APP_BTT_RECORDING);
if (oldBtt && oldBtt > 0x10000 && !IsBadReadPtr((void*)oldBtt, 4)) {
    DWORD vt = *(DWORD*)oldBtt;
    if (vt == BTT_VTABLE_ADDR)
        call_btt_dtor((void*)oldBtt);  // proper cleanup
    else
        game_free((void*)oldBtt);       // fallback
}
*(DWORD*)(app + APP_BTT_RECORDING) = 0;
```

## Warp Visual Effects (from warp mod v8.5)

- RUMBLE (2s): Ball color lerps to heliotrope purple (#db03fc), alpha fades 1.0->0.5
- FLASH (150ms): Instant white, linear fade out (no fade-in)
- HOLD (1s): Screen clear, ball invisible
- FADE (2s): Screen fades to solid white
- LOAD: Level reload while screen white
- REVEAL (1s): Fade from white to reveal new level

Timer freeze: code caves at 0x41B3E5 (9 bytes) + 0x41B50C (5 bytes).

### Warp Safety: Ball Death Prevention

**Problem**: During the warp sequence, the ball becomes invisible (alpha=0).
If the physics engine detects the ball is "penetrating" terrain (which can
happen if the ball's position is inside a wall during the flash), it calls
`Ball_Shatter` → ball dies → warp completes into a dead state.

**Fix**: Set `ball+0x2CC = 1` (in_tar) during PHASE_FLASH when the ball's
alpha reaches 0. The `in_tar` flag prevents shatter/death — the Ball_Update
function checks this field and skips the shatter logic. Clear
`ball+0x2CC = 0` in PHASE_LOAD when the ball is about to be destroyed.

```c
// In PHASE_FLASH, when hiding ball:
*(float*)(ball + 0x2FC) = 0.0f;       // alpha = 0 (invisible)
*(BYTE*)(ball + 0x2CC) = 1;            // in_tar = 1 (prevent death)

// In PHASE_LOAD, when reloading level:
*(BYTE*)(ball + 0x2CC) = 0;            // clear in_tar
```

### Warp Safety: Abort on Timer Expiry

**Problem**: If the race timer expires during the RUMBLE or FLASH phase
(e.g. player triggered warp right before time ran out), the warp continues
anyway, loading a new level in a "time expired" state where the race is
already over. The player sees the new level for a split second then
immediately gets the game over screen.

**Fix**: Check `App+0x5D6` (timer finished flag) during RUMBLE and FLASH
phases. If set, abort the warp cleanly:

```c
// Check at top of updateWarpStateMachine, before phase switch:
if ((g_phase == PHASE_RUMBLE || g_phase == PHASE_FLASH) && ball) {
    BYTE finished = *(BYTE*)(app + 0x5D6);
    if (finished) {
        // Cleanup: restore ball, music, timer, pause, alpha
        *(DWORD*)(ball + 0x808) = 0;    // impact freeze
        *(BYTE*)(ball + 0x2D4) = 0;     // render jitter
        *(BYTE*)(ball + 0x2CC) = 0;     // in_tar
        restoreMusicFade();
        g_freezeTimer = 0;
        unblock_pause();
        *(float*)(board + 0x3624) = 0.0f;  // scene fade alpha
        g_whiteAlpha = 0.0f;
        g_phase = PHASE_IDLE;
        g_cooldownUntil = getGameTime() + WARP_COOLDOWN_MS;
        g_warpBall = 0;
        return;
    }
}
```

## Dynamic rel8 in code caves (verified technique)

When a code cave has internal conditional jumps, **never hardcode the rel8
displacements** — compute them at install time. The cave is built with
placeholders (`p[1] = 0`), then each jump's displacement is patched after
all instructions are emitted:

```c
unsigned char* jnePatcher = p;  p[0]=0x75; p[1]=0; p += 2;  /* JNE rel8 */
/* ... emit intermediate instructions ... */
write_jmp(p, continueAddr);  unsigned char* allowJmp = p; p += 5;  /* ALLOW */
write_jmp(p, skipAddr);      unsigned char* skipJmp  = p;          /* SKIP */
/* rel8 = target - (patch_address + 2) — all targets are forward, so: */
jnePatcher[1] = (unsigned char)(allowJmp - (jnePatcher + 2));
jzPatcher[1]  = (unsigned char)(skipJmp  - (jzPatcher  + 2));
jnzPatcher[1] = (unsigned char)(skipJmp  - (jnzPatcher + 2));
```

Why: hardcoded displacements rot silently when the cave layout changes (an
instruction added/removed shifts every later offset), and the error mode is
nasty — the jump lands mid-instruction or at the wrong logical branch
(ALLOW vs SKIP). A byte-exact Python simulation of the emitted cave
(offsets, target arithmetic, rel8 range check) is a cheap pre-build
verification; keep it as a script or one-off check.

Also verify the *patch region boundaries* against the binary before choosing
JMP targets: the 17-byte patch at 0x40B7F0 covers through 0x40B800 (the JNZ
displacement byte), so ghost render starts at 0x40B801, not 0x40B800.
Always read the raw bytes and count exactly which byte the last patched
instruction ends on.

## Key Addresses

| Address | Name | Description |
|---------|------|-------------|
| 0x41B690 | TT recording check | 7 bytes to NOP for Tournament recording |
| 0x41B540 | Scene_UpdateBallsAndState | Per-frame ball update + recording |
| 0x427810 | BestTimeTracker_RecordSnapshot | Records one ball frame to BTT |
| 0x4288B0 | App_StartTournamentRace | Destroys BTTs, sets to NULL — hook to create new BTT |
| 0x428C50 | App_StartPracticeRace | Creates BTT at App+0x90C |
| 0x427660 | BestTimeTracker_ctor | BTT constructor |
| 0x4278C0 | BestTimeTracker_dtor | BTT deleting destructor (flags=1) |
| 0x4BA57B | operator_new | Game's allocator for ball/BTT structs |
| 0x4BA74D | game_free | CRT _free (pairs with operator_new) |
| 0x4039E0 | Ball_ctor | Ball struct constructor |
| 0x402A50 | Ball dtor | Ball deleting destructor (vtable[0]) |
| 0x453780 | AthenaList_Append | Add item to AthenaList |
| 0x4534D0 | AthenaList_Remove | Remove item from AthenaList (before Ball_DTOR!) |
| 0x40B600 | Level_UpdateAndRender | Ghost 1 render gate (TT-only check, do NOT NOP) |
| 0x46C1F1 | Frame epilogue | Hook point for per-frame logic |

## Verified

- Ghidra decompilation of App_StartTournamentRace (0x4288B0) — no BTT creation, destroys existing
- Ghidra decompilation of Scene_UpdateBallsAndState (0x41B540) — recording gate confirmed
- Ghidra decompilation of Level_UpdateAndRender (0x40B600) — Ghost 1 render gated on TT check
- Ghidra decompilation of AthenaList_Remove (0x4534D0) — reallocates array, fixes iterators
- Ghidra decompilation of BestTimeTracker_RecordSnapshot (0x427810) — no NULL check on `this`
- Assembly at 0x41B690 — 7-byte TT check: `8A 4A 11 84 C9 74 71`
- Time Warp mod v1 (3015 lines) compiled + crash-tested (38.7s OK)
- Time Warp mod v2 (3613 lines) compiled + crash-tested (38.6s OK)
- Time Warp mod v3 (3755 lines) — 6 bug fixes, compiled + crash-tested (38.8s OK)
- Session: sess_XXX (July 2026), sess_XXX (July 2026 — v3 fixes)

## Common Pitfalls

### Core pitfalls

1. **Unconditional NOP = crash**: NOP'ing the TT check at 0x41B690 without
   also hooking App_StartTournamentRace means `BestTimeTracker_RecordSnapshot`
   receives NULL as `this` → crash on frame 1 of every Tournament race.

2. **Ghost 1 rendering in all modes**: Two different mechanisms exist for
   the ghost render gate at `Level_UpdateAndRender` (0x40B7F0):
   - The original target.dll proxy **NOPs** the checks at `0x40B7F5` + `0x40B7FF`
     entirely — this enables Ghost 1 rendering in ALL modes (TT, Tournament,
     Party). That's the intended behavior for the original Time Warp mod.
   - The the app port instead uses a **code cave with a `g_ghostFromEvent` flag**:
     ghosts render everywhere when the flag is set (E:GHOST event), but
     normal ghost playback stays gated to TT.
   When reviewing/porting, identify WHICH mechanism the code uses before
   deciding whether the checks are "supposed" to be NOPed. If you want Ghost 1
   in TT only, don't NOP; if you want it everywhere, NOP is the simple way.
   Ghost 2 (in the ball AthenaList) renders in all modes natively either way.

3. **AthenaList dangling pointer**: Calling Ball_DTOR without first removing
   the ball from `board+0x29D4` AthenaList → use-after-free crash next frame
   when Ball_Render iterates the list.

4. **Bracket selection bug**: When loading ghost segments, try `(N)` first,
   then `[N]`, and pass the *actual bracket that succeeded* to the load
   function. Never re-derive the bracket from state after the probe already
   decided which file exists.

5. **BTT memory leak**: Zeroing `App+0x90C` without calling BTT_DTOR leaks
   0x528 bytes + all snapshot allocations per warp. Always DTOR first.

6. **PAGE_READWRITE on code bytes**: Using `PAGE_READWRITE` instead of
   `PAGE_EXECUTE_READWRITE` for VirtualProtect on executable code. The
   no_pause mod uses `PAGE_READWRITE` and works fine on real Windows —
   DEP does not block this pattern for single-byte JZ→JMP patches.

7. **Missing in_tar protection during warp**: If `ball+0x2CC` (in_tar) is
   not set when the ball becomes invisible during PHASE_FLASH, the physics
   engine can shatter the ball. Always set `ball+0x2CC = 1` when hiding
   the ball, and clear it in PHASE_LOAD before the ball is destroyed.

8. **No abort on timer expiry during warp**: If the race timer expires
   while the warp state machine is in RUMBLE or FLASH, the warp completes
   into a "time expired" state. Check `App+0x5D6` (timer finished flag)
   during these phases and abort the warp cleanly if set.

9. **DCE hook wrong stack offset**: When hooking DispatchCollisionEvents
   (0x40C5D0) at 0x40C5E5 (after the SEH prologue), params are at
   `[ESP+16]` (ball) and `[ESP+20]` (collEntry), NOT `[ESP+8]`/`[ESP+12]`.
   The SEH prologue (PUSH -1 + MOV EAX,FS:[0] + PUSH EAX + MOV FS:[0],ESP)
   adds 4 pushes to the stack. Using wrong offsets silently breaks all
   collision event handlers.

10. **Tournament goal touch gating**: `check_race_state()` must not gate
    goal flag monitoring on `is_time_trial_active()`. Separate the concerns:
    goal detection runs in both TT and Tournament (for Time Warp segment
    comparison), while BTT recording tracking is TT-only.

11. **Party mode read as DWORD**: `App+0x234` is a single BYTE, not a
    DWORD. Reading 4 bytes bleeds into adjacent fields. Always read as
    `*(BYTE*)(app + 0x234)`.

12. **Ghost 2 race condition**: Background thread writes `g_ghost2Capture`
    inside `check_race_state()`. Main thread reads it in
    `ghost2_check_board_change()`. Both sides need the critical section.

13. **Background thread never exits**: `DLL_PROCESS_DETACH` must set a
    `g_shuttingDown` flag that the thread's loop checks. Without it, the
    thread can access freed memory during cleanup.

14. **VirtualFree leak in hook cleanup**: `restore_*` functions that set
    `g_* = NULL` without calling `VirtualFree` leak VirtualAlloc'd memory.
    Every VirtualAlloc needs a matching VirtualFree.

15. **Multiplayer warp proximity**: Reading the first ball from the
    AthenaList without checking the ball count can trigger warp for the
    wrong player in multiplayer. Gate on `ballCount > 1` to skip.

### v5 pitfalls (July 2026 code review)

16. **Ghost 1 bracket mismatch on segment advance**: When `ghost1_check_advance()`
    probes `(N+1).ghost` and falls back to `[N+1].ghost`, it must pass the
    *actual bracket that succeeded* to `ghost1_load_segment()`. Re-deriving
    the bracket from `g_ghost1.currentSegment <= g_ghost1.totalSegments`
    is wrong — the probe already decided which file exists. Never re-derive
    a decision parameter when the probe result is available.

17. **Background thread + frame hook race (target.dll proxy only)**: A background
    thread reading BTT data while the frame epilogue hook reads Ghost 2 state
    creates a race condition. Every shared state access needs CS protection on
    *both* sides. The the app version avoids this entirely by running everything
    in `onGameUpdate()` on the main thread. **Fix**: Remove the background
    thread and call `check_race_state()` from the frame epilogue instead.

18. **Missing level-transition cleanup (target.dll proxy only)**: Code caves and
    byte patches must be restored on every level transition, not just
    `DLL_PROCESS_DETACH`. The DLL may not unload cleanly on crash or Alt+F4.
    The the app version uses `onSceneEnd()` for this. Bass.dll proxy fix: track
    `g_wasInRace` in the frame hook and run full cleanup when board goes
    valid → NULL.

    **CRITICAL**: Do NOT clear `g_ghost2Capture`/`g_ghost2Pending` in the
    scene-end cleanup. These are set by the warp capture *before* the level
    reloads and consumed by `ghost2_check_board_change()` *after* the new
    board appears. Clearing them breaks Ghost 2 creation across warps.
    **Real-world confirmation**: the the app port violated this — its
    `onSceneEnd()` freed the capture and cleared `g_ghost2Pending`, so Ghost 2
    never spawned after any warp. `onSceneEnd()` fires on EVERY scene teardown,
    including the warp's internal level reload (PHASE_LOAD calls the game's
    race-start function directly, which tears down the scene synchronously).
    See `references/hbplus-port-bugfix-patterns.md` Bug A.

    **Related the app trap**: `onSceneEnd()` must NOT restore one-time session
    caves (`restore_tt_recording_nop`, `restore_timer_caves`). Those are
    installed once in `Initialize()`; restoring them in `onSceneEnd` breaks
    the timer freeze + TT-recording NOP for the rest of the session after the
    first warp/level change, since nothing re-installs them. See Bug B in the
    same reference.

19. **Ghost 2 creating race on pending flag**: Setting `g_ghost2Pending = FALSE`
    *before* calling `ghost2_create()` creates a TOCTOU window where a new
    warp can set `g_ghost2Pending = TRUE` while the old create is still
    running, causing double creation and an orphaned capture buffer.
    **Fix**: Move `g_ghost2Pending = FALSE` and the capture buffer cleanup
    (`free(g_ghost2Capture)`) to the *end* of `ghost2_create()`, so the
    flag stays TRUE for the entire creation window. Also copy snapshot data
    (malloc+memcpy) instead of taking ownership of the capture buffer pointer.

20. **Mid-frame race-start call re-entrancy**: Calling
    `App_StartPracticeRace`/`App_StartTournamentRace` from inside a frame
    hook (PHASE_LOAD) is technically re-entrant — the game's level-loading
    functions allocate boards, profiles, and BTTs while the render loop is
    paused. Works in practice but fragile. Consider queueing the load for
    the next frame.

21. **Ghost pre-injection destroyed by App_StartPracticeRace**: Injecting a
    saved ghost into `App+0x910` BEFORE calling the original is unsafe. The
    game's own function destroys whatever is at App+0x910: on the fresh-start
    path (recording NULL at entry) it UNCONDITIONALLY calls vtable[0] on it
    (0x428CDB), and on the compare path it destroys the playback if the
    recording's best time is better. **Fix**: call `orig_AppStartPracticeRace`
    FIRST, then post-inject into App+0x910. Free any kept playback we
    overwrote (pointer-compare guard so a failed injection doesn't free a
    live BTT). Full disassembly in
    `references/hbplus-port-bugfix-patterns.md` Bug C.

22. **Dead-code goal-touch handler**: `handle_tw_goal_touch()` (segment save,
    `[N]`→`(N)` rename, best-time compare) is easy to leave uncalled — the
    whole multi-segment system silently does nothing and temp `[N]` files
    accumulate forever. Always wire it into `check_race_state()` on the
    `goalFlag && !g_prevGoalFlag` edge, BEFORE the generic
    `save_ghost_for_race()`. When adding it from a later file section,
    forward-declare only the function; move shared globals up into the
    earlier global block (static tentative-definition + later initialized
    definition is a redefinition error; extern + static definition is a
    linkage mismatch). See Bug D in the same reference.

23. **Level file numbering ≠ race order**: Never assume `levelN` maps to
    race N. The actual mapping (verified against `0x4F7080` race table +
    LevelData.txt): level1→1, levelcascade→2, level2→3, level3→4, level4→5
    (Tower), levelup→6, leveldark→7, level5→8 (Expert), level6→9, level8→10
    (Toob), level7→11 (Wobbly), levelglass→12, level9→13, level10→14,
    levelimpossible→15. If a warp/level mod accepts `levelN` names, use the
    authoritative table — sequential mapping silently sends `WARP(level4)`
    to Dizzy instead of Tower. See
    `references/hbplus-port-levelmap-and-tournament-gaps.md` Bug 1.

24. **Mod-created Tournament BTT has no race name**: `App_StartTournamentRace`
    never fills `BTT+0x424` — only the practice hook (and the game's own
    recording BTT creation) sets it. If your mod creates the Tournament
    recording BTT itself, write `BTT+0x424` from
    `get_race_name_by_index(race_index)` or every race-name read
    (`get_race_name()`) returns "" and segment saving silently no-ops.
    See `references/hbplus-port-levelmap-and-tournament-gaps.md` Bug 2.

25. **Clear Ghost 1 state on scene end — with a mid-warp guard**: `g_ghost1`
    (active/btt/segment fields) must be zeroed in `onSceneEnd()` — unlike
    Ghost 2's capture buffers, it has no cross-warp capture to preserve.
    Leaving it stale points `ghost1_check_advance()` at a BTT the game's
    scene teardown is about to free; freed heap passes `IsBadReadPtr` and
    gets walked as garbage. Just zero the struct — do NOT BTT_DTOR the
    pointer (the game owns the App+0x910 BTT). See
    `references/hbplus-port-levelmap-and-tournament-gaps.md` Bug 3.

    **CRITICAL mid-warp guard**: `onSceneEnd()` fires DURING a warp's
    PHASE_LOAD too — PHASE_LOAD calls `call_app_start_*_race()` directly,
    which synchronously tears down the old scene, so the scene
    deconstructor hook runs *inside* the warp. At that point
    `ghost1_save_state()` has already saved playbackIdx/btt into
    `g_ghost1`, and `ghost1_restore_after_warp()` runs right after the
    race-start call returns. An UNCONDITIONAL `memset(&g_ghost1, 0, …)`
    wipes that saved state → playback resets to segment 1 / playIdx 0 on
    every same-level warp. **Fix**: snapshot `int midWarp = (g_phase ==
    PHASE_LOAD)` at the TOP of onSceneEnd (before `g_phase = PHASE_IDLE`),
    and only zero ghost1 + TW flags when `!midWarp`:

    ```cpp
    int midWarp = (g_phase == PHASE_LOAD);   // capture BEFORE resetting g_phase
    g_phase = PHASE_IDLE;
    // ... other resets ...
    if (!midWarp) {
        memset(&g_ghost1, 0, sizeof(g_ghost1));
        g_twRaceName[0] = '\0';
        g_segmentCounter = 0; g_segmentCount = 0;
        memset(g_segmentTimes, 0, sizeof(g_segmentTimes));
        g_isTimeWarpLevel = FALSE;
    }
    ```

    The `g_isTimeWarpLevel`/`g_twRaceName`/segment reset is equally
    important: on a REAL scene end (player left level to menu, not a warp)
    the PHASE_LOAD `!isSameLevel` branch never runs, so without it a later
    non-warp race would wrongly fire `handle_tw_goal_touch()` and clobber
    records.

26. **Tournament mode = temporary `[N]` ghosts ONLY (user contract)**: In
    tournament mode the mod must never promote `[N]`→`(N)`, never delete
    confirmed `(N)` records, and never write full-race `.ghost` files —
    tournament shares the same race name as Time Trial (same files), so
    promotion/clobbering would destroy the TT best. Enforce in three
    places:
    - `handle_tw_goal_touch()`: if `is_tournament_active()`, save the
      segment (it's already `[N]` via `save_warp_segment()`), reset
      counters, and RETURN before the `rename_temp_to_confirmed` /
      `delete_confirmed_segments` compare logic.
    - The generic goal-save block in `check_race_state()`
      (`save_ghost_for_race(raceName, …)`): skip entirely in tournament —
      wrap in `if (!is_tournament_active())`.
    - Recording tracking in `check_race_state()`: it must NOT gate on
      `is_time_trial_active()` alone or tournament recording silently
      stops. Accept `is_time_trial_active() || is_tournament_active()` as
      the recording mode.
    - Detection idiom: `is_tournament_active()` = `App+0x234==0` (not
      party) AND `profile+0x11==0` (not practice) AND a recording BTT
      exists at `App+0x90C`. Practice and tournament are distinguished by
      the `profile+0x11` byte plus who created the BTT.

27. **Forward-declare helpers used before definition (the app port)**: When
    adding code that calls a helper defined LATER in the file (e.g.
    `create_tournament_recording_btt()` at ~line 1127 calling
    `get_race_name_by_index()` defined at ~line 1255), add a forward
    declaration near the caller. MinGW C++ silently allows some implicit
    decls under `-fpermissive` but the call will be wrong at runtime if
    the signature is mangled differently — always add the explicit
    `static int get_race_name_by_index(DWORD, char*, int);` prototype.

