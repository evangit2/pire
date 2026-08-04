# D3D8 Device Vtable Mapping (Ghidra-Verified, sess575)

Verified by decompiling `Graphics_ApplyMaterialAndDraw` (0x455110) and
tracing every D3D device vtable call. The game accesses the D3D8 device
through a wrapper at `gfx+0x154`, then calls vtable functions by offset.

## Confirmed Vtable Indices

| Vtable Index | Byte Offset | D3D8 Function | Usage in target application |
|---|---|---|---|
| 37 | 0x94 | SetTransform | View/projection/world matrices (Graphics_BeginFrame, Level_SetObjectTransform) |
| 42 | 0xA8 | SetMaterial | D3DMATERIAL8 per meshbuffer (diffuse/ambient/specular/emissive) |
| 50 | 0xC8 | SetRenderState | All render state changes (AMBIENT, FOG, BLEND, etc.) |
| 61 | 0xF4 | SetTexture | Bind texture to stage 0 per material |
| 63 | 0xFC | SetTextureStageState | COLOROP, COLORARG1, ALPHAARG1 per material |

## How to Read Vtable Calls in Decompilation

Ghidra shows vtable calls as `(**(code **)(*(gfx+0x154) + OFFSET))()`.
The OFFSET is a byte offset into the vtable. To get the vtable index:
`index = OFFSET / 4`.

Example from Graphics_ApplyMaterialAndDraw:
```c
// SetTexture(stage=0, texture)
(**(code **)(**(int **)((int)gfx + 0x154) + 0xf4))(device, 0);

// SetTextureStageState(stage=0, COLOROP, SELECTARG1)
(**(code **)(**(int **)((int)gfx + 0x154) + 0xfc))(device, 0, COLOROP, 2);

// SetMaterial(&D3DMATERIAL8)
(**(code **)(**(int **)((int)gfx + 0x154) + 0xa8))(device, material_ptr);

// SetRenderState(ALPHATESTENABLE, flag)
(**(code **)(**(int **)((int)gfx + 0x154) + 0xc8))(device, 0x39, flag);
```

## Graphics_ApplyMaterialAndDraw (0x455110) — Full Flow

This function is called for EVERY meshbuffer rendered. It:

1. **Material selection**: checks `gfx+0x7C0` for override material. If NULL,
   uses the passed-in material (`param_1`).
2. **Transform**: if `gfx+0x7A8` flag set, applies scale transform via
   `Matrix_ScaleTransform` using floats at `gfx+0x7B0..0x7BC`.
3. **No-material path** (`material[0x12]==0`):
   - `SetTextureStageState(0, COLOROP, SELECTARG1=2)` — solid color, no texture
   - `SetTexture(0, NULL)` — unbind texture
4. **Has-material path** (`material[0x12]!=0`):
   - Reads blend flags from `material+0x1C` and `material+0x13`
   - `SetRenderState(ALPHABLENDENABLE, mode)` based on flags
   - `SetTexture(0, material_texture)` — bind texture
   - `SetTextureStageState(0, COLORARG1, ...)` — color arg config
   - `SetTextureStageState(0, ALPHAARG1, ...)` — alpha arg (material+0x1D)
5. **Material + alpha test**:
   - `SetMaterial(&material+0x04)` — D3DMATERIAL8 struct
   - `SetRenderState(0x39, has_alpha)` — D3DRS_ALPHATESTENABLE from material+0x4D
6. **World matrix**: `Level_SetObjectTransform` (0x40B9C0) copies 4x4 matrix
7. **Draw**: calls `vtable[0]` on material object (DrawSubset/DrawPrimitive)

## gfx Struct Offsets (Verified)

| Offset | Size | Purpose |
|---|---|---|
| +0x05 | byte | Cached texture stage state (dirty flag) |
| +0x154 | ptr | D3D device wrapper (vtable pointer) |
| +0x700 | byte | Cached fillmode/blend state (dirty flag) |
| +0x70D | byte | Cached FILLMODE state |
| +0x730 | DWORD | Cached ambient D3DCOLOR |
| +0x734 | byte | Fog enable flag |
| +0x738 | DWORD | Cached fog/background D3DCOLOR |
| +0x7A8 | byte | Has-transform flag |
| +0x7B0-0x7BC | 4 floats | Transform scale (X,Y,Z,W) |
| +0x7C0 | ptr | Override material (NULL = use passed-in) |
| +0x7C8 | int | State change counter (for stats/debug) |

## Material Object Layout (Verified)

| Offset | Size | Purpose |
|---|---|---|
| +0x00 | ptr | vtable (DrawSubset at slot 0) |
| +0x04 | 64B | D3DMATERIAL8 struct (diffuse/ambient/specular/emissive) |
| +0x12 | DWORD | Material index (0 = no material, else ptr to material data) |
| +0x13 | byte | Fillmode/blend flag |
| +0x1C | byte | Blend flags |
| +0x1D | byte | Alpha flag |
| +0x4D | byte | Has alpha test flag |

## Related Functions

| Function | Address | Purpose |
|---|---|---|
| Graphics_ApplyMaterialAndDraw | 0x455110 | Per-meshbuffer draw (material + texture + transform + draw) |
| Level_SetObjectTransform | 0x40B9C0 | Copy 4x4 world matrix to gfx |
| Graphics_ComputeFrustumPlanes | 0x4762B0 | Compute 6 frustum planes from view/projection |
| Graphics_BeginFrame | 0x453B50 | SetTransform(D3DTS_VIEW) + copy view matrix |
| Graphics_SetupLights | 0x454630 | Per-frame render states (SHADEMODE, SPECULARENABLE, CULLMODE) |
| Graphics_RenderScene | 0x454BC0 | Main render loop — re-applies ambient/fog, runs 8 render passes |
| D3DXSkinMesh_CopyStripData | 0x45E0E0 | 4-pass strip sort: opaque → translucent → decal → alpha-test |

## 4-Pass Render Sort (D3DXSkinMesh_CopyStripData, 0x45E0E0)

| Pass | Prefix | Render Mode |
|---|---|---|
| 1 | (none) | Opaque — all flags clear |
| 2 | O: | Translucent — alpha blending enabled |
| 3 | T: | Decal — texture overlay |
| 4 | N:GLASS | Alpha test — D3DRS_ALPHATESTENABLE |

`E:` prefix meshes are skipped entirely (never rendered).
`WANTZ` flag toggles ZENABLE per-mesh in the translucent pass.

## See Also

- `references/ambient-fog-lighting-chain.md` — How ambient/fog colors
  are set per-level from MESHWORLD S4 data
- `the target-meshworld/references/d3d8-rendering-pipeline.md` —
  Higher-level pipeline overview with pass sorting details
