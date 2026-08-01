---
name: cpp-constructor-discovery
category: reverse-engineering
description: "Find C++ object constructors in decompiled x86 binaries, verify allocation sizes, vtable assignments, calling conventions, and struct layouts without game-specific addresses."
---

# C++ Constructor Discovery

> Adapted from the target-specific RE toolkit for general binary analysis.

## Overview

Identify C++ object constructors in decompiled x86 binaries by matching operator_new allocations to _ctor call pairs, verifying vtable assignments, and deriving struct sizes and calling conventions.

## The Operator New → Constructor Pattern

C++ object creation typically follows this sequence in decompiled code:

```c
obj = operator_new(size);
if (obj != NULL) {
    Constructor_ctor(obj, param1, param2, ...);
    obj->vtable = &Vtable_X;
}
```

**Key invariants to verify:**
1. operator_new argument = struct size (rounded up by compiler)
2. Constructor call immediately follows the NULL check
3. Vtable assignment happens inside the same NULL branch (or immediately after)
4. The number/size of stack args pushed before the call = constructor's parameter count

## Methodology

### 1. Find the Spawning Function
- Search strings for entity/object type names in the binary
- Cross-reference string addresses to find spawning/Create functions
- Decompile the spawning function with Ghidra

### 2. Identify Allocation Size
```c
puVar3 = (undefined4 *)operator_new(0x10d0);    // size = 0x10D0 bytes
```
- The operator_new argument reveals the struct size
- Compare sizes across similar entities — same base class = same or similar sizes
- A struct with vtable + position + mesh pointer + collision object is often 0x10D0 bytes for simple objects

### 3. Verify Constructor Signature
From disassembly or decompilation, count parameters:
```c
Constructor_ctor(obj, board, pos_x, pos_y, pos_z, mesh_ptr);
```
- Ghidra shows these as local vars or stack params
- If the constructor doesn't take position params, position is often written after construction at fixed offsets (e.g., obj+0x10D8)
- If the constructor doesn't take a mesh param, the mesh may be loaded internally (Level_MeshWorldCtor) or read from a global array

### 4. Match Vtable to Behavior Class
```c
*puVar3 = &Vtable_Rotator;       // 0x4D5708
// OR
*obj = 0xDEADBEEF;               // vtable pointer
```
- The vtable address identifies the behavior class
- Different vtables for different behaviors even if they share the same base constructor
- vtable[0] = destructor, vtable[1] = Update, vtable[N] = virtual methods

### 5. Check for vtable[1] Calls After Construction
Some constructors (especially simple ones) don't fully initialize the object. The spawning function may call vtable[1] after construction:

```c
Constructor_ctor(obj, ...);
(**(code **)(*obj + 4))(obj);     // vtable[1] call
```

**Always decompile vtable[1] to see what it does.** Don't assume it's "SetMesh" or "Initialize". Common patterns:
- Mesh loading from global arrays
- Collision setup and trajectory initialization
- Additional state machine initialization

### 6. Track Position Storage Offsets
When constructors don't take position params, position is stored at fixed offsets after construction:

```c
// Direct assignment after _ctor
*(float*)(obj + 0x10D4) = pos_x;
*(float*)(obj + 0x10D8) = pos_y;
*(float*)(obj + 0x10DC) = pos_z;
```

Use Ghidra's decompilation to find these offset patterns. Common offsets for position (32-bit):
- 0x10D4/0x10D8/0x10DC — position triple
- 0x10D0 — board pointer
- 0x10E0 — render object pointer
- 0x10E4 — additional parameters (speed, id, flags)

### 7. Identify Named Wrappers
When multiple entity types share the same base constructor but need distinct identities, games often create wrapper functions:

```c
// Wrapper function
void* EntityA_ctor(void* this, void* board, float x, float y, float z, void* mesh) {
    BaseStands_ctor(this, board, x, y, z, mesh);   // shared base
    *(int*)(this + 0x10DC) = 2;                     // EntityA-specific config
    *(int*)(this + 0x10E0) = 0;                     // EntityA-specific config
    return this;
}
```

### 8. Collision Object Offset
Decompile the spawning function to find which obj+offset is appended to collision lists:

```c
AthenaList_Append(board_collision_list, *(void**)(obj + collision_offset));
```

**Pitfall:** Don't assume position offsets are collision objects. Position floats (e.g., obj+0x10D4 = posX) are NOT pointers. Adding them to collision lists corrupts the spatial tree. Only append actual collision object pointers.

