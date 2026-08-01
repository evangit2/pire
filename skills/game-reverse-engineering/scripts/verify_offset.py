#!/usr/bin/env python3
"""
verify_offset.py — Multi-file offset verification for Ghidra decompilations.

Usage:
    python verify_offset.py <hex_offset> <decomp_dir> [--verbose]

Example:
    python verify_offset.py 0xCA8 analysis/ghidra/decompilations/

Outputs confidence score and reference list for a struct field offset.
"""

import os
import re
import sys
import argparse
from pathlib import Path


def find_offset_refs(offset_hex: str, decomp_dir: str, verbose: bool = False):
    """
    Search all .c files in decomp_dir for references to the given byte offset.
    Also searches for int-indexed equivalents (offset / 4).
    """
    offset = int(offset_hex, 16)
    int_index = offset // 4

    # Patterns to search for
    patterns = [
        f"0x{offset:04x}",  # byte offset: 0x0ca8
        f"0x{offset:04X}",  # uppercase: 0x0CA8
        f"[{int_index}]",     # int-indexed: [0x32a]
        f"[{int_index:03x}]", # lowercase: [0x32a]
        f"[{int_index:03X}]", # uppercase: [0x32A]
    ]

    refs = []
    decomp_path = Path(decomp_dir)

    for c_file in decomp_path.rglob("*.c"):
        try:
            content = c_file.read_text()
        except Exception:
            continue

        for pattern in patterns:
            for match in re.finditer(re.escape(pattern), content):
                # Get surrounding context (line)
                start = max(0, match.start() - 200)
                end = min(len(content), match.end() + 200)
                context = content[start:end].replace('\n', ' ').strip()

                # Determine read vs write
                op_type = "unknown"
                snippet = content[max(0, match.start()-50):match.end()+50]
                if '=' in snippet and not ('==' in snippet or '!=' in snippet or '<=' in snippet or '>=' in snippet):
                    op_type = "write"
                elif any(op in snippet for op in ['+', '-', '*', '/', '==', '!=', '<', '>']):
                    op_type = "read"

                refs.append({
                    'file': str(c_file.relative_to(decomp_path)),
                    'pattern': pattern,
                    'offset': f"0x{offset:04x}",
                    'operation': op_type,
                    'context': context[:120] + '...' if len(context) > 120 else context,
                })

    return refs


def score_confidence(refs: list) -> tuple:
    """
    Score confidence based on reference count and diversity.
    Returns (marker, explanation)
    """
    if not refs:
        return "❌", "No references found — likely dead code or mislabeled field"

    files = set(r['file'] for r in refs)
    writes = sum(1 for r in refs if r['operation'] == 'write')
    reads = sum(1 for r in refs if r['operation'] == 'read')

    if len(files) >= 3 and reads >= 3 and writes >= 1:
        return "✅", f"Verified: {len(refs)} refs across {len(files)} files ({reads} reads, {writes} writes)"
    elif len(files) >= 2 and reads >= 1:
        return "⚠️", f"Likely correct: {len(refs)} refs across {len(files)} files ({reads} reads, {writes} writes)"
    else:
        return "❓", f"Single-source: {len(refs)} refs in {len(files)} file(s) — needs second-function verification"


def main():
    parser = argparse.ArgumentParser(description="Verify Ghidra decompilation offset")
    parser.add_argument("offset", help="Hex offset (e.g., 0xCA8)")
    parser.add_argument("decomp_dir", help="Directory containing .c decompilation files")
    parser.add_argument("-v", "--verbose", action="store_true", help="Show all references")
    args = parser.parse_args()

    refs = find_offset_refs(args.offset, args.decomp_dir, args.verbose)
    marker, explanation = score_confidence(refs)

    print(f"\n{'='*60}")
    print(f"Offset {args.offset} Verification")
    print(f"{'='*60}")
    print(f"Confidence: {marker} {explanation}")
    print(f"Total references: {len(refs)}")

    if args.verbose and refs:
        print(f"\nReferences:")
        for r in refs:
            print(f"  [{r['operation']:5}] {r['file']}: {r['context'][:80]}")
    elif refs:
        print(f"\nFiles touched:")
        for f in sorted(set(r['file'] for r in refs)):
            print(f"  - {f}")
        print("\nUse --verbose to see full context for each reference.")

    print()

    # Exit code: 0 for verified, 1 for uncertain, 2 for dead
    if marker == "✅":
        sys.exit(0)
    elif marker == "⚠️":
        sys.exit(1)
    else:
        sys.exit(2)


if __name__ == "__main__":
    main()
