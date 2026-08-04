# Hidden Feature & Debug Tool Analysis — Searching Game Binaries for Secrets

Methodology for systematically searching a Windows game binary for hidden developer menus, cheat codes, secret key combos, debug toggles, and easter eggs using GhidraMCP.

## When to Use

- User asks "are there any secret developer menus or debug tools in this game?"
- User asks about cheat codes, hidden key phrases, or konami codes
- You need to confirm absence (or presence) of hidden features before documenting a game's feature set
- Post-mortem analysis of a game's development artifacts

## Methodology (5 Steps)

### Step 1: Function Name Search

Search for debug/cheat/secret related function names across the entire binary.

```
GET /search_functions?name_pattern=debug
GET /search_functions?name_pattern=Debug
GET /search_functions?name_pattern=cheat
GET /search_functions?name_pattern=secret
GET /search_functions?name_pattern=console
GET /search_functions?name_pattern=admin
GET /search_functions?name_pattern=dev
GET /search_functions?name_pattern=god
GET /search_functions?name_pattern=menu      (filter for non-standard menus)
GET /search_functions?name_pattern=toggle
GET /search_functions?name_pattern=unlock
GET /search_functions?name_pattern=test
GET /search_functions?name_pattern=wireframe
GET /search_functions?name_pattern=overlay
GET /search_functions?name_pattern=noclip
GET /search_functions?name_pattern=godmode
```

**Endpoint quirk:** `search_functions` returns **plain text** (not JSON), format: `FuncName @ 0xADDR\nFuncName2 @ 0xADDR2`. "No functions found" means zero matches. The parameter is `name_pattern` (NOT `query` — that returns an error).

### Step 2: String Table Search

Search the binary's .rdata string table for debug/cheat/secret strings.

```python
# GhidraMCP search_strings endpoint
GET /search_strings?search_term=debug
GET /search_strings?search_term=cheat
GET /search_strings?search_term=secret
GET /search_strings?search_term=console
GET /search_strings?search_term=developer
GET /search_strings?search_term=god
GET /search_strings?search_term=noclip
GET /search_strings?search_term=easter
GET /search_strings?search_term=cheatcode
GET /search_strings?search_term=passcode
GET /search_strings?search_term=backdoor
GET /search_strings?search_term=admin
GET /search_strings?search_term=konami
GET /search_strings?search_term=iddqd
GET /search_strings?search_term=wireframe
GET /search_strings?search_term=debug
```

**Endpoint quirk:** `search_strings` uses parameter `search_term` (NOT `pattern`, `query`, `search`, `value`, `text`, or `substring` — all return `{"error":"search_term parameter is required"}`). Returns JSON: `{"matches":[{"address":"0xADDR","value":"string","encoding":"ascii"}], "total":N, "offset":0, "limit":100}`.

Also search for:
- Key names in the key-remapping range (F1-F12, CTRL+ combos, etc.)
- Registry key paths that might store debug flags
- Developer/studio names (credit screen easter eggs)
- "TODO", "FIXME", "HACK", "XXX" developer markers

### Step 3: Cross-Reference Verification

For every interesting string or function found, get its cross-references to understand how it's used.

```python
# Bulk xref lookup
POST /get_bulk_xrefs
{"addresses": ["0x004d0437", "0x004d9304"]}
# Returns: {"0x004d0437": [{"from":"0xADDR","type":"DATA"}], ...}
```

**Pitfall:** Some strings have ZERO xrefs — they may be unreferenced data (e.g., a string that was used during development but the code was removed, leaving the string in .rdata). Zero xrefs = potentially dead/orphaned string.

### Step 4: Decompile and Verify

For every hit, decompile the referencing function to determine what the string/function actually does. Many "interesting" names turn out to be legitimate game features:

