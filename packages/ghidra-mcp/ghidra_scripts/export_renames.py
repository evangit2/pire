# Export all custom-named functions from Ghidra
#@category Export
from ghidra.program.model.symbol import SymbolType
import json

fm = currentProgram.getFunctionManager()

renames = []
for func in fm.getFunctions(True):
    name = func.getName()
    if not name.startswith("FUN_"):
        addr = func.getEntryPoint()
        renames.append({"address": str(addr), "name": name})

output = json.dumps({"renames": renames, "count": len(renames), "timestamp": "2026-04-14"}, indent=2)

outFile = "/home/evan/hamsterball-re/analysis/ghidra/renames_backup.json"
with open(outFile, "w") as f:
    f.write(output)

print("Exported %d renames to %s" % (len(renames), outFile))