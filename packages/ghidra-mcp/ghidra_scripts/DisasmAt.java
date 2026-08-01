import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.listing.FunctionIterator;

public class DisasmAt extends GhidraScript {
    @Override
    public void run() throws Exception {
        long target = 0x49A4EA;
        Address start = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(target - 0x40);
        Address end = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(target + 0x40);
        
        Listing listing = currentProgram.getListing();
        Memory mem = currentProgram.getMemory();
        FunctionManager fm = currentProgram.getFunctionManager();
        
        // Print instructions around crash address
        Instruction inst = listing.getInstructionAt(start);
        if (inst == null) {
            inst = listing.getInstructionAfter(start);
        }
        int count = 0;
        while (inst != null && inst.getAddress().compareTo(end) <= 0 && count < 40) {
            String marker = inst.getAddress().getOffset() == target ? " <<< CRASH HERE" : "";
            println("  " + inst.getAddress() + "  " + inst.toString() + marker);
            inst = inst.getNext();
            count++;
        }
        
        // Check if there's a function at crash addr
        Address crashAddr = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(target);
        Function f = fm.getFunctionContaining(crashAddr);
        if (f != null) {
            println("Function containing crash addr: " + f.getName() + " @ " + f.getEntryPoint());
        } else {
            println("No function at crash addr 0x49A4EA");
            // Find closest function before by iterating
            FunctionIterator fi = fm.getFunctions(start);
            Function prevFunc = null;
            while (fi.hasNext()) {
                Function fn = fi.next();
                if (fn.getEntryPoint().getOffset() <= target) {
                    prevFunc = fn;
                } else {
                    break;
                }
            }
            if (prevFunc != null) {
                println("Closest function before: " + prevFunc.getName() + " @ " + prevFunc.getEntryPoint() + " (size=" + prevFunc.getBody().getNumAddresses() + ")");
            }
        }
        
        // Raw bytes
        byte[] bytes = new byte[16];
        mem.getBytes(crashAddr, bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02X ", b));
        println("Raw bytes at 0x49A4EA: " + hex.toString());
    }
}
