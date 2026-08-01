# cfgmerge.exe Reverse Engineering Analysis

## Binary Info
- **Format**: PE32+ (Windows x86-64), compiled with GCC 13 (MinGW-w64)
- **Type**: Console application, stripped to external PDB
- **Purpose**: INI-style config file manipulation tool

## Commands
```
Usage: cfgmerge <count|get|set|checksum> <file> [args...]
  count <file>              — count sections and keys
  get <file> <key>          — get value for key
  set <file> <key> <value>  — set key value
  checksum <file>           — compute config checksum
```

## Data Structures
- Global section array at 0x14000d060, each section is 0x5044 bytes
- Section struct: name[0x40] at +0x00, key_count (int) at +0x5040, keys at +0x40
- Key struct: name[0x40] at +0x00, value[0x100] at +0x40, total 0x140 bytes per key
- Section count at 0x14000d040
- First section is always "default" (for keys before any [section] header)

## Config File Parsing (fcn.140001577)
1. Open file with fopen(filename, "r")
2. If cannot open: print "ERROR: cannot open %s\n", return -1
3. Initialize section count to 0, first section name = "default"
4. Read lines with fgets(buf, 0x144, file)
5. Trim trailing whitespace (spaces, tabs, \r, \n) from each line (fcn.1400014e4)
6. Skip empty lines and lines starting with '#' (comment)
7. If line starts with '[': find ']', null-terminate, create new section
   - Section name copied via strncpy(dest, name, 0x3f), name[0x3f]=0
   - If section_count <= 0, reuse the "default" section (overwrite it)
   - Otherwise increment section_count
8. If line contains '=': split into key/value at '='
   - Key: everything before '=' (strchr, null-terminate at '=')
   - Value: everything after '='
   - Key name: strncpy(section+0x40+i*0x140, key, 0x3f), key[0x3f]=0
   - Value: strncpy(section+0x80+i*0x140, value, 0xff), value[0xff]=0
   - Increment section's key_count
   - Max 0x3f (63) keys per section
9. On EOF: increment section_count, close file, return 0

## count Command (fcn.140001758)
1. Parse file
2. For each section: print "Section: %s (%d keys)\n" with section name and key count
3. Print "Total: %d sections, %d keys\n" with total sections and sum of all key counts
4. Return 0

## get Command (fcn.1400017e2)
1. Parse file (arg = filename via rcx, key via rdx/rbp)
2. Search all sections in order, all keys within each section
3. Use strcmp(key, stored_key) to find match
4. If found: print "%s\n" with the value, return 0
5. If not found: print "NOT FOUND\n", return 1
6. If file error: return 1

## set Command (fcn.1400018be)
1. Parse file (args: filename, key, value)
2. Search all sections in order for the key (strcmp)
3. If found: 
   - Update value: strncpy(key_entry+0x80, new_value, 0xff), null-terminate at 0xff
   - Reopen file with fopen(filename, "w")
   - If cannot write: print "ERROR: cannot write %s\n", return 1
   - Write all sections: "[%s]\n" for section header, then "%s=%s\n" for each key
   - Close file, print "OK\n", return 0
4. If not found: print "NOT FOUND\n", return 1
5. Note: output removes comments and blank lines; keys without section header get [default]

## checksum Command (fcn.140001aa6)
1. Parse file
2. Initialize: ecx=0 (XOR accumulator), r8=0 (length accumulator)
3. For each section, for each key-value pair:
   - XOR each byte of key name into ecx
   - XOR 0x3d ('=') into ecx
   - XOR each byte of value into ecx
   - XOR 0x0a ('\n') into ecx
   - r8 += len(key) + len(value) + 2
4. Result = (ecx + r8) & 0xFF
5. Print "%02X\n"
6. Return 0
7. Section names do NOT affect the checksum

## Main Dispatch (fcn.140001be1)
1. If argc <= 2: print usage, return 2
2. Compare argv[1] with "count", "get", "set", "checksum" (strcmp)
3. "count": call count handler with argv[2]
4. "get": if argc <= 3, print "ERROR: get requires a key\n", return 1; else call get with file, argv[3]
5. "set": if argc <= 4, print "ERROR: set requires key and value\n", return 1; else call set with file, argv[3], argv[4]
6. "checksum": call checksum handler with argv[2]
7. Unknown: print "ERROR: unknown command '%s'\n", return 1

## Exit Codes
- Success: 0
- Key not found (get/set): 1
- File open error: 1
- Missing arguments (get/set): 1
- Unknown command: 1
- No/insufficient arguments (usage): 2

## Trim Function (fcn.1400014e4)
- Removes trailing whitespace characters (bytes <= 0x20 that are in the bitmask 0x100002600)
- Bitmask 0x100002600 covers: 0x09 (\t), 0x0a (\n), 0x0d (\r), 0x20 (space), and bit 41 (0x8000000000 territory but within the mask)
- Actually the mask 0x100002600 = bits 9,10,13,41. Bits 9=\t, 10=\n, 13=\r. Bit 41 is unusual.
- In practice: trims \t, \n, \r, space from end of string
- Also skips leading whitespace (similar check at start of string)
