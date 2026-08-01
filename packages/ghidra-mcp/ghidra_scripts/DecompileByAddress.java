import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import java.io.FileWriter;
import java.io.IOException;
public class DecompileByAddress extends ghidra.app.script.GhidraScript {
    public void run() throws Exception {
        if(getScriptArgs().length < 2) {
            println("Usage: addr=46EC30 out=/tmp/decomp.c");
            return;
        }
        String addrStr = getScriptArgs()[0].replace("0x","");
        String outPath = getScriptArgs()[1];
        long offset = Long.parseLong(addrStr, 16);
        Address addr = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
        Function func = currentProgram.getFunctionManager().getFunctionContaining(addr);
        if(func == null) {
            func = currentProgram.getFunctionManager().getFunctionAt(addr);
        }
        if(func == null) {
            println("ERROR: No function at " + addrStr);
            FileWriter fw = new FileWriter(outPath);
            fw.write("/* No function found at 0x" + addrStr + " */\n");
            fw.close();
            return;
        }
        DecompInterface decomp = new DecompInterface();
        DecompileOptions opts = new DecompileOptions();
        decomp.setOptions(opts);
        decomp.openProgram(currentProgram);
        DecompileResults results = decomp.decompileFunction(func, 300, null);
        if(results == null || results.getDecompiledFunction() == null) {
            println("ERROR: Decompilation failed for " + addrStr);
            FileWriter fw = new FileWriter(outPath);
            fw.write("/* Decompilation failed at 0x" + addrStr + " */\n");
            fw.close();
            return;
        }
        String c = results.getDecompiledFunction().getC();
        FileWriter fw = new FileWriter(outPath);
        fw.write("/*" + func.getName() + " @ 0x" + addrStr + " */\n\n");
        fw.write(c);
        fw.close();
        println("OK: " + addrStr + " -> " + outPath);
    }
}
