---
name: global-state-identification
description: Reliable access to runtime global state — finding singletons, global pointers, and object trees via string xrefs and cross-reference analysis.
---

# Global State Identification

> Adapted from the target-specific RE toolkit for general binary analysis.


# the target Game State Access

Reliable ways to read the the target (2004, Raptisoft) runtime state from a target.dll proxy mod or CEA script. This skill focuses on **pointer retrieval**: finding the current board, the player ball, and related game singletons without crashing when the layout or timing changes.

## When to use this skill

- Your mod hook runs from `Present`, `Ball_Update`, a level-load hook, or a background thread and needs a valid `board*`, `Ball*`, `App*`, or `Scene*`.
- `get_board()` returns 0 in one context but works in another.
- `get_ball_ptr()` returns 0 even though the ball is clearly in the level.
- You are unsure whether to use `g_Scene`, `App+0x178`, `profile+0x0C`, or a cached board pointer.

## Core facts

| Object | Base address | Key offsets | Notes |
|--------|--------------|-------------|-------|
| `App`  | `0x005341E0` (global `g_App`) | `+0x220` → profile ptr; `+0x178` → board ptr; `+0x159` → quit flag; `+0x158` → **fullscreen flag (NOT pause)** | Always valid once the game is running. |
| `Board` | Via `App+0x178`, `profile+0x0C`, or cached from level-load hook | `+0x29D4` → ball `AthenaList`; **`+0x874` → pause flag (byte, 1=paused)** | The Board object IS the big 0x4400-byte "Scene" — `Scene_Update` (0x419c00) is board vtable[1]. |
| `Scene` | **`0x005341E4` is a GetTickCount timer, NOT a scene pointer** | — | Do NOT dereference `0x5341E4` as any object. The mod's own `sceneobj` (level+0x480) is a different small object. |
| `Ball` | First item in `board+0x29D4` AthenaList | `+0x164/168/16C` position; `+0x170/174/178` force accumulators | Force accumulators are what physics consumes. |

## Pause detection (Present-hook state advances MUST gate on this)

The Present hook fires EVERY frame, including while the game is paused (ESC menu). Any per-frame state you advance (rotation angles, timers, counters) keeps running during pause unless gated.

- **Pause flag = `*(BYTE*)(board + 0x874)`**. Non-zero = paused. The Board object IS the "Scene" — no separate scene pointer needed.
- Set by `Scene_CreateGameOverMenu` (0x40A920, `0x40AA34: movb $0x1,0x874(esi)` where esi=board); checked by `GameUpdate` (0x469CF0, `0x469D2D: mov 0x874(%ecx),%al`) which skips `Scene_Update` when set; cleared to 0 on RESUME by `PauseMenu_HandleButtonClick`.
- Why it's the board: `Scene_Update` (0x419C00) is **board vtable[1]** and reads board+0x3620/+0x4358 (0x4400-byte offsets) — the big "Scene" object IS the Board. The `sceneobj` from `level+0x480` is a SMALLER object (0xCA0 bytes) whose +0x874 is never set.
- **`App+0x158` is the FULLSCREEN flag, NOT pause** — a common trap. Confirmed by `raptisoft_live_log` (`APP_FULLSCREEN 0x158`, `APP_WIN_WIDTH 0x15C`, `APP_WIN_HEIGHT 0x160`) and the App ctor (0x46DD37 clears it next to 640×480 at +0x15C/+0x160). Gating on it never fires in windowed mode → your Present-hook state advances during pause.
- **`0x5341E4` is a GetTickCount timer, NOT the scene pointer** — gating on `*(DWORD*)0x5341E4 + 0x874` reads garbage (log shows g_Scene=0x105B182D = tick value) and never blocks. Use the board pointer you already have (function param or cached from level load).

```c
/* board = current board pointer (function param or cached from level-load hook) */
if (board && board > 0x10000 && !IsBadReadPtr((void*)(board + 0x878), 0x20)) {
    if (*(BYTE*)(board + 0x874) != 0) continue;  /* paused → skip */
}
```

**Verified failure chain (v55m_43h rev 13→15):** rev 13 gated on `0x5341E4+0x874` (garbage timer → never blocked, log showed angle advancing during pause); rev 14 gated on `sceneobj+0x874` (level+0x480 object → flag never set → still advanced); rev 15 gated on `board+0x874` → **user confirmed "it works"**. When a pause gate "doesn't work", the flag object is wrong — the log proving the angle still advances during a frozen ball is the diagnostic signal.

## Common mistakes

### `0x5341E4` is a GetTickCount timer, NOT a scene or board pointer

