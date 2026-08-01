# imggen.exe Reverse Engineering Analysis

## Binary Info
- **Format**: PE32+ executable (console) x86-64, Windows
- **Compiler**: GCC 13 (MinGW-w64)
- **Purpose**: Generates BMP images with various patterns (solid, gradient, checker, rect, circle, noise)

## Usage
```
Usage: imggen <command> [args...]
Commands:
  solid    <w> <h> <hex_color> <output.bmp>
  gradient <w> <h> <hex_start> <hex_end> <h|v> <output.bmp>
  checker  <w> <h> <size> <hex_c1> <hex_c2> <output.bmp>
  rect     <w> <h> <x> <y> <rw> <rh> <hex_color> <output.bmp>
  circle   <w> <h> <cx> <cy> <r> <hex_color> <output.bmp>
  noise    <w> <h> <seed> <output.bmp>
```

## BMP File Format
- 24-bit, uncompressed (BI_RGB), bottom-up
- **Header**: 56 bytes total
  - Bytes 0-13: BMP file header (signature='BM', file_size, reserved=0, data_offset=56)
  - Bytes 14-15: Two zero bytes (padding)
  - Bytes 16-55: BITMAPINFOHEADER (40 bytes, header_size=40)
- **Pixel data**: Stored as B,G,R (standard BMP), rows padded to 4-byte boundary
- **Header constants**: x_ppm=2835, y_ppm=2835, planes=1, bpp=24, compression=0

## Color Parsing
- Hex color string parsed via `strtoul(str, NULL, 16)` → 0xBBGGRR
- B = (color >> 16) & 0xFF, G = (color >> 8) & 0xFF, R = color & 0xFF
- Invalid hex (e.g., "XYZ") → color = 0 (black)
- Display format: `#%06X` (e.g., `#FF0000`)

## Commands

### solid
- Fills entire image with the given color
- Output message: `%dx%d solid #%06X -> %s`
- Validation: w > 0 && h > 0 (else "ERROR: invalid dimensions %dx%d")

### gradient
- Interpolates between start and end colors
- **Both directions use the same formula**: `channel = start_c + (end_c - start_c) * pos / dim`
  - Horizontal: pos = x, dim = w (x=0 → start, x=w-1 → near end)
  - Vertical: pos = y, dim = h (y=0 → start, y=h-1 → near end)
- Integer arithmetic (truncation toward zero)
- Direction: 'v' → vertical, anything else → horizontal
- Output: `%dx%d gradient #%06X->#%06X (%s) -> %s` (direction shown as "horizontal"/"vertical")

### checker
- Alternating squares of size `size x size`
- Pattern: `((x/size + y/size) % 2 == 0) ? c1 : c2`
- Validation: size > 0 (else "ERROR: invalid size")
- Output: `%dx%d checker size=%d -> %s`

### rect
- Fills rectangle from (x,y) with dimensions rw x rh
- Condition: `px >= x && px < x+rw && py >= y && py < y+rh` → fill color, else black (0,0,0)
- Output: `%dx%d rect (%d,%d %dx%d) -> %s`

### circle
- Fills circle centered at (cx,cy) with radius r
- Condition: `(px-cx)^2 + (py-cy)^2 <= r^2` → fill color, else black
- Output: `%dx%d circle (%d,%d r=%d) -> %s`

### noise
- PRNG: LCG with `state = (state * 1103515245 + 12345) & 0xFFFFFFFF`
- Seed is the initial state (unsigned, via strtoul)
- Per pixel: val16 = (state >> 16) & 0xFFFF, then B=0, G=(val16>>8)&0xFF, R=val16&0xFF
- Iteration order: y=0..h-1 (top to bottom), x=0..w-1 (left to right)
- Output: `%dx%d noise seed=%u -> %s`

## Error Handling
- Invalid dimensions (w<=0 or h<=0): "ERROR: invalid dimensions %dx%d" to stderr, exit 1
- Cannot open file: "ERROR: cannot open %s" to stderr, still prints success message to stdout, exit 1
- Invalid checker size (size<=0): "ERROR: invalid size" to stderr, exit 1
- Unknown command: "ERROR: unknown command '%s'" + usage to stderr, exit 1
- Missing args: prints usage to stderr, exit 1
- OOM: "ERROR: out of memory"

## Output Messages
- Success messages go to stdout with CRLF (\r\n)
- Error messages go to stderr with CRLF (\r\n)
- Usage message goes to stderr with CRLF (\r\n)

## Test Results
All 27 test cases pass (solid, gradient, checker, rect, circle, noise with various sizes/colors/seeds),
plus error cases (invalid dimensions, invalid size, cannot open file, unknown command, no args).
BMP files are byte-identical, stdout/stderr messages match exactly, and exit codes match.
