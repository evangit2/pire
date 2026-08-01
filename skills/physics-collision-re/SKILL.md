---
name: physics-collision-re
description: Raycast-based collision detection RE — calling conventions, spatial tree traversal, and normal-vector force application.
---

# Physics Collision Reverse Engineering

> Adapted from the target-specific RE toolkit for general binary analysis.


# the target Raycast Ground Detection

Use the game's native `Mesh_FindClosestCollision` (0x465D90) to detect whether the ball is on the ground. This is the ONLY acceptable ground detection method — the user explicitly rejected flag-based detection (0x2E9, 0x260, 0xC4C — all wrong) AND cooldown timers. **Never propose flag or cooldown approaches for ground detection in this game.**

## Key Facts

- **Function:** `Mesh_FindClosestCollision` at RVA `0x00465D90`
- **Calling convention:** `__thiscall` — ECX = mesh_data pointer, callee-clean `RET 0x20` (pops 32 bytes / 8 DWORDs)
- **Mesh data source:** `ball+0x14` → scene, then `scene+0x8B0`
- **Ball position offsets:** X=+0x164, Y=+0x168, Z=+0x16C
- **Ball radius:** +0x284 (normal=26.0, shrunk=13.0 Odd Race)
- **App pointer:** 0x005341E0

## Calling Convention — Use `__attribute__((thiscall))` Function Pointer

**DO NOT use inline asm to call this function.** Previous versions used inline asm with manual `sub esp, 0x20` + `mov [esp+N]`, which corrupted GCC's stack frame tracking. When GCC inlines the wrapper into the caller at `-O2`, manual ESP manipulation causes all subsequent local variable reads to be at wrong stack offsets, producing garbage `0x80000000` (INT_MIN) values.

**Correct approach** — let GCC handle the calling convention natively:

```c
typedef float* (__attribute__((thiscall)) *raycast_fn_t)(
    void *mesh_data,   /* this → ECX */
    float *out_hit,    /* [ESP+0x00] — pushed last */
    float ox,           /* [ESP+0x04] */
    float oy,           /* [ESP+0x08] */
    float oz,           /* [ESP+0x0C] */
    float dx,           /* [ESP+0x10] */
    float dy,           /* [ESP+0x14] */
    float dz,           /* [ESP+0x18] */
    float radius        /* [ESP+0x1C] */
);

#define ADDR_Mesh_FindClosestCollision 0x00465D90

static float* do_raycast(void *mesh_data,
                         float ox, float oy, float oz,
                         float dx, float dy, float dz,
                         float radius_scale,
                         float *out_hit)
{
    raycast_fn_t fn = (raycast_fn_t)(DWORD)ADDR_Mesh_FindClosestCollision;
    return fn(mesh_data, out_hit, ox, oy, oz, dx, dy, dz, radius_scale);
}
```

MinGW 13-win32 generates correct callee-clean code: sets ECX, pushes args, no caller cleanup needed. Verified by cross-compiling and disassembling the output.

### Stack Parameter Order (verified against game's own call sites at 0x4064b9, 0x4074b7, 0x4406ee)

Args pushed right-to-left by caller, cleaned by callee via `RET 0x20`:

| Stack offset | Parameter |
|---|---|
| [ESP+0x00] | out_hit (float* — receives hit position vec3) |
| [ESP+0x04] | origin_x |
| [ESP+0x08] | origin_y |
| [ESP+0x0C] | origin_z |
| [ESP+0x10] | dir_x |
| [ESP+0x14] | dir_y |
| [ESP+0x18] | dir_z |
| [ESP+0x1C] | radius_scale (use 1.0f) |

Return value (EAX): pointer to out_hit vec3 (same as out_hit param).

## Ground Detection Logic

Shoot a ray straight down `(0, -1, 0)` from the ball's world position. If the hit Y is within the ball's reach, the ball is grounded.

