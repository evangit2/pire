---
name: binary-xor-analysis
description: XOR encryption/decryption of binary data files, with runtime hooking for transparent decryption
tags: [reverse-engineering, encryption, xor, dll-proxy, binary-analysis]
---

# MESHWORLD File Encryption

## Goal
Make MESHWORLD files unreadable as plain text/hex by XOR-encrypting the entire file contents. The game's bass.dll proxy mod decrypts at runtime.

## MESHWORLD Loading Pipeline (decompilation-verified, sess1547)

The game has TWO separate MESHWORLD loaders, dispatched by `LoadMeshWorld` (0x45DE30):

```c
// LoadMeshWorld (0x45DE30) — Level vtable[0x30]
sprintf(buf, "%s.meshworld");
if (_check_file_access(buf, 0) == 0) {
    // .meshworld file EXISTS → binary loader path
    vtable[0x38](buf);   // open file → FUN_004629E0 reads S1-S5
    vtable[0x3c](0);     // → Scene_LoadMeshWorld reads S6 octree
} else {
    // .meshworld NOT found → ASCII text parser fallback
    MeshWorld_Parse(meshworld, filename, '\0');
}
```

`_check_file_access` follows POSIX `access()` convention: 0 = file found, non-zero = not found.

### Binary Loader — `Scene_LoadMeshWorld` (0x461890)
Called when `.MESHWORLD` file exists. Uses a file handle (`param_1`) with sequential `__read()` calls:
- `__read(handle, bounds, 0x18)` — 24 bytes: min XYZ + max XYZ (6 floats)
- `__read(handle, &section_count, 4)` — section count (0 for binary MW files)
- If section_count < 1: per meshbuffer reads (name, material 72B, has_texture, strips)
- `__thiscall(ECX=this/sceneobj, param_1=file_handle, param_2=level_data)`

### ASCII Text Parser — `MeshWorld_Parse` (0x470930)
Fallback when `.MESHWORLD` not found. Parses ASE-style text (`*MATERIAL_COUNT`, `*MESH_VERTEX`, etc.) via `strtok`/`_atof`. File opened by `FUN_0047d7c0`, lines read via `FUN_0047d6b0` (like `fgets`).

## Encryption Approach

1. XOR entire file with a key byte (any non-zero value 1-255)
2. No backward compatibility needed — encrypted files only
3. bass.dll proxy mod hooks the file loading to XOR-decrypt before the game's parser sees data

## Hook Points

### Option A: Detour `__read` calls in `Scene_LoadMeshWorld`
Hook the entry of `Scene_LoadMeshWorld` (0x461890). After each `__read(handle, buf, size)` call returns, XOR the buffer with the key byte. The file handle (`param_1`) is on the stack — easy to intercept.

### Option B: File Handle Wrapping
Hook `LoadMeshWorld` (0x45DE30) BEFORE it dispatches:
1. Open the file yourself
2. Read entire contents into memory
3. XOR-decrypt in memory
4. Create a memory-mapped file handle
5. Pass that handle to the original loader

### Option C: Hook the ASCII path too
For `MeshWorld_Parse` (0x470930), hook `FUN_0047d6b0` (the line-reading function) to XOR each line buffer after reading.

## Key Constraint

File systems are byte-addressed. Minimum file size increase is 1 byte (8 bits). There is no way to add a single bit to a file. XOR encryption adds zero bytes (same file size) — every byte is transformed in place.

## Implemented Approach: IAT Hooking (sess1741, WORKING)

Instead of detouring game functions, hook the Win32 API calls themselves via
IAT (Import Address Table) patching. The game's CRT `__read` internally calls
`ReadFile`, and `_open` internally calls `CreateFileA` — both go through the
EXE's IAT, so hooking there catches both binary and ASCII loading paths.

### Architecture

1. **Hook `CreateFileA`**: Check if filename ends in `.mesh` or `.meshworld`.
   If so, track the returned `HANDLE` in a table (up to 64 entries, protected
   by `CRITICAL_SECTION`).
2. **Hook `ReadFile`**: After reading, if the handle is tracked, XOR-decrypt
   the buffer with the key byte.
3. **Hook `CloseHandle`**: Remove handle from tracking table to prevent stale
   entries and handle-value reuse false positives.

