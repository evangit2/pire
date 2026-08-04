# target application __thiscall Convention Analysis

## Problem

Spawning a BadBall via injected code crashes even though `operator_new` allocates memory
correctly. The crash occurs inside `Ball_ctor` because the calling convention is `__thiscall`
but the CallMethod wrapper treats all arguments as `__cdecl` (pushed on stack).

## Root Cause

ALL game member functions use `__thiscall`:
- First argument (`this`) goes in **ECX** register
- Remaining arguments go on the **stack**
- Callee cleans the stack for `__thiscall`

When `CallMethod(address, arg1, arg2)` pushes all args on the stack (`__cdecl` style),
the called function reads ECX as `this`, but ECX contains garbage from the caller's context.

## Verified by Ghidra Disassembly

```
Ball_ctor (0x40AFE0) prologue:
  6A FF             PUSH -1               ; SEH guard
  68 A6 95 4C 00    PUSH offset __ehhandler
  64 A1 00 00 00 00 MOV EAX, FS:[0]      ; thread exception chain
  50                PUSH EAX
  64 89 25 ...      MOV FS:[0], ESP       ; install SEH
  83 EC 18          SUB ESP, 0x18
  8B 44 24 28       MOV EAX, [ESP+0x28]   ; param_1 (scene) from stack
  56                PUSH ESI
  57                PUSH EDI
  8B F1             MOV ESI, ECX          ; SAVE THIS FROM ECX ← thiscall!
  50                PUSH EAX              ; push scene as arg to Ball_ctor2
  89 74 24 0C       MOV [ESP+0xC], ESI
  E8 D6 89 FF FF    CALL Ball_ctor2       ; calls 0x4039E0

Ball_InitPhysicsDefaults (0x405100) prologue:
  51                PUSH ECX              ; save ECX (this)
  56                PUSH ESI
  8B F1             MOV ESI, ECX          ; SAVE THIS FROM ECX ← thiscall!
  E8 A7 C4 FF FF    CALL 0x4015B0         ; sound/render setup (thiscall)
  83 EC 14          SUB ESP, 0x14
  ...

AthenaList_Append (0x53780):
  Ghidra confirms: void __thiscall AthenaList_Append(void *this, int param_1)
  ECX = list pointer, Stack = item
```

## The Fix

Use `__thiscall` function pointer types in C/C++:

```cpp
typedef void* (__thiscall *ThisCall_Ctor)(void* thisPtr, int scene);
typedef void  (__thiscall *ThisCall_Method0)(void* thisPtr);
typedef void  (__thiscall *ThisCall_Method1)(void* thisPtr, int arg);

// Ball_ctor: ECX=mem, stack=scene
auto ballCtor = (ThisCall_Ctor)0x40AFE0;
void* ball = ballCtor(allocatedMem, (int)scene);

// Ball_InitPhysicsDefaults: ECX=ball, no stack args
auto initPhysics = (ThisCall_Method0)0x405100;
initPhysics(ball);

// AthenaList_Append: ECX=&list, stack=item
auto listAppend = (ThisCall_Method1)0x53780;
listAppend(&scene->ball_list, (int)ball);
```

## What Ball_InitPhysicsDefaults Actually Does

The vtable[1] call (0x405100) that CreateBadBall makes after construction:

1. Calls 0x4015B0 (sound render setup, thiscall on ball)
2. Calls 0x403850 (Ball_SetTrajectory with zeros from stack)
3. Sets physics defaults:
   - `ball->0x18 = -1` (player_index = -1, NPC)
   - `ball->0x278 = 0.5f` (gravity)
   - `ball->0x27C = 35.0f`
   - `ball->0x188 = 6.0f` (max_speed)
   - `ball->0xC78 = 0` (cleared)
   - `ball->0xC7C = 50.0f` (default chase distance)
   - `ball->0xC6C = 600.0f` (default home distance)
   - `ball->0xC70 = 1200.0f` (default spin distance)

These are DEFAULT values — CreateBadBall overwrites them with level data (CHASE, HOME,
SIZE, SPINDISTANCE tags) after calling this init.

## Ball_ctor vs Ball_ctor2

Ball_ctor (0x40AFE0) — the 0xC98 "badball" constructor:
- Calls Ball_ctor2 (0x4039E0) internally FIRST
- Then overwrites vtable to Ball_vtable (0x4CF3A0)
- Then does Ball-specific init: Vec3_Init, Matrix_Scale4x4
- Do NOT call Ball_ctor2 separately — Ball_ctor already calls it

Ball_ctor2 (0x4039E0) — the 0xC60 "player ball" constructor:
- Called internally by Ball_ctor
- Sets GameObject vtable (0x4CF314) — NOT the Ball vtable
- Initializes UITimer, Timer, RenderContext, RumbleBoard, AthenaList
- Creates CollisionMesh via operator_new(0xCB0) + CollisionMesh_ctor
- Sets dozens of default values (radius=26.0, speed=4900.0, etc.)

## Operator New

- `operator_new` at 0x4BA57B is the CRT `operator new` — compatible with MinGW's `::operator new`
- No heap mismatch: the game's `operator_delete` pairs with CRT `operator_new`
- The crash is NOT an allocator issue — it's the calling convention