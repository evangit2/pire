// Ghidra Java script to create BallSnapshot and BestTimeTracker structs
// @category Hamsterball
// @author Hamsterbot

import ghidra.program.model.data.StructureDataType;
import ghidra.program.model.data.ByteDataType;
import ghidra.program.model.data.FloatDataType;
import ghidra.program.model.data.PointerDataType;
import ghidra.program.model.data.IntegerDataType;
import ghidra.program.model.data.Undefined4DataType;
import ghidra.program.model.data.CategoryPath;
import ghidra.program.model.data.DataTypeManager;

public class CreateGhostBallStructs extends ghidra.app.script.GhidraScript {
    @Override
    public void run() throws Exception {
        DataTypeManager dtm = currentProgram.getDataTypeManager();
        CategoryPath cat = new CategoryPath("/Hamsterball");

        // BallSnapshot struct - 0x28 (40) bytes
        StructureDataType ballSnapshot = new StructureDataType(cat, "BallSnapshot", 0);
        ballSnapshot.add(FloatDataType.dataType, 4, "pos_x", "Ball position X (from ball+0x164)");
        ballSnapshot.add(FloatDataType.dataType, 4, "pos_y", "Ball position Y (from ball+0x168)");
        ballSnapshot.add(FloatDataType.dataType, 4, "pos_z", "Ball position Z (from ball+0x16C)");
        ballSnapshot.add(FloatDataType.dataType, 4, "vel_x", "Velocity X (from ball+0x190)");
        ballSnapshot.add(FloatDataType.dataType, 4, "vel_y", "Velocity Y (from ball+0x194)");
        ballSnapshot.add(FloatDataType.dataType, 4, "rotation", "Rotation (from ball+0x150)");
        ballSnapshot.add(ByteDataType.dataType, 1, "state_flag", "Ball state flag (from ball+0x748)");
        ballSnapshot.add(ByteDataType.dataType, 3, "pad", "Padding to align next float");
        ballSnapshot.add(FloatDataType.dataType, 4, "rot_x", "Rotation X (from ball+0x74C)");
        ballSnapshot.add(FloatDataType.dataType, 4, "rot_y", "Rotation Y (from ball+0x750)");
        ballSnapshot.add(FloatDataType.dataType, 4, "rot_z", "Radius (from ball+0x284)");
        dtm.addDataType(ballSnapshot, null);

        // BestTimeTracker struct - 0x528 bytes
        StructureDataType bestTimeTracker = new StructureDataType(cat, "BestTimeTracker", 0x528);
        bestTimeTracker.add(PointerDataType.dataType, 4, "vtable", "Virtual function table pointer");
        bestTimeTracker.add(IntegerDataType.dataType, 4, "list_count", "AthenaList item count");
        bestTimeTracker.add(IntegerDataType.dataType, 4, "list_field_8", "AthenaList field (capacity?)");
        // 0x0C to 0x408 = AthenaList internal storage (undefined)
        bestTimeTracker.add(IntegerDataType.dataType, 4, "iterator_counter", "Iterator counter at +0x408 (wraps 1-255)");
        bestTimeTracker.add(IntegerDataType.dataType, 4, "pad_40c", "");
        bestTimeTracker.add(PointerDataType.dataType, 4, "list_array", "Pointer to array of BallSnapshot* at +0x410");
        bestTimeTracker.add(IntegerDataType.dataType, 4, "pad_414", "");
        bestTimeTracker.add(IntegerDataType.dataType, 4, "pad_418", "");
        bestTimeTracker.add(IntegerDataType.dataType, 4, "playback_index", "Current playback frame index at +0x41C");
        bestTimeTracker.add(IntegerDataType.dataType, 4, "race_time", "Race time at recording at +0x420");
        // 0x424 to 0x524 = padding
        bestTimeTracker.add(IntegerDataType.dataType, 4, "finish_time", "Finish time from N:GOAL at +0x524");
        dtm.addDataType(bestTimeTracker, null);

        println("Created BallSnapshot (" + ballSnapshot.getLength() + " bytes / 0x" + Integer.toHexString(ballSnapshot.getLength()) + ")");
        println("Created BestTimeTracker (" + bestTimeTracker.getLength() + " bytes / 0x" + Integer.toHexString(bestTimeTracker.getLength()) + ")");
    }
}
