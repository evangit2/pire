# Data File Verification Trap — Verify Claims Against Actual Game Asset Files

Companion to §25 in `game-reverse-engineering/SKILL.md`.
Case study: target application "75 Ref Types" fabrication (Session 10821).

## The Error

Documentation claimed "75 unique ref types" across all 15 race levels. This
number was fabricated by:

1. **Conflating MESHWORLD Section 1 ref points** (bare names like `SPEEDCYLINDER`,
   `BONK`, `GEAR`) **with Section 6 entity names** (`N:GOAL`, `E:JUMP`,
   `T:NEONARROW`)
2. Listing entity names from the N:/E: handler (0x40C5D0) as if they were
   Section 1 ref points
3. Inventing refs that don't exist in any MESHWORLD file (e.g., `N:BUMP` as a
   Section 1 ref — no level file contains this)

User caught it: "you say bump and bumper and N:bump and N:bumper all exist in
beginner race, but I don't think bump or N:bump are actual objects or refs that
exist"

## The Fix

Wrote a parser using the official binary format spec (6-section layout from
the Raptisoft 3DS Max exporter source code), parsed all 15 original game
MESHWORLD files, and extracted the actual Section 1 ref point names.

**Result**: 46 unique object types (not 75). Many "refs" in the documentation
simply didn't exist in the game's data files.

## Why Code Analysis Alone Is Insufficient

| What Code Analysis Shows | What Asset Files Show | Why They Differ |
|--------------------------|-----------------------|-----------------|
| Factory handles `N:BUMP` via `__strnicmp` | No MESHWORLD file contains `N:BUMP` as a Section 1 ref | Factory *can* handle it, but no level *uses* it |
| N:/E: handler processes `N:GOAL` | `N:GOAL` exists as Section 6 entity name, NOT Section 1 ref point | Different sections of the binary format |
| Factory has code for `EDGECYLINDER` | No level file contains `EDGECYLINDER` | Cut content or arena-only (not in race levels) |

## Verification Protocol

1. **Parse the actual game data files** using the known binary format
2. **Separate Section 1 refs (object triggers) from Section 6 entities (behavior modifiers)** — they are different data in different parts of the file
3. **Count unique base types** (collapse numbered suffixes: `GEAR01`→`GEAR`, `TARBUBBLE35`→`TARBUBBLE`)
4. **Filter utility refs** (SAFESPOT, FLAG, START, BADBALL, etc.) from object refs
5. **Cross-reference**: if documentation claims N refs but parsing shows M refs (M < N), the documentation is inflated

## Rule

> **Every claim about "what exists in the game" must be verified by parsing the actual game data files.** Decompiled code tells you what the engine can handle; asset files tell you what actually exists. These are different sets. Never conflate the two, and never inflate counts by mixing data from different binary format sections.

## Parser Script

See `the target-meshworld/scripts/meshworld_parser.py` for the Python parser
that reads MESHWORLD binary files using the official format spec and extracts
Section 1 ref names + Section 6 entity names.
