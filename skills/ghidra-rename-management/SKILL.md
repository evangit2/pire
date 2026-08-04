---
name: ghidra-rename-management
description: "Backup, export, and restore Ghidra function/label renames to/from JSON or FUNCTION_MAP.md in the git repo."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [ghidra, reverse-engineering, backup, rename, mcp]
---

# Ghidra Rename Management

Persist Ghidra renames outside the project DB by exporting to JSON / FUNCTION_MAP.md and restoring after DB loss or re-import.

## Why This Matters

The Ghidra project DB (`.rep/` directory) is NOT version controlled. If it gets corrupted or re-imported, ALL renames are LOST unless exported to git. This happened in April 2026 and cost ~14% documentation progress (75.5% → 61%).

## Source of Truth

`~/the target-re/docs/FUNCTION_MAP.md` — the authoritative list of all renamed functions.
Format: `| 0x004XXXXX | FunctionName | Description |`

---

## Export Renames

### Primary: Parse FUNCTION_MAP.md

FUNCTION_MAP.md is always up to date. Parse it directly:

```bash
cd ~/the target-re && python3 -c "
import json, re
renames = []
with open('docs/FUNCTION_MAP.md', 'r') as f:
    for line in f:
        m = re.match(r'\|\s*(0x[0-9a-fA-F]+)\s*\|\s*(\S+.*?)\s*\|', line.strip())
        if m:
            addr, name = m.group(1), m.group(2).strip()
            if name not in ('Address', '---', '---------', 'Name'):
                renames.append({'address': addr, 'name': name})
with open('analysis/ghidra/renames_backup.json', 'w') as f:
    json.dump({'renames': renames, 'count': len(renames), 'timestamp': '2026-04-14', 'source': 'FUNCTION_MAP.md'}, f, indent=2)
print(f'Exported {len(renames)} function entries')
"
```

### Fallback: MCP pagination (slow, capped at 100/page)

```
list_functions_enhanced offset=0 limit=100 → save
list_functions_enhanced offset=100 limit=100 → append
...
```

### Inline scripts are BROKEN in headless mode

`run_script_inline` fails with `GhidraScriptLoadException: BundleHost.getBundleFiles() is null`. Python scripts also unavailable (no PyGhidra). Only `*.java` scripts can run if the BundleHost issue is resolved. Use MCP tools instead.

---

## Restore Renames

### Proven process (tested Apr 2026)

**Step 1:** Start GhidraMCP headless server (see `ghidra-mcp-headless` skill).

**Step 2:** Run the restore script:

```bash
cd ~/the target-re && python3 analysis/ghidra/apply_renames.py
```

The script:
1. Parses FUNCTION_MAP.md for address+name pairs via regex `\|\s*0x([0-9A-Fa-f]+)\s*\|\s*(\w+)\s*\|`
2. Sends batches of 50 to `http://127.0.0.1:8089/batch_create_labels`
3. Reports progress per batch

Results from Apr 2026: 840/841 labels created, 0 failed. 40% → 61% documented.

**Step 3:** Verify

```bash
curl -s http://127.0.0.1:8089/compare_programs_documentation
```

### Address format

- FUNCTION_MAP.md uses `0x` prefix (e.g., `0x00412345`)
- REST API wants raw hex (e.g., `00412345`)

### Names to skip

`Catch@`, `Unwind@`, `operator_`, `thunk_`, `entry`, `Start`, auto-named BASS/D3D/DInput IAT thunks.

---

## Additional Sources

- `~/the target-re/docs/KEY_FINDINGS.md` — key address references
- `~/the target-re/docs/STRUCTS_AND_TYPES.md` — struct definitions
- `~/the target-re/analysis/ghidra/renames_backup.json` — last backup export

---

## Quick Reference

| Action | Command |
|--------|---------|
| Export renames | Parse FUNCTION_MAP.md → JSON backup |
| Restore renames | Run `apply_renames.py` against FUNCTION_MAP.md |
| Verify count | `compare_programs_documentation` MCP endpoint |
| Commit to git | `git add analysis/ghidra/renames_backup.json docs/FUNCTION_MAP.md && git commit -m "backup renames"` |

## Portable Package for Sharing

When another person needs your renames + scripts + extensions on their Windows Ghidra instance, bundle everything into a single zip with Windows-friendly install scripts.

### What to include

| Item | Source | Purpose |
|------|--------|---------|
| `renames_backup.json` | Parsed from FUNCTION_MAP.md | 1,300+ function names to apply |
| `extensions/` | `~/.config/ghidra/*/Extensions/GhidraMCP/` | GhidraMCP plugin JAR + metadata |
| `scripts/` | Repo + `~/ghidra_scripts/` | Java/Python helper scripts |
| `structs/` | `analysis/ghidra/structs/*.h` | C struct definitions for import |
| `install.bat` + `install.ps1` | Generated per-package | Auto-detect Ghdira, copy files |
| `README.md` | Generated per-package | Step-by-step install guide |

