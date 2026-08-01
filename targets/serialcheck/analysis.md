# serialcheck.exe Reverse Engineering Analysis

## Binary Overview
- **Format**: PE32+ (x86-64) Windows console executable
- **Compiler**: GCC 13 (Mingw-w64)
- **Purpose**: Validates serial keys in format `XXXX-XXXX-XXXX-XXXX`

## Usage
```
serialcheck <key>
  key format: XXXX-XXXX-XXXX-XXXX
```
Each group is 4 hex characters representing 2 bytes. Groups are separated by `-`.

## Algorithm

### Entry Point (0x140007f50)
- If argc != 2, prints usage and returns 2.
- Otherwise calls the validation function at 0x1400016b0 with argv[1].

### Validation Function (0x1400016b0)

#### 1. Length Check
- `strlen(key)` must equal 19 (0x13).
- If not → "INVALID: wrong length"

#### 2. Format Check
- Characters at positions 4, 9, 14 must be `-` (0x2d).
- If not → "INVALID: bad format"

#### 3. Hex Parsing (0x140001590)
- Each group of 4 hex chars is parsed into 2 bytes.
- Accepts 0-9, A-F, a-f.
- Returns 0 (failure) if any character is not valid hex.
- On failure → "INVALID: group N not hex" (for groups 1-4)

Parsed bytes are stored on stack:
- Group 1: `[rsp+0x20]`, `[rsp+0x21]` (g1[0], g1[1])
- Group 2: `[rsp+0x22]`, `[rsp+0x23]` (g2[0], g2[1])
- Group 3: `[rsp+0x24]`, `[rsp+0x25]` (g3[0], g3[1])
- Group 4: `[rsp+0x26]`, `[rsp+0x27]` (g4[0], g4[1])

#### 4. Group 1 Checksum
- `g1[0] XOR g1[1]` must equal `0xA5`.
- If not → "INVALID: group 1 checksum failed"

#### 5. Group 2 Checksum
- `g2[0] + g2[1]` (mod 256) must equal `0x3C`.
- If not → "INVALID: group 2 checksum failed"

#### 6. Group 3 = Bitwise Reverse of Group 1
- `g3[0]` must equal `bit_reverse(g1[0])`
- `g3[1]` must equal `bit_reverse(g1[1])`
- Bit reverse: for each byte, reverse all 8 bits (MSB↔LSB).
- If either fails → "INVALID: group 3 must be bitwise reverse of group 1"

The bit_reverse operation (at 0x140001786 and 0x1400017b2):
```
result = 0
for i in 0..7:
    result = (result << 1) | (input & 1)
    input >>= 1
```

#### 7. CRC Check
- CRC-8 is computed over 6 bytes: `[g1[0], g1[1], g2[0], g2[1], g3[0], g3[1]]`
- The computed CRC must equal `g4[0]`.
- If not → "INVALID: CRC mismatch (expected XX, got YY)" where expected=computed, got=g4[0]

The CRC algorithm (at 0x140001808):
```
crc = 0
for byte in data:
    crc ^= byte
    for _ in 0..7:
        if crc & 0x80:
            crc = ((crc << 1) ^ 0x07) & 0xFF
        else:
            crc = (crc << 1) & 0xFF
```
This is CRC-8 with polynomial 0x07, initial value 0x00, no reflection, no final XOR.

#### 8. Group 4 Suffix
- `g4[1]` must equal `0x00`.
- If not → "INVALID: group 4 suffix must be 00"

#### 9. Valid
- If all checks pass → "VALID"

## Return Values
- VALID: returns 0
- Any INVALID: returns 1
- No argument (usage): returns 2

## Valid Key Example
`A500-003C-A500-1800`
- g1 = [0xA5, 0x00], XOR = 0xA5 ✓
- g2 = [0x00, 0x3C], sum = 0x3C ✓
- g3 = [0xA5, 0x00] = bit_reverse of g1 ✓ (0xA5 = 10100101, reversed = 10100101)
- CRC8([0xA5, 0x00, 0x00, 0x3C, 0xA5, 0x00]) = 0x18 = g4[0] ✓
- g4[1] = 0x00 ✓
