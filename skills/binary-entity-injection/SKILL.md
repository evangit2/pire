---
name: binary-entity-injection
description: Build and debug DLL proxy mods that spawn custom entities from binary reference points, including collision, animation, and launch mechanics.
tags: [reverse-engineering, binary-injection, dll-proxy, entity-spawning, mingw]
---

# Binary Entity Injection

> Adapted from the target-specific RE toolkit for general binary analysis.

Build and debug DLL proxy mods that spawn custom entities from binary reference points in level files. This skill focuses on the general pattern: scan a binary format for reference points, load meshes, construct game objects, register them on internal lists, and drive per-frame behavior from a renderer or frame-update hook.

## When to use this skill

- Spawning objects from level-file reference points (e.g. named nodes, S1 markers, tagged collision planes).
- Replicating native level objects (catapults, bumpers, turrets, etc.) on arbitrary levels.
- Fixing invisible entities, missing collisions, or silent launch/trigger bugs.
- Packaging proxy DLL mods where the DLL name matches the original target DLL exactly.

## Core architecture

1. **Reference-point scan**: read the scene object's reference-point list for markers whose names match a custom prefix (e.g. `cEnt_001`, `REF:Custom_...`). The exact struct offsets depend on the target binary; find them via RE.
2. **Mesh load**: call the target game's mesh constructor to load visual/collision mesh data.
3. **Object construction**: call the native constructor that matches the entity type.
4. **List registration**: add the object to the board update list, render list, and scene spatial tree. Only add real collision objects to the appropriate collision list.
5. **Per-frame behavior**: run from a Present hook or frame-update hook so physics and graphics calls stay on the main thread.

## Player object lookup

The canonical player list is typically a list/array inside the scene/board struct. Do NOT use secondary or cached pointers that may be empty on some levels. Select the object with player index 0.

```c
static DWORD get_player_ptr(DWORD board) {
    if (!board || board < 0x10000) return 0;
    /* Offsets are binary-specific; replace with values from your target */
    DWORD list = board + PLAYER_LIST_OFFSET;
    if (IsBadReadPtr((void*)list, 0x410)) return 0;
    DWORD count = *(DWORD*)(list + 0x04);
    if (count == 0) return 0;
    DWORD items = *(DWORD*)(list + LIST_ITEMS_OFFSET);
    if (!items || IsBadReadPtr((void*)items, count * 4)) return 0;

    for (DWORD i = 0; i < count; i++) {
        DWORD obj = ((DWORD*)items)[i];
        if (!obj || IsBadReadPtr((void*)obj, 0x200)) continue;
        if (*(DWORD*)(obj + PLAYER_ID_OFFSET) == 0) return obj;
    }
    return 0;
}
```

## Proximity triggers for large objects

For objects whose native collision events only fire on their home level, use a mod-side proximity trigger. Size the trigger to the actual mesh extents, not just the pivot point. Add a **one-trigger-per-approach** flag so staying inside the zone does not refire every cooldown.

### Prefer native collision events when possible

If the level mesh contains the native event plane, hook the collision dispatch rather than using a proximity trigger. Native collision is more precise and lets the original wind-up/launch animation run.

### Calibrating trigger zones

A spherical radius guessed from the pivot will usually be wrong: too large fires at the rim and repels the player before entry; too small never fires. Add per-frame probe logging while the player is near and use the recorded distances to set the real footprint.

For a catapult-style mesh the working trigger is horizontal footprint + vertical window, not 3-D radius. Example constants:

```c
float dx = player_x - pivot_x;
float dy = player_y - pivot_y;
float dz = player_z - pivot_z;
float horiz_sq = dx*dx + dz*dz;

int in_trigger = (horiz_sq < TRIGGER_HORIZ_SQ && dy > Y_MIN && dy < Y_MAX);
int in_reset   = (horiz_sq < RESET_HORIZ_SQ && dy > RESET_Y_MIN && dy < RESET_Y_MAX);

if (in_trigger && !cs->was_in_zone) {
    cs->was_in_zone = 1;
    // launch once
}
if (!in_reset) {
    cs->was_in_zone = 0;   // re-arm only after leaving the zone
}
```

