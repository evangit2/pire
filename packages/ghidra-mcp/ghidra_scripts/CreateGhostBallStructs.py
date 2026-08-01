# Ghidra Python script to create BallSnapshot and BestTimeTracker structs
# @category Hamsterball
# @author Hamsterbot

from ghidra.program.model.data import StructureDataType, ByteDataType, FloatDataType, PointerDataType, IntegerDataType, Undefined4DataType, CategoryPath

dtm = currentProgram.getDataTypeManager()
cat = CategoryPath("/Hamsterball")

# BallSnapshot struct - 0x28 (40) bytes
# Per-frame snapshot of ball state, stored in BestTimeTracker recording
ballSnapshot = StructureDataType(cat, "BallSnapshot", 0)
ballSnapshot.add(FloatDataType.dataType, 4, "pos_x", "Ball position X (from ball+0x164)")
ballSnapshot.add(FloatDataType.dataType, 4, "pos_y", "Ball position Y (from ball+0x168)")
ballSnapshot.add(FloatDataType.dataType, 4, "pos_z", "Ball position Z (from ball+0x16C)")
ballSnapshot.add(FloatDataType.dataType, 4, "vel_x", "Velocity X (from ball+0x190)")
ballSnapshot.add(FloatDataType.dataType, 4, "vel_y", "Velocity Y (from ball+0x194)")
ballSnapshot.add(FloatDataType.dataType, 4, "rotation", "Rotation (from ball+0x150)")
ballSnapshot.add(ByteDataType.dataType, 1, "state_flag", "Ball state flag (from ball+0x748)")
ballSnapshot.add(ByteDataType.dataType, 3, "pad", "Padding to align next float")
ballSnapshot.add(FloatDataType.dataType, 4, "rot_x", "Rotation X (from ball+0x74C)")
ballSnapshot.add(FloatDataType.dataType, 4, "rot_y", "Rotation Y (from ball+0x750)")
ballSnapshot.add(FloatDataType.dataType, 4, "rot_z", "Radius (from ball+0x284)")
dtm.addDataType(ballSnapshot, None)

# BestTimeTracker struct - 0x528 bytes
# Stores per-frame BallSnapshot recordings for Time Trial ghost system
bestTimeTracker = StructureDataType(cat, "BestTimeTracker", 0x528)
bestTimeTracker.add(PointerDataType.dataType, 4, "vtable", "Virtual function table pointer")
bestTimeTracker.add(IntegerDataType.dataType, 4, "list_count", "AthenaList item count")
bestTimeTracker.add(IntegerDataType.dataType, 4, "list_field_8", "AthenaList field (capacity?)")
# Skip to 0x408 - this is mostly AthenaList internal storage (256 entries * 4 bytes)
# 0x0C to 0x408 = 0x3FC bytes = 255 dwords of AthenaList array storage
# We'll leave as undefined - too much padding to add field-by-field
bestTimeTracker.add(IntegerDataType.dataType, 4, "iterator_counter", "Iterator counter (wraps 1-255)")
# 0x40C
bestTimeTracker.add(IntegerDataType.dataType, 4, "pad_40c", "")
bestTimeTracker.add(PointerDataType.dataType, 4, "list_array", "Pointer to array of BallSnapshot* pointers")
# 0x414 to 0x41C
bestTimeTracker.add(IntegerDataType.dataType, 4, "pad_414", "")
bestTimeTracker.add(IntegerDataType.dataType, 4, "pad_418", "")
bestTimeTracker.add(IntegerDataType.dataType, 4, "playback_index", "Current playback frame index")
bestTimeTracker.add(IntegerDataType.dataType, 4, "race_time", "Race time at recording")
# 0x424 to 0x524 = 0x100 bytes padding
bestTimeTracker.add(IntegerDataType.dataType, 4, "finish_time", "Finish time from N:GOAL collision (written in DispatchCollisionEvents)")
# Remaining is padding to 0x528
dtm.addDataType(bestTimeTracker, None)

print("Created BallSnapshot (%d bytes / 0x%x) and BestTimeTracker (%d bytes / 0x%x)" % (
    ballSnapshot.getLength(), ballSnapshot.getLength(),
    bestTimeTracker.getLength(), bestTimeTracker.getLength()
))
