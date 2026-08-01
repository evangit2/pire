# Ghidra MCP Function-Not-Found Pitfalls (sess4080)

## Functions Ghidra didn't auto-analyze

Some functions are valid code but Ghidra didn't auto-create a function entry.
Example: 0x437F10 (Catapult vtable[11] state machine) — starts with valid SEH prologue
(64 a1 00 00 00 00 = MOV EAX,FS:[0]) but Ghidra returns "No function found" for
both decompile AND disassemble endpoints.

### Workaround:
1. Use `/read_memory?address=0xADDR&length=N` to read raw bytes
2. Look for SEH prologue (64 a1 00 00 00 00 6a ff 68 XX XX XX 00) to confirm function start
3. Use byte pattern matching to find key offsets:
   - Search for 0x43A0 as 4-byte LE pattern: A0 43 00 00
   - Search for 0x10F0 as 4-byte LE pattern: F0 10 00 00
4. Decode x86 instructions manually from the hex dump
5. For CALL instructions (E8 XX XX XX XX), compute target = address + 5 + rel32

## D8 vs DC FPU opcode distinction

Critical for reading constants correctly:
- **D8 0D <addr32>** = FMUL m32fp — reads **4-byte single-precision float** at address
- **DC 0D <addr32>** = FMUL m64fp — reads **8-byte double-precision** at address
- **D8 1D <addr32>** = FCOMP m32fp — compares with 4-byte float
- **DC 1D <addr32>** = FCOMP m64fp — compares with 8-byte double

Getting these wrong gives garbage values (e.g., reading 0x4CF3F0 as double gives
5.2e-315 when it's actually float 0.5). Always verify by checking if the float vs
double interpretation makes sense in context.

## Identifying double vs float in .rdata

Doubles are 8 bytes; if the second 4 bytes are all zeros (00 00 00 00), it's likely
a double (high mantissa bits = 0). If reading as float gives a reasonable value but
as double gives garbage, it's a float. The opcode prefix (D8 vs DC) is authoritative.

## Manual x86 decode patterns

Common instruction patterns in target application:
- `D9 86 XX XX 00 00` = FLD dword ptr [ESI+0xXXXX]  (load float from struct field)
- `D9 96 XX XX 00 00` = FSTP dword ptr [ESI+0xXXXX] (store float to struct field)
- `D8 0D XX XX XX 00` = FMUL m32fp [0xXXXXXX]      (multiply by float constant)
- `DC 0D XX XX XX 00` = FMUL m64fp [0xXXXXXX]      (multiply by double constant)
- `8B 86 XX XX 00 00` = MOV EAX, [ESI+0xXXXX]      (load DWORD from struct field)
- `C7 86 XX XX 00 00 YY YY YY YY` = MOV [ESI+0xXXXX], imm32  (store immediate)
- `FF 24 85 XX XX XX 00` = JMP [EAX*4+0xXXXXXX]    (switch jump table)
