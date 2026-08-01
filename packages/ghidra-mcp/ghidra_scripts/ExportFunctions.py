# Ghidra Python script to export function info
# @category Analysis

from ghidra.program.model.listing import FunctionIterator
from ghidra.program.model.symbol import SymbolType
import os

out_dir = os.path.expanduser("~/hamsterball-re/analysis/ghidra/")

# Export function list
func_path = out_dir + "functions.txt"
str_path = out_dir + "strings.txt"

fm = currentProgram.getFunctionManager()

with open(func_path, "w") as f:
    f.write("# Hamsterball.exe Functions\n")
    f.write("# Address\tName\tSize\tPrototype\n")
    count = 0
    for func in fm.getFunctions(True):
        addr = hex(func.getEntryPoint().offset)
        name = func.getName()
        size = func.getBody().getNumAddresses()
        sig = func.getSignature().getPrototypeString()
        f.write(f"{addr}\t{name}\t{size}\t{sig}\n")
        count += 1
        if count > 5000:
            break
    print(f"Exported {count} functions")

# Export strings
listing = currentProgram.getListing()
count = 0
with open(str_path, "w") as f:
    f.write("# Hamsterball.exe Defined Strings\n")
    f.write("# Address\tValue\n")
    for data in listing.getDefinedData(True):
        if data.hasStringValue():
            val = str(data.getValue())
            if len(val) > 2:
                addr = hex(data.getAddress().offset)
                f.write(f"{addr}\t{val}\n")
                count += 1
                if count > 5000:
                    break
    print(f"Exported {count} strings")

print("Done!")