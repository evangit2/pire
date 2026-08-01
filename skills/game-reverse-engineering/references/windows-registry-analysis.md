# Windows Registry RE — Analyzing How Games Persist Settings

## Overview

Windows games commonly store persistent settings (display, audio, unlocks, controls, best times) in the **Windows Registry** under `HKEY_CURRENT_USER\Software\<Publisher>\<GameName>`. The engine wraps raw Win32 ADVAPI32 calls in a thin helper layer. This reference documents how to discover, verify, and interact with a game's registry system during RE.

---

## Discovery: Finding Registry Activity in a Binary

### 1. Check imports for ADVAPI32.dll

```bash
objdump -x target_binary.exe | grep -i "RegOpen\|RegQuery\|RegSet\|RegCreate\|RegClose\|advapi32"
```

Expected output pattern:
```
DLL Name: ADVAPI32.dll
	f69f6	  481  RegOpenKeyExA
	f6a06	  456  RegCloseKey
	f6a14	  504  RegSetValueExA
	f6a26	  491  RegQueryValueExA
	f6a3a	  480  RegOpenKeyA
	f69e6	  459  RegCreateKeyA
```

If **no ADVAPI32 imports** exist, the game likely uses:
- INI files in the game directory
- `%APPDATA%` or `%LOCALAPPDATA%` XML/JSON files
- Steam Cloud sync (via `steam_api.dll` `SteamUserStats`)
- No persistent storage at all

### 2. Search for the registry key path string

```python
import struct

with open('target_binary.exe', 'rb') as f:
    data = f.read()

# Look for "Software\\Publisher\\GameName" or "Publisher\\%s"
for pat in [b'Software\\', b'Raptisoft', b'target application']:
    idx = data.find(pat)
    while idx != -1:
        va = 0x400000 + idx
        ctx = data[max(0,idx-8):min(len(data),idx+48)]
        print(f"0x{va:08X}: {ctx}")
        idx = data.find(pat, idx+1)
```

### 3. Find the format string

Games often build the key path dynamically:
```
"Software\\%s\\%s"  → "Software\\Raptisoft\\target application"
"Raptisoft\\%s"    → "Raptisoft\\target application"
```

Search for `"Raptisoft\\%s"` or `"Software\\%s"` in the string table.

### 4. Locate value names

Once you know the key path, extract all value names used by the game:

```python
with open('target_binary.exe', 'rb') as f:
    data = f.read()

value_names = [
    b"MouseSensitivity", b"MirrorTournament", b"DizzyRace",
    b"BestTime", b"Medals", b"2PController1",
    b"Resolution", b"Quality", b"RightButtonPause"
]

for name in value_names:
    idx = data.find(name)
    if idx != -1:
        va = 0x400000 + idx
        ctx = data[max(0,idx-16):min(len(data),idx+32)]
        print(f"Key '{name.decode()}' at 0x{va:08X}: {ctx}")
```

---

## Engine Wrapper Functions

Most games don't call Win32 APIs directly from every save site. They use thin wrappers:

### Common wrapper pattern

```cpp
// RegKey_Open — creates key if missing
void RegKey_Open(int* handle_out) {
    HKEY hKey;
    RegCreateKeyA(HKEY_CURRENT_USER, "Software\\Raptisoft\\target application", &hKey);
    *handle_out = (int)hKey;
}

// RegKey_WriteDWORD
void RegKey_WriteDWORD(void* handle, const char* name, DWORD value) {
    RegSetValueExA((HKEY)handle, name, 0, REG_DWORD, (BYTE*)&value, 4);
}

// RegKey_WriteBool (same as DWORD but 0/1)
void RegKey_WriteBool(void* handle, const char* name, BYTE value) {
    DWORD dw = value ? 1 : 0;
    RegSetValueExA((HKEY)handle, name, 0, REG_DWORD, (BYTE*)&dw, 4);
}

// Registry_SetValue (binary blob)
void Registry_SetValue(void* handle, const char* name, BYTE* data, DWORD size) {
    RegSetValueExA((HKEY)handle, name, 0, REG_BINARY, data, size);
}

// RegKey_Close
void RegKey_Close(int handle) {
    RegCloseKey((HKEY)handle);
    // cached handle invalidated
}
```

### Finding wrapper addresses

1. **Decompile the save function** (e.g., `App_SaveAllConfig` at `0x4284C0`)
2. **Look for string pushes** — the value names are pushed as args before the wrapper call
3. **Trace backward** from the string push to find the wrapper prologue
4. **The wrapper typically lives at a fixed offset** near other save/load functions

---

## Mapping Registry Values to App Struct Offsets

The critical RE task is mapping each registry value name to the **in-memory App struct offset** where the game stores the live value.

### Methodology

1. **Decompile the save function** — lists all `RegKey_Write*` calls with value names
2. **Note the App offset** passed as the third argument (e.g., `*(BYTE*)(app + 0x850)`)
3. **Decompile the load function** — confirms the same offset is read back
4. **Cross-reference** with the App constructor / init to see default values

### Example mapping from target application