| String/Function Name | What It Sounds Like | What It Actually Is |
|----------------------|---------------------|---------------------|
| `CreateSecretObjects` | Hidden debug menu | Legitimate arena-unlock gameplay mechanic |
| `ASTART-DEBUG` | Debug start point | Level design spawn point name (zero code xrefs) |
| `BugTracker_ShowDialog` | Developer debug panel | Crash reporter that phones home to bugs.raptisoft.com |
| `SafeMode` | Hidden debug toggle | Graphics compatibility option in the Options menu |
| `SUPER` | Cheat code prefix | Level design parameter for sawblades |
| `Mirror Tournament` | Secret game mode | Legitimate unlockable (win tournament at Normal+) |
| `*** BEGIN RAPTISOFT SESSION ***` | Debug console | Internal logging to a separate utility window |
| `MWParser_DumpTags` | Debug dump tool | Developer utility, not accessible in-game |
| `POWER` | Cheat keyword | Keyboard key name in the key remapping system |
| `NetworkConnection_Ctor` | Online multiplayer stub | InputDevice base constructor (20-byte struct). "Not Connected" = no gamepad. WS2_32 imports are for eSellerate DRM + crash reporter, NOT game networking. |
| `MPMenu` / `App_StartMPRace` | Online multiplayer menu | Multiplayer **Party** menu — local 2P split-screen and 1-4P Rodent Rumble only |

### Step 5: Compile Findings

Report in two sections:
1. **What IS in the binary** — with explanation of what each item actually does
2. **What is NOT in the binary** — explicitly list the absence of: cheat code strings, debug menu functions, console parsers, F-key debug toggles, FreeCamera/NoClip/GodMode functions

## Pitfall: Misidentifying System Infrastructure as Game Features

When sweeping for hidden features, infrastructure code (DRM, crash reporters, auto-updaters) can look like game features. Common false positives:

1. **Winsock imports** — `socket`, `connect`, `send`, `recv` from WS2_32.dll do NOT mean online multiplayer. Parse the PE import table, then trace which code actually calls these functions. In target application, all winsock usage traces to eSellerate DRM HTTP calls and the crash reporter.
2. **`NetworkConnection` / `*Connection*` class names** — may be InputDevice wrappers, not network sockets. Check the struct allocation size (20 bytes = trivial data wrapper, not a TCP connection).
3. **`MP` in function names** — `MPMenu`, `App_StartMPRace` may stand for Multiplayer **Party** (local), not online multiplayer.
4. **`*unlock*` strings** — may refer to DRM activation (serial key unlock), not hidden game content.

**Verification approach:** Before claiming a feature exists, trace from the string/function name → decompile the caller → check allocation sizes → verify against PE imports. See `references/function-name-verification-methodology.md` heuristics 5-6.

## GhidraMCP Endpoint Reference (for this analysis)

| Endpoint | Method | Parameter | Returns | Format |
|----------|--------|-----------|---------|--------|
| `search_functions` | GET | `name_pattern` | Plain text | `Name @ 0xADDR\n` |
| `search_strings` | GET | `search_term` | JSON | `{"matches":[{address,value,encoding}]}` |
| `list_functions` | GET | (none) | Plain text | `Name at 0xADDR\n` (**`at`**, not `@`) |
| `get_bulk_xrefs` | POST | `{"addresses":[...]}` | JSON | `{"0xADDR":[{"from","type"}]}` |
| `decompile_function` | GET | `address` | Plain text | C pseudocode |

**Critical parsing note:** `list_functions` returns lines as `Name at 0xADDR` (with `at`, not `@`). Parsing with ` @ ` separator will produce zero results. Use ` at ` (with spaces) or `rsplit(' at ', 1)`.

## Finding the Function Containing an Address

When an xref points to an address inside a function (not at its start), find the containing function:

```python
# Parse list_functions, sort by address, binary search
r = requests.get(f"{GHIDRA}/list_functions", timeout=30)
all_funcs = []
for line in r.text.strip().split('\n'):
    if ' at ' in line:
        idx = line.rfind(' at ')
        name = line[:idx].strip()
        addr = int(line[idx+4:].strip(), 16)
        all_funcs.append((name, addr))
all_funcs.sort(key=lambda x: x[1])

# Find function containing target address
target = 0x0046a766
prev = None
for name, addr in all_funcs:
    if addr <= target:
        prev = (name, addr)
    else:
        break
# prev = (function_name, function_start_addr)
```

## Comprehensive Search Pattern List

### Function name patterns
```
debug Debug cheat Cheat secret Secret dev Dev console Console
admin Admin test Test god God hack backdoor easter Easter egg
menu Menu toggle Toggle unlock Unlock skip Skip levelselect
cheatcode CheatCode passcode password backdoor admin super mega
power free warp wireframe overlay monitor hidden bonus fps
godmode noclip invincible freeze explode ghost nuke
```

