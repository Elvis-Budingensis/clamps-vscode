# Changelog

All notable changes to CLAMPS for VS Code are documented here.

## [1.0.2] - 2026-07-29

### Added

- **Documentation gate** (`node test/comments.test.js`, wired into
  `npm run gates`). The occasion: a translation pass came back with every
  comment in the tree deleted — 2861 lines — and 98 Lisp docstrings replaced
  by the placeholder `"Internal documentation."`. The entire gate chain
  stayed green, because comments do not execute.

  Three rules, deliberately different in kind:

  1. **Snapshot** — per-file comment and docstring counts against
     `test/comment-baseline.json`, with a tolerance of 10 % or three lines.
     A file that lost prose while its code stayed is reported as a strip
     rather than an edit.
  2. **Floor** — no file of 120 lines or more may end up with fewer than
     three comment lines. Needs no snapshot, so it still bites if the
     snapshot is regenerated on an already stripped tree.
  3. **Placeholders** — no docstring may be a content-free filler
     (`"Internal documentation."`, `"TBD"`, `"Helper"` and similar).

  The snapshot records numbers only; which files to measure comes from
  reading `src/`, `lisp/` and `test/`. A list of file names would decay with
  the next new module — the mistake `test/gatecoverage.test.js` already
  guards against elsewhere. Update it deliberately with
  `npm run comments:update`, so that the decision stands in the diff.

- Docstrings are measured as string literals of 40 characters or more, because
  a Lisp docstring is an ordinary string and invisible to a comment counter.
  Replacing one with a short placeholder keeps the string count and loses the
  length, which is exactly what this detects.

## [1.0.1] - 2026-07-29

### Added

- **Freq scope** (`CLAMPS: Show Spectrum (Freq Scope)`): a real-time spectrum
  of a sticker ring, modelled on SuperCollider's FreqScope. Logarithmic or
  linear frequency axis, dB grid, filled curve, peak hold with fall, and a
  cursor readout in hertz with the nearest note name and cent deviation.
- Own radix-2 FFT and window functions (Hann, Blackman-Harris, rectangular,
  in their periodic form) in `lisp/rpc.lisp`, plus
  `sticker-spectrum-for-repl` and the `clamps/stickerSpectrum` bridge method.
  The FFT runs in the Lisp image and transfers one number per drawn column,
  so the amount of data depends on the window width in pixels rather than on
  the sample rate and the FFT size.
- Peak frequency with parabolic (QIFFT) interpolation over the neighbouring
  bins in dB, so that the readout does not snap to the bin grid.
- Settings `clamps.freqScopeIntervalMs` and `clamps.freqScopeFftSize`.
- New gates: `sbcl --script lisp/test-spectrum.lisp` (FFT against a naive
  DFT, level accuracy of all three windows, sub-bin frequency, silence, NaN,
  error paths, axis edges, decimation) and `node test/freqscope.test.js`
  (note names, peak hold, the frequency axis being invertible and strictly
  rising, and the webview twin computing exactly like the module).

### Changed

- The entire source is now in English: comments, docstrings, log output and
  all user-facing strings, including command titles, setting descriptions and
  the XREF sidebar labels.
- The freq scope reports rather than silently accepts three situations in
  which a spectrum would look plausible but be wrong: a decimated ring
  (aliasing that cannot be undone), an unknown sample rate without Incudine,
  and non-finite samples.

### Fixed

- `lisp/check.py` mis-measured lambda lists containing default values: the
  extraction ended at the first `)`, so `(key &optional (limit 4096))` was
  counted as two required and two optional arguments instead of two and one.
  The number happened to be large enough to let the real call through, so the
  check was not checking, merely not getting in the way. Extraction is now
  paren-aware.

## [1.0.0] - 2026-07-28

### Added

- Integrated SBCL/CLAMPS process management and Common Lisp REPL
- Evaluation commands for selections, files, top-level forms and preceding expressions
- Completion, autodoc, macroexpansion, disassembly and object inspection
- Debugger support with conditions, restarts, stack navigation and variable inspection
- XREF navigation and browser views
- Structural editing, indentation and parenthesis tools
- Incudine node browser, DSP status and real-time audio metering
- Package, class, thread and trace browsers
- Compiler diagnostics and inline values
- Marketplace metadata, release icon and documentation

### References

- CLAMPS: https://codeberg.org/ormf/clamps
- Incudine: https://github.com/titola/incudine
