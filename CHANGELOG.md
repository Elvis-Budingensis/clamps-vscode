# Changelog
All notable changes to CLAMPS for VS Code are documented here.

## [1.5.0] - 2026-08-13

### Fixed

- **`node_modules` is packaged again.** `.vscodeignore` carried a blanket
  `node_modules/**`, which overrode the production dependencies `vsce`
  includes by itself. The resulting `.vsix` shipped `out/` alone, so every
  one of the thirteen `require("vscode-languageclient/node")` calls in the
  compiled sources had nothing to resolve against: an install from the
  `.vsix` died on activation with `Cannot find module`, while F5 from the
  workspace kept working because `node_modules` sits next to it there.

  The bug had been in 1.4.8 and 1.4.9 and no gate saw it, because all of
  them examine the source tree and none examined the artefact.

- `brace-expansion` 2.1.2 → 2.1.4, reached through
  `vscode-languageclient` → `minimatch` (GHSA-mh99-v99m-4gvg,
  GHSA-rgw5-rvv9-x895). A lockfile change only; the patterns minimatch
  expands here come from the extension's own `documentSelector`.

### Added

- **Package gate** (`test/package.test.js`): unzips the built `.vsix`,
  collects every non-relative `require()` in `extension/out`, and resolves
  each one against the package. A module that is imported but not shipped
  now fails `npm run gates` instead of waiting for an install to break.

### Changed

- `lisp/rpc.fasl` is no longer shipped or tracked. `bootstrap.lisp` loads
  `rpc.lisp`, never the compiled file, so the 527 KB were a by-product of
  `loadcheck.lisp` — and a FASL is bound to the SBCL version that produced
  it, which would have failed on a mismatch rather than recompiling.
  Package size 1.01 MB → 812 KB.

## [1.4.8] - 2026-08-05

### Added

- **Scheduler status** (`CLAMPS: Show Scheduler Status`): how many events are
  pending, how full the EDF heap is, and the queue depth plotted over time.

  The heap figure is the one that decides whether a piece can be scheduled at
  all: a score with more events than the heap holds fails silently, and
  `*rt-edf-heap-size*` in `~/.incudinerc` is where that is raised. The gauge
  turns red before the heap is full, while there is still room to react.

  Everything is read in one synchronous `rt-eval` inside the realtime thread,
  where the heap the scheduler uses is the one that answers: `heap-count`
  reads whichever heap is currently bound, and outside the realtime thread
  that is not the one `at` writes to. `rt-eval` needs `:return-value-p t`,
  or it returns before its body has run.

  Every symbol in the probe carries two colons. `rt-eval` and `*sample-rate*`
  are internal to `INCUDINE` despite being documented, and a single colon on
  an internal symbol is a reader error that no handler can catch — which
  names a given Incudine version exports is not something the extension can
  know.

  Neither a countdown to the next event nor the reach of the queue is shown.
  `next-time` does not describe the heap that `heap-count` counts: measured
  against a running session it stays at one value while events are scheduled
  and after `flush-pending`, and its magnitude does not relate to `now` by
  the sample rate. Reported anyway it produced a countdown of "17579:24.3"
  for an event due in five seconds. Individual pending events are likewise
  absent, since Incudine offers no synchronised way to enumerate the queue.
  The window states both, so the absences are not read as unfinished work.

## [1.4.4] - 2026-08-02

### Added

- **OSC monitor** (`CLAMPS: Show OSC Monitor`): incoming messages with
  address, type tag and values, each value shown with its own type, plus an
  address filter and a settable port.

  The types are half the information. An integer 1 and a float 1.0 print
  alike and are not alike, a blob is not a string, and a receiver expecting
  `if` that gets `fi` fails without saying so — so the type tag stands next
  to the address and every value carries its own type and colour.

  The monitor reads the message out of the stream itself rather than
  registering a responder for a fixed address and type tag. A monitor exists
  to find out what is arriving; one that has to be told in advance answers a
  question nobody has.

  It opens a stream of its own on the chosen port rather than taking over an
  existing one, since two readers on one port is not something the protocol
  provides for. If the port is busy the message says so — usually the patch
  under test is already listening there, and then the monitor should be
  pointed at a free port with the patch forwarding to it.

  Blobs are shown by their length and long strings truncated: a megabyte of
  hex fills the window for a message whose interesting part is its size.

### Changed

- Recording into the OSC and MIDI rings returns the sequence number instead
  of the ring. Called by hand in the REPL, returning the structure printed
  the whole ring — 509 NILs around the entries one wanted to see, and for the
  MIDI ring four unboxed arrays of the full capacity. The sequence number is
  also the cursor for the next fetch.

### Fixed

- Recording an OSC message before the monitor is running now says what to do.
  The ring exists only while the monitor runs, so this is the ordinary
  mistake, and "the value nil is not of type osc-ring" is true and useless.

## [1.4.3] - 2026-07-31

### Changed

- The Marketplace page now describes the audio views — frequency scope,
  spectrogram, ATS browser, buffer waveform, sample browser and MIDI monitor —
  with a section each and a place for a screenshot. It previously described
  the extension as it was at 1.0.0.
- Added a short guide to setting up a sticker ring, which the scope,
  spectrogram and level meters read from.
- The freq scope and spectrogram show a short message when no ring is
  registered and a longer one only when a ring exists that cannot carry the
  analysis. The single long text was cut off in a narrow panel, and the
  reasoning about decimation is only useful in the second case.

### Fixed

- The buffer viewer reported a missing sample rate twice for a plain vector.

## [1.4.1] - 2026-07-31

### Added

- The MIDI monitor now receives from a running CLAMPS session. It attaches a
  responder to Incudine's raw MIDI reception, which sees every message —
  including pitch bend, program change and the system messages, which never
  reach cl-midictl's controller callbacks.

  Registered controllers are unaffected. The monitor adds exactly one
  responder and removes exactly that one; a receiver that was already running
  is left running when the window closes, since CLAMPS starts it during
  startup and its controllers depend on it.

  Where no MIDI input is configured, the ring is still created and the
  message names what was looked for, so the window can be exercised by hand.

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
- Documentation describes the software rather than its development history.

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