| Registry Name | App Offset | Type | Description |
|---------------|-----------|------|-------------|
| `MouseSensitivity` | `+0x84C` | `DWORD` | Mouse sensitivity (0–10) |
| `MirrorTournament` | `+0x850` | `BYTE` | Mirror-mode tournament flag |
| `DizzyRace` | `+0x851` | `BYTE` | Unlock: Dizzy race |
| `TowerRace` | `+0x852` | `BYTE` | Unlock: Tower race |
| `BestTime` | `+0x86C` | `BYTE[0x50]` | 80-byte best times blob |
| `Medals` | `+0x8BC` | `BYTE[0x50]` | 80-byte medals blob |
| `2PController1` | `+0xB28` | `DWORD` | 2P mapping slot 1 |
| `RightButtonPause` | `+0x238` | `BYTE` | Right-click pauses game |

### Binary string offsets (for cross-referencing)

| String | Binary Offset | Context |
|--------|---------------|---------|
| `"Raptisoft\\%s"` | `0x4D3978` | Key path format |
| `"MouseSensitivity"` | `0x4D2898` | Save/load |
| `"MirrorTournament"` | `0x4D2884` | Save/load |
| `"BestTime"` | `0x4D274C` | Save/load |
| `"Medals"` | `0x4D2744` | Save/load |
| `"2PController1"` | `0x4D2734` | Save/load |
| `"Resolution: %d x %d"` | `0x4D5EB8` | Display UI |
| `"Texture Quality"` | `0x4D8780` | Display UI |

---

## Key Save/Load Functions

### Master save routine
- `App_SaveAllConfig` @ `0x4284C0`
- Called on: game exit, settings change, level complete
- Opens key, writes all values, closes key

### Startup load routine
- `LoadOrSaveConfig` @ `0x4279F0`
- Called on: game startup
- Creates key if missing, reads all values into App struct, fills defaults for missing values

### Display settings (separate subsystem)
- `App_WriteDisplaySettings` (called from `App_SaveAllConfig`)
- Saves resolution, color depth, texture quality, fullscreen

### Audio settings (separate subsystem)
- `SoundDevice_ReadVolume` @ `0x466570`
- `SoundDevice_dtor` @ `0x4668A0`
- Saves/loads sound volume

---

## Reading/Writing Registry from Outside the Game

### Python

```python
import winreg

key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Raptisoft\target application")

# Read DWORD (e.g., MouseSensitivity)
val, typ = winreg.QueryValueEx(key, "MouseSensitivity")
print(f"MouseSensitivity = {val} (type={typ})")

# Read binary blob (e.g., BestTime)
val, typ = winreg.QueryValueEx(key, "BestTime")
print(f"BestTime = {len(val)} bytes")

# Write a value
winreg.SetValueEx(key, "MyModFlag", 0, winreg.REG_DWORD, 1)

winreg.CloseKey(key)
```

### C++

```cpp
#include <windows.h>

HKEY hKey;
RegOpenKeyExA(HKEY_CURRENT_USER, "Software\\Raptisoft\\target application", 0, KEY_READ, &hKey);

DWORD mouseSens, type, size = sizeof(DWORD);
RegQueryValueExA(hKey, "MouseSensitivity", NULL, &type, (BYTE*)&mouseSens, &size);

RegCloseKey(hKey);
```

---

## Modding: Adding Custom Registry Values

When injecting code or writing a trainer/mod, follow the engine's pattern:

### 1. Open the cached handle (or create your own)

```cpp
// app = pointer to App object
int hKey = *(int*)((BYTE*)app + 0x54);  // cached handle
if (hKey == 0) {
    RegCreateKeyA(HKEY_CURRENT_USER, "Software\\Raptisoft\\target application", (HKEY*)&hKey);
    *(int*)((BYTE*)app + 0x54) = hKey;
}
```

### 2. Write a scalar

```cpp
DWORD myValue = 42;
RegSetValueExA((HKEY)hKey, "MyModValue", 0, REG_DWORD, (BYTE*)&myValue, 4);
```

### 3. Write binary data

```cpp
BYTE myBlob[64] = { ... };
RegSetValueExA((HKEY)hKey, "MyModData", 0, REG_BINARY, myBlob, sizeof(myBlob));
```

### 4. Close (or keep cached)

```cpp
// If you used the cached handle, DON'T close it — the game will
// If you opened your own handle, close it:
RegCloseKey((HKEY)hKey);
```

### Important Notes
- The game uses **REG_DWORD** for both true DWORDs and booleans (0/1), NOT REG_SZ
- Binary blobs use **REG_BINARY** with exact sizes (e.g., 80 bytes for BestTime/Medals)
- The cached handle at `App+0x54` is opened once at startup; don't leak it by closing early
- Display settings are saved separately; hook `App_WriteDisplaySettings` for display-related values

---

## Common Pitfalls

| Pitfall | Why It Happens | Fix |
|---------|----------------|-----|
| Wrong key path | Publisher name varies (e.g., "Raptisoft" vs "Raptisoft Games") | Check the binary string table for the exact format string |
| REG_SZ vs REG_DWORD mismatch | Game writes DWORD but tool reads as string | Always check the type returned by RegQueryValueEx |
| Cached handle invalidated | Game calls RegKey_Close on exit; tool tries to reuse | Open your own key handle or re-open each time |
| Missing default values | Game fills defaults when key is missing | Check the load function for default initialization |
| 64-bit vs 32-bit registry | 32-bit game on 64-bit Windows may use Wow6432Node | Use the same bitness as the game executable |

---

## Related Skills

- `game-reverse-engineering` — General RE methodology, dead code detection, struct verification
- `ghidra-mcp-headless` — Starting GhidraMCP for decompilation
- `the target-re` — Title-specific findings and field maps
