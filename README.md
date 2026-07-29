# CLAMPS – Audio-aware Lisp IDE

**An audio-aware Lisp IDE for CLAMPS and Incudine.**

 

CLAMPS for VS Code integrates Common Lisp development, interactive evaluation and audio/DSP workflows into one editor. It is designed especially for work with [CLAMPS](https://codeberg.org/ormf/clamps) and [Incudine](https://github.com/titola/incudine).

## Highlights

- Start, stop and restart an SBCL/CLAMPS session from VS Code
- Integrated Common Lisp REPL and evaluation of selections, files and top-level forms
- SLIME-style completion, autodoc, macroexpansion, disassembly and inspection
- Debugger integration with conditions, restarts and variable inspection
- XREF navigation for definitions, callers, callees, references and bindings
- Structural editing and parenthesis tools
- Incudine node browser, DSP status and real-time level monitoring
- Browsers for packages, classes, threads and traced functions

## Related projects

### CLAMPS

[CLAMPS](https://codeberg.org/ormf/clamps) by Orm Finendahl is the primary environment targeted by this extension. Install and configure CLAMPS before using CLAMPS-specific commands and views.

### Incudine

[Incudine](https://github.com/titola/incudine) is a music and DSP programming environment for Common Lisp by Tito Latini. This extension provides dedicated Incudine node, status and real-time audio tooling.

## Requirements

- Visual Studio Code 1.85 or newer
- SBCL
- A working CLAMPS installation for the full CLAMPS workflow
- Incudine and its native audio dependencies for Incudine/DSP functionality

Platform-specific audio backends and native libraries must be installed according to the CLAMPS and Incudine documentation.

## Getting started

1. Open a Common Lisp or ASDF project in VS Code.
2. Open the Command Palette.
3. Run **CLAMPS: Start**.
4. Open the integrated REPL with **CLAMPS: Open REPL**.
5. Evaluate the current selection or line with **CLAMPS: Evaluate Selection or Line**.

The CLAMPS activity-bar view exposes XREF results, Incudine nodes, packages, classes, threads, and tracing tools.

## Building from source

```bash
npm ci
npm run compile
npm test
```

Create a VSIX package with:

```bash
npm run package
```

For the complete test gate, including SBCL-based Lisp tests:

```bash
npm run gates
```

## Release

This repository is prepared for version **1.0.0**. Before publishing, make sure the Marketplace publisher ID in `package.json` matches the publisher registered in the Visual Studio Marketplace.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
