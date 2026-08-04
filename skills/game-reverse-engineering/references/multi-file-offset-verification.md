# Multi-File Offset Verification Methodology

Technique for verifying struct field offsets across an entire decompiled codebase, not just a single function.

## Problem

Single-function decompilations can mislead:
- Ghidra generates comment headers with guessed field names that may be wrong
- A field may be named in a comment but never actually accessed in the raw C body
- Array-index notation (`param_1[0x69]`) obscures the true byte offset

## Solution: Raw C Scan + Ref-Count Confidence

### Step 1: Extract all offset references from all decomp files

```bash
# Search all raw decompiled C files for a specific byte offset
grep -rn "0xca8\|0xcac\|0xcb0" analysis/ghidra/decompilations/ > /tmp/offset_ca8_refs.txt

# Search for int-indexed references (N * 4 = byte_offset)
grep -rn '\[0x32a\]' analysis/ghidra/decompilations/  # 0x32a * 4 = 0xCA8
```

### Step 2: Parse and categorize references

For each match, determine:
1. **File name** — which function's decompilation
2. **Operation** — read or write? (`= ` for write, `==` or arithmetic for read)
3. **Context** — is it in raw C code or just a comment header?
4. **Pointer chain** — direct `param_1 + 0xNNNN` or indirect `*(param_1 + 0x14) + 0xNNNN`?

### Step 3: Build confidence score

| Refs | Confidence | Meaning |
|------|-----------|---------|
| 0 raw C refs, only in comments | ❌ Dead / mislabeled | Field name may be Ghidra guess, not actually used |
| 1-2 refs in raw C | ❓ Single-source | Needs second-function verification |
| 3-5 refs across 2+ files | ⚠️ Likely correct | Cross-reference with constructor + update |
| 6+ refs across 3+ files | ✅ Verified | Safe for modding documentation |

### Step 4: Second-function rule

For any field with < 3 refs, find a second function that touches it:
- **Constructor + Update**: ctor initializes, update reads → persistent state
- **Update + Render**: update writes, render reads → display field
- **Update + Dtor**: update writes, dtor reads → needs cleanup

If no second function exists, the field may be dead code.

## Example: CollisionMesh +0xCA8 (vel_quat)

```
# grep results for 0xca8:
decomp_collisionmesh_ctor.c:141:    *(float *)((int)this + 0xCA8) = 0.0;  // init x
                             142:    *(float *)((int)this + 0xCAC) = 0.0;  // init y
                             143:    *(float *)((int)this + 0xCB0) = 0.0;  // init z
                             144:    *(float *)((int)this + 0xCB4) = 1.0;  // init w (identity)
decomp_ball_update.c:86:    fVar2 = *(float *)(param_1[0x69] + 0xCA8);  // read vel_quat.x
decomp_ball_update.c:87:    fVar3 = *(float *)(param_1[0x69] + 0xCAC);  // read vel_quat.y
decomp_ball_update.c:88:    fVar4 = *(float *)(param_1[0x69] + 0xCB0);  // read vel_quat.z
decomp_ball_update.c:89:    fVar5 = *(float *)(param_1[0x69] + 0xCB4);  // read vel_quat.w
decomp_ball_update.c:95:    *(float *)(param_1[0x69] + 0xCA8) = fVar6;  // write back integrated x
decomp_ball_render.c:42:    q.x = *(float *)(collisionMesh + 0xC9C);  // reads DISPLAY quat, not vel quat
decomp_collisionmesh_dtor.c:20:    operator_delete(*(void **)((int)this + 0x18));  // cleanup sub-object
```

**Analysis:**
- Constructor initializes to identity quaternion (0,0,0,1) → ✅ persistent state field
- Ball_Update reads all 4 components, integrates physics, writes back → ✅ physics uses this
- Ball_Render reads +0xC9C (different offset!) for display → display_quat is separate field
- Dtor does NOT touch +0xCA8 → no special cleanup needed

**Conclusion:** +0xCA8 is a **verified persistent physics field** (✅), not dead code.

## Automation Script

See `scripts/verify_offset.py` for an automated version that:
1. Takes an offset and directory of decomp files
2. Greps all files, categorizes refs
3. Outputs confidence score + file list
