import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import java.io.FileWriter;
import java.io.File;
public class DecompileMultiAddresses extends ghidra.app.script.GhidraScript {
    public void run() throws Exception {
        if(getScriptArgs().length < 1) {
            println("Usage: addr1:out1,addr2:out2,...");
            return;
        }
        DecompInterface decomp = new DecompInterface();
        DecompileOptions opts = new DecompileOptions();
        decomp.setOptions(opts);
        decomp.openProgram(currentProgram);
        String[] pairs = getScriptArgs()[0].split(",");
        for(String pair : pairs) {
            String[] kv = pair.split(":");
            if(kv.length != 2) continue;
            String addrStr = kv[0].replace("0x","");
            String outPath = kv[1];
            long offset = Long.parseLong(addrStr, 16);
            Address addr = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
            Function func = currentProgram.getFunctionManager().getFunctionContaining(addr);
            if(func == null) func = currentProgram.getFunctionManager().getFunctionAt(addr);
            if(func == null) {
                println("ERROR: No function at " + addrStr);
                FileWriter fw = new FileWriter(outPath);
                fw.write("/* No function found at 0x" + addrStr + " */\n");
                fw.close();
                continue;
            }
            DecompileResults results = decomp.decompileFunction(func, 300, null);
            if(results == null || results.getDecompiledFunction() == null) {
                println("ERROR: Decompilation failed for " + addrStr);
                continue;
            }
            String c = results.getDecompiledFunction().getC();
            FileWriter fw = new FileWriter(outPath);
            fw.write("/* " + func.getName() + " @ 0x" + addrStr + " */\n\n");
            fw.write(c);
            fw.close();
            println("OK: " + addrStr + " -> " + outPath);
        }
        decomp.dispose();
    }
}