The mod log shows `g_Scene=0x105B182D` — a heap-ish tick value that changes every frame even BEFORE any level loads. `0x5341E4` is a GetTickCount/timer global. Do NOT dereference it as any object (board, scene, sceneobj). The real pointers: App at `0x5341E0`, board via `App+0x178` / profile+0x0C / level-load cache, sceneobj via `level+0x480`.

### `g_Scene+0x29D4` is not the ball list

The ball AthenaList is embedded in the **Board** object at `board+0x29D4`, not in any Scene object. Reading `g_Scene+0x29D4` returns unrelated memory and produces a NULL or garbage ball pointer.

```c
// WRONG — 0x5341E4 is a timer, not a scene/board
DWORD scene = *(DWORD*)0x005341E4;
DWORD ball_list = scene + 0x29D4;  /* garbage timer value + offset */

// CORRECT
DWORD board = get_board();           /* or use cached board pointer */
DWORD ball_list = board + 0x29D4;    /* AthenaList embedded in Board */
```

### `board+0x2DEC` is not the player ball list

`board+0x29D4` is the canonical ball AthenaList. `board+0x2DEC` was tried once and returned `count=0` while the level was running. If a list header is valid but `count=0` during gameplay, the offset is wrong. Always cross-check against `board+0x29D4` and verify `ball+0x18 == 0` (player index).

## `get_board()` may return 0 in Present hook context

The standard `get_board()` helper in `bass_proxy.h` tries:

1. `g_Scene` dereferenced as a board pointer (vtable range check).
2. `App+0x220` → profile → `profile+0x0C`.

In some contexts (especially the Present hook or early frames) these paths can return 0 even though the level is loaded. The level-load hook receives the correct board pointer as a parameter — cache it.

```c
static DWORD g_current_board = 0;

void on_level_loaded(DWORD board, DWORD level) {
    g_current_board = board;  /* cache for Present hook */
}

static DWORD get_ball_ptr(void) {
    DWORD board = g_current_board;
    if (!board || IsBadReadPtr((void*)board, 0x2A00)) return 0;
    DWORD ball_list = board + 0x29D4;
    DWORD count = *(DWORD*)(ball_list + 0x04);
    if (count == 0) return 0;
    DWORD items = *(DWORD*)(ball_list + 0x40C);
    if (!items) return 0;
    return *(DWORD*)items;
}
```

## AthenaList layout

the target uses a fixed `AthenaList` layout across the binary:

| Offset | Size | Field |
|--------|------|-------|
| `+0x00` | 4    | vtable |
| `+0x04` | 4    | count |
| `+0x40C`| 4    | items pointer (array of pointers) |

```c
// Correct iteration
count = *(DWORD*)(list + 0x04);
items = *(DWORD*)(list + 0x40C);
for (i = 0; i < count; i++) {
    DWORD obj = ((DWORD*)items)[i];
    ...
}
```

## Ball offsets

| Field | Offset | Use |
|-------|--------|-----|
| Position X | `0x164` | Read ball position. |
| Position Y | `0x168` | Read ball position. |
| Position Z | `0x16C` | Read ball position. |
| Force X | `0x170` | Add external forces (physics consumes these). |
| Force Y | `0x174` | Add external forces (physics consumes these). |
| Force Z | `0x178` | Add external forces (physics consumes these). |

Never write to `ball+0x14/0x18/0x1C` or `ball+0x20/0x24/0x28` for physics effects. The engine consumes forces from `0x170/174/178`. Direct position writes cause jitter and are ignored by physics.

## Diagnostic pattern: step-by-step logging

When a pointer retrieval fails, add a short-lived log at every step to see which one returns 0 or garbage.

```c
FILE* df = fopen("debug_access.log", "a");
if (df) {
    fprintf(df, "board=0x%08X list=0x%08X count=%u items=0x%08X ball=0x%08X\n",
        board, ball_list, count, items, ball);
    fclose(df);
}
```

Remove or gate the logging after the bug is fixed to avoid disk noise.

## Present hook vs background thread

- Pointer reads from the Present hook run on the main thread and are usually safe.
- Writing ball forces from a background thread races with `Ball_Update` and can corrupt physics state.
- Sound functions and D3D/Gfx calls must also run on the main thread; call them from the Present hook, not a worker thread.

## References

- `references/pointer-retrieval-diagnostics.md` — Session-specific example from the cEnt Catapult fix (v55m_27i–v55m_27k), including wrong `g_Scene+0x29D4` assumption, `get_board()` returning 0, and corrected `board+0x29D4` path.

