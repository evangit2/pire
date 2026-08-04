---
name: emulation-port-evaluation
description: Evaluate emulation layers for binary compatibility — methodology, compatibility assessment, and documenting dead ends.
tags: [reverse-engineering, emulation, compatibility, wasm, browser, dead-end]
---

# Emulation Port Evaluation

> Adapted from the target-specific RE toolkit for general binary analysis.

Evaluate whether an emulation layer can run a binary target in a non-native environment (e.g. browser via WASM, different OS via Wine, or mobile via translation layers). Covers methodology for confirming dead ends, documenting evidence, and identifying viable alternatives.

## When to use this skill

- Assessing whether a Windows game or tool can run in the browser via Boxedwine/Emscripten.
- Evaluating Wine compatibility for automated headless testing.
- Deciding between emulation, reimplementation, or streaming for deployment.

## Architecture Analysis

Trace the full graphics/audio stack from the binary through the emulation layer to the host:

```
target_binary.exe (x86, emulated)
  → target DLL (PE stub redirector)
    → Wine/compat library.so (translation layer, e.g. D3D→OpenGL)
      → emulation GL marshal (intercepts x86 GL calls)
        → SDL2 → WebGL2 (browser)
```

Identify where the chain breaks. Common break points:
1. **Desktop OpenGL → WebGL gap**: Wine's OpenGL library makes desktop OpenGL calls (WGL context creation, GLX extensions, immediate-mode rendering) that have no mapping to WebGL.
2. **Missing host drivers**: Software renderers (llvmpipe, lavapipe) may not support all features a translation layer needs.
3. **Loader lock / threading**: Emulated Windows loader behavior may deadlock or behave differently from native Windows.
4. **Display mode changes**: Headless X servers (Xvfb) may not support runtime display mode changes that fullscreen games require.

## Evaluating Claims from Release Notes

Release notes may claim "Direct3D and OpenGL work pretty well" — this may refer to **desktop-only** builds (Linux/Mac/Windows native). Always:
1. Check the live demo page for actual running examples.
2. Verify whether the claimed support applies to the Emscripten/web build.
3. Look for third-party independent build reports.

## Gathering Evidence

1. **Live demos**: If the technology works in browser, there should be working demos. Their absence is strong evidence against.
2. **Third-party reports**: Search for independent developer build attempts and their results.
3. **Source inspection**: Check whether the emulation layer contains bridging code between the binary's API calls and the host environment.
4. **Build attempts**: Try compiling with the claimed flags and document failures.

## Concrete Build Failures

When attempting to force-enable an unsupported path, expect:
1. **Missing headers**: Platform headers (X11/GLX) may not exist in the Emscripten sysroot.
2. **Stub approach incomplete**: Minimal stubs may compile but crash at runtime when the emulation layer needs real callbacks.
3. **No bridge exists**: There may be no code anywhere that bridges the binary's abstraction layer to the host's. This is a missing piece of software, not a configuration issue.
4. **Desktop-specific API calls**: Even with stubs, the binary may call desktop-specific functions (context management, extensions, immediate-mode rendering) that the host API has no equivalent for.

### Conclusion Template

When an approach has been tried by multiple independent parties with the same result, document:
- Compilation may succeed with stubs.
- There is no runtime bridge from the binary's expected API to the host's.
- This is a missing piece of software that does not exist anywhere.

## What Actually Works

Document fallbacks that DO work:
- 2D applications and DirectDraw-era software in Boxedwine WASM.
- Native emulation builds (Linux/Mac/Windows desktop) with real GPU support.
- Basic windowed applications in Wine with proper prefix configuration.

## Viable Alternatives

When emulation is a dead end, present alternatives:
1. **Reimplementation**: Write a custom renderer that loads original assets and calls the host API directly.
2. **Desktop streaming**: Run the original binary on a server, stream via WebRTC.
3. **Translation layer**: Build a D3D→WebGL translation layer (major engineering effort).

## See Also

- `wine-differential-analysis` — comparing native vs Wine API behavior
- `loader-crash-analysis` — debugging Wine-specific crashes