### Key script: `apply_renames.py` (Ghidra-internal)

This version runs **inside** Ghidra (not via MCP). It reads `renames_backup.json` and uses Ghidra's SymbolTable API directly:

```python
# In Ghidra Script Manager, run as Python script
from ghidra.program.model.symbol import SourceType
import json, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RENAME_FILE = os.path.join(os.path.dirname(SCRIPT_DIR), "renames_backup.json")

with open(RENAME_FILE) as f:
    renames = json.load(f).get("renames", [])

program = currentProgram
sym_tab = program.getSymbolTable()
base = program.getMinAddress()
created = skipped = failed = 0

for entry in renames:
    addr_str = entry.get("address", "").strip().upper().replace("0X", "")
    name = entry.get("name", "")
    if not addr_str or not name:
        skipped += 1; continue
    try:
        addr_val = int(addr_str, 16)
        addr = base.getAddress(addr_val)
    except Exception:
        skipped += 1; continue
    sym = sym_tab.getPrimarySymbol(addr)
    if sym:
        sym.setName(name, SourceType.USER_DEFINED); created += 1
    else:
        sym_tab.createLabel(addr, name, SourceType.USER_DEFINED); created += 1

print(f"Done: {created} renamed/created, {skipped} skipped, {failed} failed")
```

Template saved at: `templates/ghidra-portable-apply-renames.py`

### Packaging command

```bash
cd /tmp && mkdir -p ghidra-config-package/{extensions,scripts,structs,install}
cp renames_backup.json ghidra-config-package/
cp ~/.config/ghidra/*/Extensions/GhidraMCP/lib/GhidraMCP-*.jar extensions/
cp scripts/*.py scripts/*.java ghidra-config-package/scripts/
cp structs/*.h ghidra-config-package/structs/
# write README.md, install.bat, install.ps1
cd /tmp && zip -r ghidra-config-package.zip ghidra-config-package/
tmpcli up ghidra-config-package.zip
```

### Install script behavior (`install.bat`)

1. Auto-detects Ghidra in `%LOCALAPPDATA%\Programs`, `C:\Program Files`, or `C:\Tools`
2. Copies GhidraMCP extension into `Ghidra/<version>/Extensions/`
3. Copies scripts + structs + renames into `%LOCALAPPDATA%\Ghidra\<version>\`
4. Prints next steps (restart Ghidra → Script Manager → add script dir → run apply_renames.py)

## Note on Absorbed Skills

The following skills have been consolidated into this umbrella:
- `ghidra-rename-backup` — backup/restore via JSON → covered by **Export** and **Restore** sections
- `ghidra-rename-export` — post-session export → covered by **Export** section
- `ghidra-restore-renames` — restore from FUNCTION_MAP.md → covered by **Restore** section

## Rename Sync Checklist

When renaming a function in Ghidra, ALL of these locations must be updated (not just Ghidra):

1. Ghidra project DB (via `rename_function` MCP tool)
2. `docs/decompilation/FUNCTION_MAP.md`
3. `analysis/ghidra/renames_backup.json`
4. `analysis/ghidra/decompilations/batch_auto/` — rename the `.c` file to match
5. `hbremap/index.html` AND `hbremap/cosmoscope.html` — both have full function tables
6. `hbremap/content/` — **mirror copies of ALL docs/**, not just FUNCTION_MAP. When renaming, `sed` the entire directory: `sed -i 's/OldName/NewName/g' hbremap/content/*.md`
7. Any other docs referencing the function — use `grep -rn OldName repo/` to find them all
8. `analysis/ghidra/decompilations/batch_auto/` `.c` files whose **filename** contains the old function name — rename the files too (`git mv`)
9. Save Ghidra program (`save_program` MCP tool)
10. Commit and push to all remotes

**Bulk rename pattern** (for renaming many functions at once across all repo files):
```bash
cd ~/the target-re && sed -i \
  -e 's/OldName1/NewName1/g' \
  -e 's/OldName2/NewName2/g' \
  $(grep -rl 'OldName1\|OldName2' --include='*.{md,json,c,cpp,h,py,txt,html}' .)
```
Then verify zero stale references: `grep -rn 'OldName' --include='*.{md,json,c,cpp,h,py,txt,html}' . | grep -v '.git/'`
Ghidra's internal `.gbf`/`.ps` project DB files will still contain old names in binary cache — these self-update on next decompile, safe to ignore.

**Pitfall**: When writing ad-hoc verification scripts that grep markdown table rows, use `grep -F` (fixed-string) not regex — the `|` pipe characters in markdown tables are regex alternation operators and cause false failures.

- `ghidra-mcp-headless` — Starting the GhidraMCP server (required before any MCP-based restore)
- `game-reverse-engineering` — General RE methodology
- `the target-re` — Project-specific findings and addresses
