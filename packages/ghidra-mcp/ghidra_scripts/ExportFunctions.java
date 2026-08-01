// Ghidra script to export function list and string references
//@category Analysis
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.*;
import java.io.*;

public class ExportFunctions extends GhidraScript {
    @Override
    public void run() throws Exception {
        String outDir = System.getProperty("user.home") + "/hamsterball-re/analysis/ghidra/";
        
        // Export function list
        PrintWriter funcWriter = new PrintWriter(new FileWriter(outDir + "functions.txt"));
        funcWriter.println("# Hamsterball.exe Functions");
        funcWriter.println("# Address\tName\tSize\tPrototype");
        
        FunctionManager fm = currentProgram.getFunctionManager();
        FunctionIterator iter = fm.getFunctions(true);
        int count = 0;
        while (iter.hasNext() && count < 5000) {
            Function f = iter.next();
            funcWriter.printf("0x%08X\t%s\t%d\t%s\n",
                f.getEntryPoint().offset,
                f.getName(),
                f.getBody().getNumAddresses(),
                f.getSignature().getPrototypeString()
            );
            count++;
        }
        funcWriter.close();
        println("Exported " + count + " functions to functions.txt");
        
        // Export string references
        PrintWriter strWriter = new PrintWriter(new FileWriter(outDir + "strings.txt"));
        strWriter.println("# Hamsterball.exe Defined Strings");
        strWriter.println("# Address\tValue");
        
        DataIterator dataIter = currentProgram.getListing().getDefinedData(true);
        count = 0;
        while (dataIter.hasNext() && count < 5000) {
            Data d = dataIter.next();
            if (d.hasStringValue()) {
                String val = d.getValue().toString();
                if (val.length() > 2) {
                    strWriter.printf("0x%08X\t%s\n", d.getAddress().offset, 
                        val.replace("\n", "\\n").replace("\t", "\\t"));
                    count++;
                }
            }
        }
        strWriter.close();
        println("Exported " + count + " strings to strings.txt");
    }
}