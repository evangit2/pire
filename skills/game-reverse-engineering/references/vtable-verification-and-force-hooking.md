# Vtable Verification & Force Hooking Pitfalls

## The Duplicate Function Trap

target application's binary contains duplicate copies of some functions. The ball
vtable at `0x4CF3A0` contains these function pointers:

| Slot | Offset | Address | Notes |
|------|--------|---------|-------|
| 0 | +0x00 | 0x004027F0 | dtor |
| 1 | +0x04 | 0x00408100 | |
| 2 | +0x08 | 0x00402DE0 | |
| 3 | +0x0C | 0x00402A70 | |
| 4 | +0x10 | 0x00408390 | |
| 5 | +0x14 | 0x00401590 | |
| **6** | **+0x18** | **0x00402650** | **Ball_ApplyForceV2 (ACTUAL)** |
| 7 | +0x1C | 0x00402C10 | |

A SEPARATE vtable at `0x4CF32C` has `Ball_ApplyForceV2` at slot 0 (offset +0x00)
= `0x004016F0`. Both functions have **identical bytecode**:

```
56 8B F1 8A 86 F9 02 00 00 84 C0 0F 85 82 01 00
PUSH ESI; MOV ESI,ECX; MOV AL,[ESI+0x2F9]; TEST AL,AL; JNE +0x182
```

The collision code at `0x406DA6` does `CALL [EDX+0x18]` where `EDX = [EDI]` =
ball vtable = `0x4CF3A0`. So it calls `0x00402650`, NEVER `0x004016F0`.

**LESSON:** Always read the vtable memory and verify which function pointer is
actually stored at the dispatch offset before hooking.

## Force Application Architecture

### Call Chain
```
Ball_Update (0x405E00, __fastcall ECX=ball)
  └─ collision loop iterates AthenaList at ball+0x1A4+0x18
     └─ type-1 collision: ball-ball
        ├─ 0x406D87: PUSH 1.0 (magnitude for force on EDI = other ball)
        │  └─ CALL [EDX+0x18] → 0x402650(EDI, dirX, dirY, dirZ, 1.0)
        └─ 0x406DAF: PUSH 1.0 (magnitude for force on ESI = current ball)
           └─ CALL [EDX+0x18] → 0x402650(ESI, dirX, dirY, dirZ, 1.0)
```

### Ball_ApplyForceV2 (0x402650) Internal Multipliers

The magnitude parameter is modified by the receiver's state BEFORE accumulation:

| Condition | Address | Multiplier | Effect |
|-----------|---------|------------|--------|
| ball+0x2F0 != 0 (timer) | 0x4CF380 | 0.25 | 75% reduction |
| ball+0x324 (sweat) | 0x4CF378 | **0.0** | **ZEROES force** |
| ball+0xC5C (8-ball) | 0x4CF374 | 0.20 | 80% reduction |
| ball+0xC4C (flag) | 0x4CF36C | 0.75 | 25% reduction |

Guards (ALL must be false to apply force):
- ball+0x2F9 (drowning) == 0
- ball+0x2CC (dizzy_lock) == 0
- ball+0x808 (in_water) == 0
- ball+0x2F0 < 0x51 (81)

### Why 20x Force "Doesn't Work"

Even with magnitude = 20.0:
1. If receiver has sweat (ball+0x324): 20.0 × 0.0 = 0.0 (no force)
2. If receiver is 8-ball: 20.0 × 0.2 = 4.0 (only 4x, may look "normal")
3. If receiver has timer: 20.0 × 0.25 = 5.0 (5x, moderate)
4. **Velocity is capped at ball+0x188 (max_speed = 6.0)** — accumulated
   force increases velocity, but velocity is clamped. Large force values
   cause the ball to reach max speed in one frame, but the user perceives
   no difference because the TOP SPEED is unchanged.

### Why 20x Force Freezes All Players

Changing the PUSH operand at `0x406D88` from 1.0 to 20.0 freezes ALL players
because:
1. The collision code at 0x406D87 runs every frame for every ball
2. 20x force causes extreme velocity → physics NaN/explosion
3. NaN position → all subsequent physics calculations fail → frozen

**Safe test values:** 3.0 (0x40400000) or 5.0 (0x40A00000)

## CE Script Hook Strategy Comparison

### Strategy 1: Hook PUSH at Call Site (0x406D87) — RECOMMENDED
- Only fires during ball-ball collision code in Ball_Update
- P1 check via App+0x5DC pointer comparison
- Trampoline replays: FCHS, SUB ESP+0C, FSTP [ESP+08], MOV ECX,EDI
- Risk: moderate (FPU state must be preserved, but PUSH doesn't affect FPU)

### Strategy 2: Hook Function Entry (0x402650) — NOT RECOMMENDED
- Catches ALL 17 call sites, not just collision
- Return address check needed to filter to collision-only
- Caller's ESI saved on stack — but ESI varies across callers
- Risk: HIGH — clobbering AL before TEST AL,AL freezes all players
  (the drowning guard reads garbage → function breaks → no force applied)

### Strategy 3: Simple Byte Patch (0x406D88) — DIAGNOSTIC ONLY
- Changes force for ALL balls, no P1 filter
- Useful to confirm hook point works
- 20.0 freezes players (NaN); use 3.0 to test
