# The Hidden Stack-Argument Trap

Ghidra's decompiler sometimes hides a stack argument. This happens most often when a function forwards that argument **untouched** to a tail-called helper, or when the function reads it only through `ret N` cleanup.

## When to suspect a hidden argument

- The function ends with `ret N` where `N / 4` is larger than the number of visible parameters.
- Ghidra's signature shows `__fastcall`/`__thiscall` with fewer stack parameters than the `ret` cleans.
- The function body never dereferences `[esp+4]` or `[ebp+8]`, but a tail-called helper consumes it.
- Empirically, calling the function from injected code with only the visible parameters crashes on return.

## Verification protocol

Always check three sources of ground truth, in this order:

1. **Function prologue** — which registers and stack slots are read before any local writes?
2. **Multiple native call sites** — what does the game push before the `call`?
3. **Return cleanup** — `ret N` cannot lie; it tells you exactly how many stack bytes the callee removes.

## Example pattern

```asm
MyFunc:
    mov eax, [ecx+4]      ; this pointer expected in ECX
    ...
    call Helper           ; might use the stack argument
    ...
    ret 4                 ; cleans one hidden stack argument
```

If callers do:

```asm
mov  ecx, this
push 0x3F800000         ; float 1.0
call MyFunc
```

then the real prototype is effectively:

```cpp
void __thiscall MyFunc(void* this_, float hidden_volume);
```

Even if `MyFunc` never reads the float directly, the pushed value is required because `Helper` reads `[esp+8]` and the function returns with `ret 4`.

## Why the decompiler hides it

When `MyFunc` tail-jumps to `Helper`:

```asm
mov ecx, eax      ; new 'this' for Helper
jmp Helper
```

Ghidra treats the jump as a call and folds parameters. Because the float is not read by `MyFunc`, it is not shown in `MyFunc`'s signature. The float survives on the unchanged stack and is only visible as mysterious `ret 4` cleanup.

## Concrete specimen: target application audio

Verified in `target_binary.exe`:

- `0x004597B0` — `Sound_PlayChannel` decompiles as one `int` parameter, but actual convention is `__thiscall(SoundList*, float volume)` with `ret 4`.
- `0x00459860` — `Sound_Play3D` decompiles as three floats, but actual convention is `__thiscall(SoundList*, float x, float y, float z, float volume)` with `ret 0x10`.

See `the target-re/references/audio-calling-conventions.md` for full addresses, offsets, and example wrappers.

## Protection for injected code

Whenever you hook a member function and the original `ret` amount does not match your typedef, rebuild the prototype from the binary. Until proven otherwise, assume there is a hidden trailing parameter matching:

```
stack_argument_count = ret_N_bytes / 4
```

If a function has multiple logical stack args, verify their order from **native call sites** (look at the last `push` before the `call`, which is the leftmost argument in C order for `__thiscall`/`__stdcall`).
