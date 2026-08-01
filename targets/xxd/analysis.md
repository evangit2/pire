# Analysis of xxd.exe

## Binary Info
- **Type**: PE32+ executable (console) x86-64, for MS Windows
- **Version**: xxd 2022-01-14 by Juergen Weigert et al. (2024-08-06 standalone-port ckormanyos) (Win32)
- **PDB**: D:\a\xxd\xxd\x64\Release\xxd.pdb
- **Functions**: Uses standard C runtime (fopen, fseek, ftell, fgetc, fputc, etc.)

## Overview
This is a Windows port of the classic `xxd` hex dump utility. It converts binary files to hex dumps and vice versa.

## Command Line Options
```
Usage:
       xxd.exe [options] [infile [outfile]]
    or
       xxd.exe -r [-s [-]offset] [-c cols] [-ps] [infile [outfile]]
Options:
    -a          toggle autoskip: A single '*' replaces nul-lines. Default off.
    -b          binary digit dump (incompatible with -ps,-i,-r). Default hex.
    -C          capitalize variable names in C include file style (-i).
    -c cols     format <cols> octets per line. Default 16 (-i: 12, -ps: 30).
    -E          show characters in EBCDIC. Default ASCII.
    -e          little-endian dump (incompatible with -ps,-i,-r).
    -g bytes    number of octets per group in normal output. Default 2 (-e: 4).
    -h          print this summary.
    -i          output in C include file style.
    -n name     set the variable name used in C include output (-i).
    -l len      stop after <len> octets.
    -o off      add <off> to the displayed file position.
    -ps         output in postscript plain hexdump style.
    -r          reverse operation: convert (or patch) hexdump into binary.
    -r -s off   revert with <off> added to file positions found in hexdump.
    -d          show offset in decimal instead of hex.
    -s [+][-]seek  start at <seek> bytes abs. (or +: rel.) infile offset.
    -u          use upper case hex letters.
    -v          show version.
```

## Output Formats

### 1. Default hex dump (normal mode)
Format: `OFFSET: HEX_BYTES  ASCII`
- Offset: 8 hex digits (or 8 decimal digits with -d), followed by `: `
- Hex bytes: grouped by `-g` (default 2), space between groups
- ASCII section: two spaces before ASCII, printable chars shown, non-printable as `.`
- Line width: `-c` columns (default 16)

### 2. Postscript plain hexdump (-ps)
- Just hex digits, no offset, no ASCII
- Lines wrapped at `-c` bytes (default 30)
- No spaces between hex bytes

### 3. C include file style (-i)
- `unsigned char NAME[] = {` header
- Hex values as `0x##,` separated by spaces, 12 per line (or -c)
- `};` footer
- `unsigned int NAME_len = N;`
- Variable name derived from filename (special chars -> `_`)
- `-C` capitalizes the variable name
- `-n` sets custom variable name

### 4. Binary digit dump (-b)
- Each byte shown as 8 binary digits
- Groups of 4 bytes separated by spaces
- ASCII section after two spaces

## Key Behaviors

### Autoskip (-a)
- Consecutive lines of all zeros (matching column width) are replaced with `*`
- First and last zero lines are always shown
- Only triggers when 2+ consecutive all-zero lines

### Little-endian (-e)
- Bytes within each group are reversed
- Group size must be power of 2 (default 4 with -e)
- Incompatible with -ps, -i, -r

### Seek (-s)
- `+N`: relative seek from current position
- `-N`: seek backwards from end
- `N`: absolute seek from start
- Supports hex (0x) and decimal

### Offset (-o)
- Adds to displayed position (doesn't affect reading)

### Reverse (-r)
- Parses hex dump back to binary
- `-s off`: adds offset to file positions found in hexdump
- Handles `*` (repeated lines) in input
- Output to stdout or outfile
- When outfile specified, patches in place
- `-ps -r`: reads plain hexdump format

### EBCDIC (-E)
- Uses EBCDIC character table for ASCII section instead of ASCII

### Uppercase (-u)
- Uses uppercase hex letters (0X, 0-9, A-F) in format strings

### Decimal offset (-d)
- Shows offset in decimal instead of hex

## Exit Codes
- 0: success (including -h, -v, and some errors like "cannot revert")
- 1: usage errors (invalid columns, invalid group with -e, incompatible options)
- 2: file errors (file not found, seek errors)

## Error Messages
- `nonexistent: No such file or directory` (file not found)
- `xxd.exe: ` (after file error, appears empty)
- `xxd.exe: invalid number of columns (max. 256).` (-c > 256)
- `xxd.exe: number of octets per group must be a power of 2 with -e.`
- `xxd.exe: Sorry, cannot revert this type of hexdump` (-r with -b, -i, or -e)
- `xxd.exe: Sorry, cannot seek backwards.` (-r -s with negative offset)
- `xxd.exe: Sorry, cannot seek.`

## Version String
`xxd 2022-01-14 by Juergen Weigert et al. (2024-08-06 standalone-port ckormanyos) (Win32)`

## EBCDIC Table
The EBCDIC character mapping for bytes 0x00-0xFF:
```
0x00-0x3F: ...................<(+|&.........!$*);~-/,%_>?`:#@'="
0x40-0x7F: abcdefghi........stuvwxyz.{ABCDEFGHI}JKLMNOPQR....STUVWXYZ0123456789
0x80-0xBF: ................abcdefghi.jklmnopqr^.stuvwxyz.{ABCDEFGHI}JKLMNOPQR
0xC0-0xFF: .STUVWXYZ0123456789................
```

## Default Values
- columns: 16 (normal), 12 (-i), 30 (-ps)
- group: 2 (normal), 4 (-e)
- Max columns: 256
- Group must be power of 2 with -e