```c
static int is_ball_grounded(DWORD ball)
{
    if (!ball) return 0;

    DWORD scene = *(DWORD*)(ball + 0x14);
    if (!scene) return 0;

    DWORD mesh_data = *(DWORD*)(scene + 0x8B0);
    if (!mesh_data) return 0;

    float ball_x = *(float*)(ball + 0x164);
    float ball_y = *(float*)(ball + 0x168);
    float ball_z = *(float*)(ball + 0x16C);
    float radius = *(float*)(ball + 0x284);

    float hit_result[3] = {0.0f, 0.0f, 0.0f};

    do_raycast((void*)mesh_data,
               ball_x, ball_y, ball_z,
               0.0f, -1.0f, 0.0f,   /* straight down */
               1.0f,                 /* radius_scale */
               hit_result);

    float hit_y = hit_result[1];
    float dist = fabsf(hit_y - ball_y);
    float threshold = radius * GROUND_SLOPE_FACTOR;

    return (dist < threshold) ? 1 : 0;
}
```

## Slope-Aware Threshold (CRITICAL)

A straight-down raycast on a slope of angle θ hits the ground at distance `radius / cos(θ)` from the ball center — NOT `radius`. On a ~26° slope this gives `26 / cos(26°) ≈ 28.9`, which exceeds `radius + 2.0 = 28.0`, causing jumps to be denied on hills that should be valid.

**Use `radius * 1.45`** — covers slopes up to 45° (cos(45°) = 0.707, r/0.707 = 1.414r, and 1.45 gives a small safety margin beyond √2).

```c
static const float GROUND_SLOPE_FACTOR = 1.45f;  /* covers up to 45° slopes */
```

**DO NOT use `radius + 2.0f`** — that only works on flat ground and shallow slopes (~15° max).

## Integration with Jump Mod

The raycast runs in a polling thread (not in the game's render thread). The input thread polls spacebar every 16ms. On rising-edge keypress, it runs the raycast. If grounded, sets `g_want_jump=1`. The Phase 15 code cave (hooked at 0x407BB4 inside Ball_Update) checks `g_want_jump` and applies upward impulse to `ball+0x174` (Y force accumulator).

Ball pointer is captured from the Phase 15 cave (ESI=ball) via `MOV [g_ball_ptr], ESI` and stored in a global for the input thread to use.

## Build

```
i686-w64-mingw32-gcc -shared -o target.dll jump_mod_raycast.c -lwinmm \
  -Wl,--enable-stdcall-fixup -O2 -static -static-libgcc -Wl,--add-stdcall-alias
```

## Version History (what failed and why)

- **v13-v16:** Flag-based ground detection (0x2E9, 0x260, 0xC4C) and cooldown timers — ALL REJECTED by user. Wrong offsets, unreliable.
- **v17:** First raycast attempt using inline asm runtime trampoline — worked but fragile.
- **v18:** Inline asm with `sub esp,0x20` + `mov [esp+N]` — corrupted GCC stack frame tracking, all variables read as `0x80000000`.
- **v19:** `__attribute__((thiscall))` function pointer — correct calling convention, raycast works. But `radius + 2.0` threshold failed on slopes >26°.
- **v20:** Slope-aware threshold `radius * 1.4` — works on slopes up to ~44°.
- **v20b:** Threshold `radius * 1.45` — works on 45° slopes. **CURRENT WORKING VERSION.**

## Pitfalls

1. **Never use inline asm for this call** — GCC inlining + manual ESP manipulation = corrupted local variable reads.
2. **Never use flag-based detection** — wrong offsets, unreliable on slopes/edges.
3. **Never use `radius + constant` threshold** — fails on slopes because ray distance grows as `r/cos(θ)`.
4. **Thread safety:** The raycast runs in a polling thread, not the game thread. This is safe because `Mesh_FindClosestCollision` is a pure query function (read-only mesh traversal).
5. **Ball pointer capture:** Must store ESI from Phase 15 cave to a global for the input thread to access. The input thread cannot traverse App→Scene→Ball list reliably at all times (race during scene transitions).