### 9. Parameter Count Verification via Ghidra

Always verify constructor parameter count via Ghidra decompilation before assigning a typedef. If the decompiled function takes N params, the typedef MUST have N params.

**Stack imbalance from wrong param count is a silent killer** — it may not crash immediately but corrupts the next call.

Example of correct verification:
```c
// Ghidra shows this constructor takes 3 params
typedef void* (__thiscall *SmallCtor_t)(void* this_, void* board, void* mesh);

// WRONG: casting to 6-param typedef causes stack imbalance
typedef void* (__thiscall *WrongCtor_t)(void* this_, void* board, float x, float y, float z, void* mesh);
```

### 10. Type Family Pitfall

Never assume a "family" of constructors share the same signature just because they call the same base constructor internally. Each wrapper may accept different params because they store position and mesh data at different offsets using different patterns.

## Common Constructor Patterns

### Pattern A: Full-Feature Constructor
```c
obj = operator_new(0x1500);
Rotator_ctor(obj, board, x, y, z, mesh);
*obj = &Vtable_Rotator;
```
- Takes all params: position, mesh, board
- Sets vtable immediately
- Size: 0x1500+ bytes (complex objects with animation state)

### Pattern B: Minimal Constructor + Post-Init
```c
obj = operator_new(0xC70);
BadBall_ctor(obj, board);               // 2 params only
*(float*)(obj + 0xC60) = pos_x;         // position after
*(float*)(obj + 0xC64) = pos_y;
*(float*)(obj + 0xC68) = pos_z;
*obj = &Vtable_BadBall;
// Spawning function then calls vtable[1] for additional init
```

### Pattern C: String-Path Constructor
```c
obj = operator_new(0x1AE7C);            // huge: 110KB+
Wavy_ctor(obj, board, x, y, z, "levels\\Flag");   // string path, not mesh ptr
```
- Takes a string path, loads mesh internally
- Often background/decorator objects (flags, clouds)

### Pattern D: Global Renderer Constructor
```c
if (*(void**)(board + 0x3F18) == NULL) {
    *(void**)(board + 0x3F18) = operator_new(0x8C);
    FlagWaver_ctor(*(void**)(board + 0x3F18), gfx_device);
}
```
- Single-instance per board (global renderer)
- Not a per-entity constructor
- Calling this for each entity will crash due to object layout mismatch

## Key Offsets (Typical for 32-bit MSVC C++ Objects)

| Offset | Common Use |
|--------|-----------|
| 0x00 | vtable pointer |
| 0x04 | position X (float) or parent pointer |
| 0x08 | position Y (float) or mesh pointer |
| 0x0C | position Z (float) |
| 0x10 | parent/game app pointer |
| 0x14 | scale / render transform |
| 0x480 | SceneObject* (for Level-based objects) |
| 0x10D0 | board pointer (post-constructor) |
| 0x10D4 | position X (post-constructor) |
| 0x10D8 | position Y |
| 0x10DC | position Z |
| 0x10E0 | render object / collision object |
| 0x10E4 | speed / id / extra params |

## Verification Workflow

1. Decompile spawning function → find operator_new + _ctor pair
2. Note operator_new size → confirm struct size
3. Count constructor params from decompilation or disassembly
4. Verify vtable assignment address → confirm behavior class
5. Check if vtable[1] is called after _ctor → decompile vtable[1]
6. Identify position/collision object offsets from spawning function
7. Verify collision offset is a POINTER, not a float (check with Ghidra type analysis)
8. Create typedef with correct param count
9. Test with crash test (startup) + functionality test (actual behavior)

## Generalizable Pitfalls

1. **Constructor address wrong**: an address that isn't a function entry point will crash when the entity spawns. Always verify with `search_functions(name_pattern)` in Ghidra.
2. **Parameter count mismatch**: casting a constructor to a typedef with more params causes stack imbalance. The callee cleaning too much or too little stack → crash later.
3. **vtable[1] assumption**: never assume vtable[1] loads a mesh. Decompile it first.
4. **Named wrapper confusion**: a wrapper named `Entity_ctor` may just call `Base_ctor` without doing anything entity-specific.
5. **Collision offset = float**: adding a position float to a collision list (expecting a pointer) will corrupt the spatial tree.
6. **Range off-by-one**: when multiple entity types share a constructor family, ensure your switch/case range includes the new type.

## References

- Operator new pattern + constructor call pairs in decompiled spawning functions
- Vtable slot comparison technique for differentiating behavior classes
- Ghidra decompilation for param count verification
