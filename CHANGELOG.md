# Changelog

All notable changes to CLAMPS for VS Code are documented here.

## [1.4.1] - 2026-07-31

### Changed

- Changelog and documentation rewritten to describe the software rather than
  its development: no first-person narration, no accounts of earlier attempts,
  no test internals in files that ship to users.

## [1.4.0] - 2026-07-31

### Added

- **MIDI monitor** (`CLAMPS: Show MIDI Monitor`): incoming messages decoded,
  with timestamps, a per-channel activity strip and a filter for clock and
  active sensing. Dropped messages are counted and shown rather than passed
  over.

### Changed

- Marketplace keywords now name what the extension does: `ats`,
  `spectral analysis`, `spectrum`, `spectrogram`, `waveform`, `midi`,
  `computer music`.

### Fixed

- `midi-events-since-for-repl` could return more events than the ring holds,
  delivering the same slots twice as fresh messages.

## [1.3.1] - 2026-07-31

### Fixed

- ATS playback failed on files without residual noise. The synthesis is now
  chosen by the file's type — `sin-noi-synth` for types 3 and 4, `sin-synth`
  for 1 and 2 — and the message names which was used.

## [1.3.0] - 2026-07-30

### Added

- **Sample browser** (`CLAMPS: Browse Samples`): the sound files of a folder
  with format, channels, sample rate, bit depth, duration and size, sortable
  by any column. A click opens the waveform. Only headers are read, so a
  folder of gigabytes opens instantly.
- WAV and AIFF headers are read exactly, including AIFF's 80-bit extended
  sample rate. Chunks are walked rather than assumed at fixed offsets, so
  files carrying LIST, bext or JUNK before the format chunk are read
  correctly.
- Files with unreadable headers are listed and marked rather than omitted.
- Sample rates that are not a whole number of hertz are shown in full instead
  of rounded to kHz.

## [1.2.1] - 2026-07-30

### Fixed

- ATS playback called `ats-load` with the wrong number of arguments and
  attributed the resulting error to the synthesis function. Each attempt is
  now reported with its own error.

## [1.2.0] - 2026-07-30

### Added

- **Play and Stop in the ATS browser.** The analysis on screen can be handed
  to the image's resynthesis. The functions are resolved at runtime across
  `ats-cuda`, `ats`, `clamps` and `incudine`; when none is found, the message
  names every candidate that was searched for.

## [1.1.3] - 2026-07-30

### Added

- The spectrogram has a labelled frequency axis and time marks counted back
  from the right edge.

## [1.1.2] - 2026-07-30

### Fixed

- Residual noise bands above the file's highest frequency piled up on the top
  edge of the ATS browser; bands outside the axis are now skipped.
- The noise no longer covers the partials.

## [1.1.1] - 2026-07-30

### Changed

- Residual noise uses the standard Bark band edges instead of a logarithmic
  approximation.
- The ATS header is cross-checked against the frames; a disagreement is
  reported rather than resolved silently.

## [1.1.0] - 2026-07-30

### Added

- **ATS browser** (`CLAMPS: Show ATS Analysis`): the tracked partials of an
  analysis over time, each as its own line, with residual noise in its 25
  critical bands underneath. Hovering singles out the nearest partial and
  gives its number, frequency, note name and level.
- All four ATS types and both byte orders are read. When header and file
  length disagree, nothing is displayed and both figures are reported —
  a wrong layout produces plausible numbers and a convincing picture of a
  sound that is not in the file.

## [1.0.8] - 2026-07-30

### Fixed

- The buffer viewer looked up unqualified symbols in the file's package
  only. A name that is unbound there is now looked for in the others, and
  the display states where it was found.

## [1.0.7] - 2026-07-30

### Fixed

- The REPL printed return values without a limit; a 100000-element array
  filled the terminal and pushed the input that caused it out of the
  scrollback. Return values are capped; output printed by the code itself is
  not.

## [1.0.6] - 2026-07-30

### Added

- **Buffer waveform viewer** (`CLAMPS: Show Buffer Waveform`): the waveform of
  an Incudine buffer with zoom, scroll, per-channel display and a cursor
  readout. Each column carries minimum, maximum and RMS, so clipping and DC
  offset stay visible; every sample is examined rather than stepped over, so
  a single clipped sample is not lost.

### Fixed

- The zoom range crept sideways over repeated steps.

## [1.0.5] - 2026-07-30

### Fixed

- The freq scope's level readout was up to 1.4 dB too low for tones between
  bin centres. The peak interpolation now corrects the level as well as the
  frequency.
- The spectrogram assumed a sample rate of 48000; it now takes the rate from
  the image.

## [1.0.4] - 2026-07-30

### Added

- **Live spectrogram** (`CLAMPS: Show Spectrogram`): frequency vertically,
  time scrolling to the left, level as colour. Frames sit on an absolute
  grid, so one column is exactly hop/rate seconds and dropped frames are
  reported rather than leaving an invisible gap in time.

## [1.0.3] - 2026-07-30

### Fixed

- Structs showed no slots in the inspector on SBCL 2.2.9.
- The freq scope offered rings that cannot carry a spectrum without saying
  why; unusable rings are now marked with the reason.

### Changed

- The README states that this is an independent project, not developed,
  endorsed or supported by the CLAMPS or Incudine authors.

## [1.0.2] - 2026-07-29

### Added

- A gate guarding comment and docstring density against silent removal.

## [1.0.1] - 2026-07-29

### Added

- **Freq scope** (`CLAMPS: Show Spectrum`): a real-time spectrum of a sticker
  ring with logarithmic or linear frequency axis, peak hold, and a cursor
  readout in hertz with note name and cent deviation. The FFT runs in the
  Lisp image and transfers one number per drawn column.

### Changed

- The entire source is in English: comments, docstrings, log output and all
  user-facing strings.

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