### Critical Pitfalls (all discovered during build)

1. **CreateThread in DllMain for IAT patching = race condition**: The thread
   starts after DllMain returns, but WinMain also starts immediately. Game
   reads files before IAT is patched → crash. **Fix**: Patch IAT directly in
   DllMain (DLL_PROCESS_ATTACH). `GetModuleHandleA(NULL)` and `VirtualProtect`
   both work safely in DllMain.

2. **`load_real_bass()` in DllMain = loader lock deadlock**: Calling
   `LoadLibraryA("bass_real.dll")` inside DllMain causes
   STATUS_STACK_OVERFLOW (c00000fd). **Fix**: Use lazy loading — call
   `load_real_bass()` on the first BASS function call (inside each export
   stub), NOT in DllMain. Add `static int tried` flag.

3. **MinGW `__try`/`__except` not supported**: MSVC SEH is unavailable in
   MinGW. **Fix**: Use `IsBadReadPtr` safety checks at every PE header
   traversal step in `patch_iat()`.

4. **Without `IsBadReadPtr` checks, `patch_iat` crashes with c0000005**:
   During DllMain, some IAT entries may not be fully resolved yet. Every
   pointer dereference in the PE import descriptor traversal must be
   guarded with `IsBadReadPtr`.

5. **bass_real.dll must be the TRUE original (97KB), not a stale mod**:
   The game directory may contain multiple bass.dll variants from previous
   mod sessions (228KB, 510KB, etc.). Using a modded bass.dll as
   `bass_real.dll` causes proxy chain corruption. **Fix**: Verify
   `bass_real.dll` is ~97KB with 4 PE sections and no mod strings
   (`strings bass_real.dll | grep -i "level\|swirl\|patch\|VirtualProtect"`
   should be empty). The true original is at `bass.dll.bak2` in the dev copy.

### Build command

```bash
i686-w64-mingw32-gcc -shared -o bass.dll mesh_xor_decrypt.c \
  -lwinmm -Wl,--enable-stdcall-fixup -O2 -static -static-libgcc \
  -Wl,--add-stdcall-alias
```

### Reference implementation

`tools/mesh_encrypt/mesh_xor_decrypt.c` — crash-tested on Wine (hbtestd: OK,
11.9s runtime, no crash). Includes:
- `patch_iat()` with full `IsBadReadPtr` safety
- File handle tracking table (64 entries, `CRITICAL_SECTION`)
- Lazy BASS audio forwarding (no `load_real_bass()` in DllMain)
- `is_mesh_file()` extension checker (case-insensitive, handles `.mesh` and
  `.meshworld`)

### Encryption tool

`tools/mesh_encrypt/encrypt_mesh.py` — Python script that XOR-encrypts all
`.mesh`/`.meshworld` files in a directory (recursive, in-place). Symmetric:
run again to decrypt. Key=119 (0x77).

### Security limitation

The XOR key is stored as a constant (`#define XOR_KEY 119`) in the DLL
binary. Anyone who opens the DLL in a disassembler can find it in seconds.
This is obfuscation against casual hex-editor browsing, not real encryption.
For stronger protection, use a multi-byte key or derive the key at runtime.

## Key Addresses

| Function | Address | Purpose |
|----------|---------|---------|
| LoadMeshWorld | 0x45DE30 | Dispatcher: binary vs ASCII text loader |
| FUN_004629E0 | 0x4629E0 | vtable[0x38] — reads S1-S5 from binary |
| Scene_LoadMeshWorld | 0x461890 | vtable[0x3C] — reads S6 octree (binary) |
| MeshWorld_Parse | 0x470930 | ASCII text parser (fallback) |
| FUN_0047d7c0 | 0x47D7C0 | File handle constructor (ASCII path) |
| FUN_0047d6b0 | 0x47D6B0 | Line reader function (ASCII path) |
| __read | 0x4C37D7 | CRT file read (calls ReadFile internally) |
| FID_conflict:__open | 0x4C6FAA | CRT file open (calls CreateFileA) |
| CreateFileA | kernel32 IAT | Win32 file open (hook target) |
| ReadFile | kernel32 IAT | Win32 file read (hook target) |