### String search patterns
```
debug DEBUG cheat CHEAT secret SECRET unlock UNLOCK
console CONSOLE developer DEVELOPER god GOD
easter EASTER egg bonus BONUS hidden HIDDEN
cheatcode passcode password backdoor BACKDOOR admin ADMIN
super SUPER mega MEGA power POWER free FREE
warp WARP skip SKIP fps FPS overlay OVERLAY
wireframe WIREFRAME noclip NOCLIP godmode GODMODE
konami iddqd idkfa invincible freeze ghost
TODO FIXME HACK XXX
F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12
```

## Case Study: target_binary.exe (Session 11446 + Session 14509)

**Result:** No secret developer menus, no cheat codes, no hidden debug tools, no online multiplayer.

### Session 11446 (Initial sweep)
Found items that sounded interesting but were legitimate:
- Secret/Arena Unlock system (`CreateSecretObjects`, `CheckArenaUnlock`) — known gameplay feature
- Raptisoft Bug Tracker — crash reporter (phones home to bugs.raptisoft.com)
- Raptisoft Session Logger — internal dev logging to a utility window
- `MWParser_DumpTags` — dev utility for inspecting MESHWORLD data (not in-game accessible)
- `ASTART-DEBUG` — level design spawn point name (zero code xrefs)
- SafeMode — graphics compatibility option (visible in options menu)
- Mirror Tournament — legitimate unlockable
- Credits screen with shoutouts to FLIPCODE.COM and EndBossGames.com

Confirmed absent: cheat code strings, debug menu functions, console parsers, F-key toggles, FreeCamera/NoClip/GodMode, OutputDebugString calls, level select/skip functions.

### Session 14509 (Comprehensive feature sweep)

Expanded search using `strings -n 5` + Ghidra decompilation. Found 17 categories of features:

**Fully implemented (retail):**
- Tournament campaign (save/load, 3 difficulties, rollback) — `TournamentManager` 0x433ac0
- Party Race 2P split-screen — `App_Start2PRace` 0x429230, `PartyMenu_ctor` 0x42fc10, `Level10-2PBridge`
- Mirror Tournament (unlockable) — `Level_RenderWithMirror4/5`, mirrored texture assets
- Rodent Rumble 1-4P arena combat — 13 arenas, AI players, survival bonus
- Medal/rank system (Gold/Silver/Bronze/Golden Weasel) — `textures\ranks\%d.jpg`
- Secret collectibles — `N:SECRET`/`N:UNLOCKSECRET`, unlocks arenas in tournament mode
- Glass break bonus — `Meshes\GlassBonus`/`Meshes\GlassBonus-Smashed`, time bonus
- BounceBall/FollowBall timed enemy spawner — `BounceBall_Update` 0x00440840, spawns chase ball after 120s
- Auto-update system — `UpdaterStub` version check
- Crash reporter — XML error reports to Raptisoft server

**Embedded third-party systems:**
- eSellerate DRM — full activation/serial system, HTTP to `store.esellerate.net`
- Demo/trial mode — free play counter, intentional slowdown, purchase prompts

**Misidentified (corrected):**
- `NetworkConnection_Ctor` (0x0046dfa0) — NOT network multiplayer. It's the InputDevice base constructor (20-byte struct). "Not Connected" = no gamepad. WS2_32.dll imports used exclusively by eSellerate DRM + crash reporter.

**Referenced but possibly unused:**
- `Meshes\FunBall` — unknown ball variant

**Full N: and E: event catalog (session 14509):**
- 30 N: object types (SECRET, UNLOCKSECRET, TENBONUS1/2, EXTRATIME, GLASS, BOUNCE, JUMPFIRST/SECOND, NOCONTROL, ONGEAR, ONROTATOR, SAWTEETH, SPEEDCYLINDER, SPINNY, SQUAREWOBBLY, TRAPDOOR, WHEELEMBED, NEONPLATFORM, WATERWHEEL, SWIRL, TARPIT, MOUSETRAP, WAVY, WATER, GOAL, BUMPER, BRIDGE, MACE, SPINNER, LIMIT)
- 40+ E: event triggers (OPENSESAME, SAFESWITCH, VACPOPOUT, ZOOP, SHRINK/GROW, GRAVITY, SWALLOW, TRAJECTORY, LIGHTSON/OFF, HEATON/OFF, CALLHAMMER, HAMMERCHASE, etc.)
- 1 DN: type (SINKPLATFORM)
