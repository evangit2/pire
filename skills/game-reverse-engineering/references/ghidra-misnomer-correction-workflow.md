# Ghidra Function Misnomer Correction Workflow

When you discover a Ghidra auto-generated or wrongly-named function (e.g., `SceneObj_SetScale` that actually sets alpha, not scale), follow this sequence:

## Steps

1. **Verify the misnomer** — decompile the function and confirm the name doesn't match behavior. Check all parameters and what they actually control (e.g., X/Y/Z=1.0 + W=param means W is alpha, not scale).
2. **Rename in Ghidra** — use `rename_function_by_address` with the corrected name.
3. **Set plate comments** — use `set_plate_comment` on the function AND all callers/readers of the affected fields. Document what the fields actually do, the correction history, and the verification method.
4. **Save the Ghidra program** — `save_program` to persist renames + comments.
5. **Bulk-update all docs and source** — use sed or a script to replace old names across ALL repo files AND skill reference files. Key patterns:
   - Simple: `sed -i -e 's/old_name/new_name/g' file1 file2 ...`
   - Careful (old_name is substring of valid names): `sed -i -e 's/render_scale\([^_]\)/alpha\1/g'` to avoid touching `render_scale_x/y/z`
   - **ALWAYS** run a verification script afterward to catch: dangling references (old #define name used in code body but not replaced), double replacements, broken syntax
6. **Update FUNCTION_MAP.md** — add the new name to the repo's function map so it survives Ghidra DB loss.
7. **Commit + push to both remotes** — origin (public) + priv (private).
8. **Update skill-index.md** — add a one-line pointer to any new/updated reference files.

## Pitfalls

### sed replacing #define but missing usages
When you sed-replace `#define OLD_NAME` to `#define NEW_NAME`, sed only hits the definition line. All code body references like `*(float*)(b + OLD_NAME)` remain dangling. Always use `replace_all=true` in patch or `sed` with `g` flag, then verify with a script that greps for the old name.

### Pre-existing syntax issues
Before claiming a rename "broke" a file, check the original via `git show HEAD~1:file` — the issue may pre-date your changes. Document this in verification output.

### Verification script checklist
For each changed file, verify:
- No dangling old #define names in code body
- New #define is actually used (not just defined)
- No double replacements (e.g., "alphaalpha")
- Brace balance correct
- Paren balance correct (compare to original via git show)
- Only expected lines changed (git diff line count)

## Real Example (June 2026)

**SceneObj_SetScale → SceneObj_SetAlpha (0x4011C0)**

Ghidra auto-named this function `SceneObj_SetScale`. Decompilation revealed it calls `Matrix_Scale4x4(buf, 1.0, 1.0, 1.0, param_1)` — X/Y/Z are all 1.0, param_1 goes into the W-component which controls alpha blending in D3D8, NOT geometric vertex scale. The ball FADES IN during respawn (alpha 0→1), it never changes size.

Renamed to `SceneObj_SetAlpha`, set plate comments on 6 functions, bulk-replaced "render_scale" → "alpha" and "is_falling" → "is_stunned" across 18 repo files + 15 skill files. Also renamed `FUN_00403dc0` → `Ball_RenderAI` (star-circling render effect).