Evolution of this trigger shows the diagnostic value of per-frame logs:
- v1: radius too large, fires early while player is above the bowl → push-away feel.
- v2: radius too tight, player sits outside the zone → never triggers, no sound.
- v3: widened horizontal but strict vertical → catches the bowl while requiring correct Y level.

Rule: **tune the trigger until logs show the player entering the zone at the expected mesh location, then adjust force magnitude if the launch still feels wrong.** Do not assume a hidden "enter force" exists without decompilation evidence.

### Playing sounds from a proxy mod

The game's native sound manager may crash when loading a channel on-the-fly from a hook. The safe way is to bypass the game's sound manager and use the target audio library directly from the proxy DLL.

Load function pointers in `load_real_library()` with **decorated-name fallback** (plain `GetProcAddress` may fail on some DLLs):

```c
typedef DWORD (__stdcall *SampleLoad_t)(BOOL, const void*, DWORD, DWORD, DWORD, DWORD);
typedef DWORD (__stdcall *SamplePlay_t)(DWORD);
static SampleLoad_t real_SampleLoad = NULL;
static SamplePlay_t real_SamplePlay = NULL;

/* Load with fallback */
real_SampleLoad = (SampleLoad_t)GetProcAddress(g_hRealLib, "BASS_SampleLoad");
if (!real_SampleLoad) real_SampleLoad = (SampleLoad_t)GetProcAddress(g_hRealLib, "_BASS_SampleLoad@24");
```

Load the sample once at level start, play via the one-shot function, and free on level unload. Avoid `SampleGetChannel` + `ChannelPlay`; this path may cause heap corruption.

## Disk I/O and lag

`fopen`/`fprintf`/`fclose` every frame causes lag spikes. Keep debug logging to trigger events only. Do not log player positions or list scans every frame. If the user reports lag, audit every per-frame log call.

## Source-patch hygiene

Iterating a fix via many small overlapping patches on a single large .c file is risky: duplicated blocks, merged braces, or stray text can be inserted silently and later builds pass while producing corrupted logic. When a file has been patched more than twice for the same feature, prefer a single consolidated patch after `git checkout -- <file>`. Verify the diff shows exactly the intended change before building.

## Communication while iterating

When the user sends a short continuation such as "Go ahead" or a clarifying correction, do not echo their message back or treat it as empty. The active task continues; proceed with the next build/test/package step. If you are genuinely unsure what to do next, ask a single focused question rather than repeating the user's words.

## Apply forces correctly

Never write to position fields directly — it causes jitter. Use the physics force accumulators so the game's collision response consumes them properly:

```c
*(float*)(ball + FORCE_X_OFFSET) += dir_x * force;
*(float*)(ball + FORCE_Y_OFFSET) += dir_y * force;
*(float*)(ball + FORCE_Z_OFFSET) += dir_z * force;
```

Native consumption happens inside the game's physics tick with proper collision response.

## Packaging and version verification

The running DLL reports its version in the first log line. If the log says `v1a` but the zip is named `v1b`, the game loaded the wrong file. Before claiming a build is correct, verify the embedded string:

```bash
strings proxy.dll | grep "Custom Entities Mod"
```

After every source change:
1. Bump the version header string and the runtime banner string.
2. Rebuild the proxy DLL.
3. Verify the embedded version with `strings`.
4. Copy the new DLL into the mod folder.
5. Create a new zip with the matching suffix.
6. Delete the previous zip to avoid confusion.
7. Push to git.

## See Also

- `dll-proxy-injection` — DLL proxy pattern, export forwarding, DllMain safety
- `dll-mod-authoring` — full C source → proxy DLL → installation → testing workflow
