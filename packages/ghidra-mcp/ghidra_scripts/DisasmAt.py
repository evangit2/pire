# Ghidra Jython script
target = 0x49A4EA
af = currentProgram.getAddressFactory()
space = af.getDefaultAddressSpace()
startAddr = space.getAddress(target - 0x60)
endAddr = space.getAddress(target + 0x20)
crashAddr = space.getAddress(target)

listing = currentProgram.getListing()
fm = currentProgram.getFunctionManager()

# Check function at crash addr
f = fm.getFunctionContaining(crashAddr)
if f is not None:
    print("Function at crash: %s @ %s" % (f.getName(), f.getEntryPoint()))
else:
    print("No function at crash addr 0x49A4EA")
    # Find closest function before
    funcs = fm.getFunctions(True)
    prev = None
    for fn in funcs:
        ep = fn.getEntryPoint().getOffset()
        if ep <= target:
            prev = fn
        elif ep > target:
            break
    if prev is not None:
        endAddrFunc = prev.getBody().getMaxAddress()
        print("Closest func before: %s @ %s (end=%s)" % (prev.getName(), prev.getEntryPoint(), endAddrFunc))

# Print instructions
inst = listing.getInstructionAt(startAddr)
if inst is None:
    inst = listing.getInstructionAfter(startAddr)

count = 0
while inst is not None and inst.getAddress().compareTo(endAddr) <= 0 and count < 50:
    off = inst.getAddress().getOffset()
    marker = " <<< CRASH" if off == target else ""
    print("  %s  %s%s" % (inst.getAddress(), inst.toString(), marker))
    inst = inst.getNext()
    count += 1
