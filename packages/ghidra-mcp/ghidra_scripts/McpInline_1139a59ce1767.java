import ghidra.app.script.GhidraScript;
public class McpInline_1139a59ce1767 extends GhidraScript {
    @Override
    public void run() throws Exception {

import ghidra.app.decompiler.DecompInterface as DecompInterface
import ghidra.program.model.address.AddressFactory as AddressFactory

addr = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(0x00436680)
listing = currentProgram.getListing()

# Try to disassemble
from ghidra.app.cmd.disassemble import DisassembleCommand
cmd = DisassembleCommand(addr, None, True)
cmd.applyTo(currentProgram)

# Now read the instructions
result = []
current = addr
for i in range(32):
    instr = listing.getInstructionAt(current)
    if instr is None:
        data = listing.getDataAt(current)
        if data is not None:
            result.append("0x%s: [data] %s".format(current, data))
            current = current.add(data.getLength())
        else:
            # Read raw byte
            byte_val = currentProgram.getMemory().getByte(current)
            result.append("0x%s: [undefined] 0x%02x".format(current, byte_val & 0xFF))
            current = current.add(1)
    else:
        result.append("0x%s: %s".format(current, instr))
        current = current.add(instr.getLength())
    if current.getOffset() >= 0x004366A0:
        break

print("\n".join(result))

    }
}
