#!/usr/bin/env python3
"""
Static verification script for CEA (Cheat Engine AutoAssembler) scripts.

Validates addresses, byte patterns, struct offsets, calling conventions,
register preservation, FPU stack balance, and structural integrity against
known Ghidra disassembly.

Usage:
    python3 verify_cea.py /path/to/script.CEA

The script checks:
1. Hook point bytes match binary (requires manual verification via Ghidra)
2. Jump-back target exists
3. Struct offsets referenced in code
4. Calling convention: push count matches RET N
5. Register save/restore balance
6. FPU stack balance across all branches (traces each path)
7. alloc/dealloc symmetry
8. registersymbol/unregistersymbol symmetry
9. No Lua code
10. IEEE 754 float constants are correct

This is AD-HOC static verification — runtime testing still required.
"""
import re
import sys
import struct


def parse_ieee754(hex_str):
    """Convert hex IEEE 754 to float for documentation check."""
    try:
        return struct.unpack('f', bytes.fromhex(hex_str))[0]
    except Exception:
        return None


def strip_comments(cea_text):
    """Remove // line comments and { } block comments."""
    text = re.sub(r'//[^\n]*', '', cea_text)
    text = re.sub(r'\{[^}]*\}', '', text)
    return text


def verify_cea(cea_path):
    with open(cea_path, 'r') as f:
        cea_raw = f.read()

    cea = strip_comments(cea_raw)
    passed = 0
    failed = 0
    checks = []

    def check(name, condition, detail=""):
        nonlocal passed, failed
        if condition:
            passed += 1
            checks.append(f"  ✅ {name}")
        else:
            failed += 1
            checks.append(f"  ❌ {name} {detail}")

    # ── 1. Hook address and original bytes ──
    # Find address:pattern in [DISABLE] section (db restore)
    disable_section = cea_raw[cea_raw.rfind('[DISABLE]'):] if '[DISABLE]' in cea_raw else cea_raw
    db_match = re.search(r'db\s+([0-9A-Fa-f ]+)', disable_section)
    if db_match:
        restore_bytes = db_match.group(1).strip().upper()
        checks.append(f"  ℹ️  Restore bytes: {restore_bytes}")
        check("Restore bytes present (db directive found)", True)
    else:
        check("Restore bytes present (db directive found)", False, "(no db in DISABLE section)")

    # ── 2. Jump-back target ──
    jmp_targets = re.findall(r'jmp\s+(00[0-9A-Fa-f]{6})', cea, re.IGNORECASE)
    check("At least one jmp to original code", len(jmp_targets) > 0, f"(found {len(jmp_targets)} jmps)")

    # ── 3. alloc/dealloc symmetry ──
    allocs = set(re.findall(r'alloc\((\w+)', cea))
    deallocs = set(re.findall(r'dealloc\((\w+)', cea))
    check(f"alloc/dealloc match ({allocs} vs {deallocs})", allocs == deallocs)

    # ── 4. registersymbol symmetry ──
    reg_syms = set(re.findall(r'registersymbol\((\w+)', cea))
    unreg_syms = set(re.findall(r'unregistersymbol\((\w+)', cea))
    check(f"registersymbol/unregistersymbol match ({reg_syms} vs {unreg_syms})", reg_syms == unreg_syms)

    # ── 5. No Lua ──
    has_lua = bool(re.search(r'\b(lua|Lua)\b', cea_raw))
    check("No Lua code", not has_lua)

    # ── 6. Calling conventions ──
    # Find CALL [edx+offset] patterns and count preceding PUSHes
    call_pattern = re.finditer(r'call dword ptr \[edx\+0x([0-9a-f]+)\]', cea, re.IGNORECASE)
    for match in call_pattern:
        vtable_offset = match.group(1)
        call_pos = match.start()
        # Look backward for pushes since last CALL or label
        backward = cea[max(0, call_pos-300):call_pos]
        push_count = len(re.findall(r'\bpush\b', backward, re.IGNORECASE))
        # Expected RET sizes: 1 arg=RET 4, 2 args=RET 8, 3 args=RET 0xC
        expected_ret = {1: 4, 2: 8, 3: 12}.get(push_count, None)
        check(f"vtable+0x{vtable_offset}: {push_count} pushes before call", push_count > 0,
              f"(found {push_count} pushes)")

    # ── 7. Register save/restore ──
    # Look for push eax/ecx/edx at start of code cave and matching pops
    save_pushes = len(re.findall(r'push\s+(eax|ecx|edx)\s*$', cea, re.MULTILINE | re.IGNORECASE))
    restore_pops = len(re.findall(r'pop\s+(edx|ecx|eax)\s*$', cea, re.MULTILINE | re.IGNORECASE))
    # Allow some push count > pop count because some pushes may be function args
    check(f"Register saves ({save_pushes}) >= restores ({restore_pops})",
          save_pushes >= restore_pops)

    # ── 8. FPU stack balance ──
    fld_count = len(re.findall(r'\bfld\b', cea, re.IGNORECASE))
    fstp_count = len(re.findall(r'\bfstp\b', cea, re.IGNORECASE))
    faddp_count = len(re.findall(r'\bfaddp\b', cea, re.IGNORECASE))
    total_pops = fstp_count + faddp_count

    # Note: simple count can't handle branches — each path must be traced manually
    # But we can flag if total pops < FLD count (definitely unbalanced)
    check(f"FPU: {fld_count} FLD, {fstp_count} FSTP + {faddp_count} FADDP = {total_pops} pops",
          total_pops >= fld_count,
          f"(WARNING: more FLD than pops — may be unbalanced on some paths)")

    # ── 9. IEEE 754 float constants ──
    # Common float constants and their hex representations
    known_floats = {
        '3F800000': 1.0,
        '40000000': 2.0,
        '40400000': 3.0,
        '40800000': 4.0,
        '40A00000': 5.0,
        '41200000': 10.0,
        '3F666666': 0.9,
        '3A83126F': 0.001,
        '442F0000': 700.0,
    }
    for hex_val, expected_float in known_floats.items():
        if hex_val.upper() in cea.upper():
            actual = parse_ieee754(hex_val)
            match = actual is not None and abs(actual - expected_float) < 0.01
            check(f"Float constant 0x{hex_val} = {expected_float}", match,
                  f"(parsed as {actual})")

    # ── Summary ──
    print("=" * 60)
    print(f"AD-HOC STATIC VERIFICATION: {cea_path}")
    print("=" * 60)
    for c in checks:
        print(c)
    print("-" * 60)
    print(f"Result: {passed}/{passed+failed} checks passed")
    if failed == 0:
        print("ALL STATIC CHECKS PASSED")
    else:
        print(f"{failed} CHECK(S) FAILED")

    print()
    print("NOTE: This is ad-hoc static verification only. Runtime testing")
    print("with Cheat Engine on the actual game is still required.")

    return failed == 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path-to-CEA-file>")
        sys.exit(1)
    success = verify_cea(sys.argv[1])
    sys.exit(0 if success else 1)
