# Changelog

All notable changes to CLAMPS for VS Code are documented here.

## [1.2.1] - 2026-07-30

### Fixed

- **ATS playback called ats-cuda wrongly, and then blamed the wrong
  function for it.** Read off a working session:

      (ats-load "/tmp/cl.ats" 'cl-new)
      (sin-noi-synth 0.0 cl-new :amp-scale 0.2)

  Two things had been guessed wrongly. `ats-load` takes the path AND a
  symbol to bind the loaded sound to, and returns the symbol rather than the
  sound; it was being called with the path alone. And the start time is a
  FLOAT — `sin-noi-synth` schedules on it, so an integer 0 is not the same
  thing.

  Worse than either was the report. The loader's `invalid number of
  arguments: 1` was caught by an outer handler and shown as
  `ATS-CUDA::SIN-NOI-SYNTH failed`, pointing at a function that was
  perfectly fine. Half an hour can be lost to a message that names the wrong
  thing. Each attempt is now recorded with its own error, and a loader
  failure is reported as one.

  Several conventions are still tried in turn, since they differ between
  ats-cuda versions, and the message names the one that worked so that a
  working setup can be reproduced.

- New gate coverage for exactly this. Stand-in packages provide an
  `ats-load` and a `sin-noi-synth` that fail in known ways, so the report can
  be checked without Incudine: a refusing loader must be named as the loader
  and must NOT blame the synthesis; a refusing synthesis must list every
  argument list attempted; and a working stand-in rejects an integer start
  time, so the float is checked by the test passing at all. Reintroducing
  either fault fails the gate with 6 and 1 failures respectively.

## [1.2.0] - 2026-07-30

### Added

- **Play and Stop in the ATS browser.** The analysis on screen can be handed
  to the image's resynthesis and heard.

  The extension does NOT synthesise. Turning partials back into sound is
  Incudine's and ats-cuda's job; they do it in the audio thread with their
  own oscillator banks and their own noise model. A second implementation
  inside an editor extension would be a worse one, and worse in a way nobody
  would notice until a piece sounded subtly different from the analysis it
  came from.

  So the functions are looked up at runtime, across `ats-cuda`, `ats`,
  `clamps`, `incudine` and `cl-user`, with several candidate names each,
  because they differ between versions. `sin-noi-synth` is preferred over the
  purely sinusoidal variants: those leave out precisely the residual noise an
  ATS analysis separated out with some effort. Several argument lists are
  tried in turn rather than one being assumed, since a wrong arity would
  otherwise surface as "invalid number of arguments" with no hint of which
  function was meant.

  When nothing is found, the message names every candidate that was searched
  for and every package that exists — "not available" on its own would leave
  nothing to act on. A file that is not an ATS file is refused before that
  search, so the user is told about the file they picked rather than about
  missing packages.

  Stop frees node 0, which is what CLAMPS's own examples do. That this stops
  ALL running nodes and not only the playback is stated in the message rather
  than hidden: a button that silently kills a running piece would be worse
  than no button.

**Untested against real audio.** There is no Incudine and no audio device in
the environment this was written in, so what is verified is the file
handling, the discovery and every failure path — the gate runs precisely
where nothing is available, so it always exercises them. Whether the
resynthesis itself sounds right can only be judged at your machine.

## [1.1.3] - 2026-07-30

### Added

- **The spectrogram now has a labelled frequency axis**, and time marks
  counted back in seconds from the right edge, which is the present. It
  shipped without either: a bright line at some height says nothing until one
  can tell which frequency that height is, so the picture was an image rather
  than an instrument. The freq scope and the ATS browser have had labelled
  axes from the beginning, which is exactly why the omission was invisible
  from inside — it took a screenshot of a tone whose frequency could not be
  read off the image of it.

  The axis sits on a canvas of its own. The spectrogram scrolls itself with
  `drawImage`, so grid lines drawn onto it would scroll away with the picture
  and leave a trail of old axes marching leftwards. The labels carry a dark
  backing, because white text on a bright spectrogram is unreadable precisely
  where the interesting parts are.

## [1.1.2] - 2026-07-30

### Fixed

- **Residual noise bands above the file's highest frequency piled up on the
  top edge.** The y mapping clamps to the visible range, so every Bark band
  between an analysis's highest partial and the 20 kHz the scale reaches
  collapsed onto the same line, was inflated to a minimum height of one
  pixel, and stacked its opacity there — a bright bar along the top of every
  picture, made of bands the file says nothing about. Since most analyses
  stop well below 20 kHz, this was the normal case rather than an edge one.
  Bands lying outside the axis are now skipped, and bands crossing its edge
  are clipped rather than clamped.

- **The noise covered the partials.** Drawn at 0.35 opacity it washed them
  out, and a view whose whole purpose is to follow ONE partial could not show
  one. It is now dimmer and scaled quadratically with level, so that it reads
  as context rather than as a second subject.

Both were visible only in a picture of a real analysis; no gate would have
found either, because both produce a perfectly plausible image. They are now
guarded, and both guards were checked by reintroducing the faults.

## [1.1.1] - 2026-07-30

### Changed

- **Verified against a real ATS analysis** (a clarinet, type 4, 18 partials,
  253 frames). The assumed layout proved exact: 1 + 18x3 + 25 = 80 doubles
  per frame, times 253 frames plus 10 header doubles = 162000 bytes, the
  file's length to the byte. The contents are independently coherent as well
  — the partials are harmonics 1 to 18 of 261.5 Hz, and the even ones are an
  order of magnitude weaker than the odd ones, which is the signature of a
  cylindrical bore closed at one end. A misread layout could not produce
  that.

- **Residual noise now uses the real Bark edges** instead of a logarithmic
  approximation. The previous spacing ran logarithmically from 20 Hz to the
  maximum frequency, which is close enough to look right and wrong everywhere
  in particular: the Bark scale is near-linear below 500 Hz and only then
  turns logarithmic, so the low bands were squeezed and the high ones
  stretched, and the noise was drawn beside the partials it belongs to.

- **The header is cross-checked against the frames.** `max-amplitude` and
  `max-frequency` are stated in the header and also follow from the frames,
  so the two must agree; where they do not, the display says so rather than
  choosing one. In the clarinet file they agree exactly — 0.19513 is the peak
  of partial 6, 4712.83 the mean frequency of partial 17.

  The limits of the check are recorded next to it as plainly as its use:
  swapping amplitude and frequency is caught, a frame offset wrong by one is
  not, because in a sustained sound the maximum barely moves between
  neighbouring frames. It is a cross-check, not a proof, and a comment
  claiming otherwise would be the same false confidence it exists to prevent.

### Fixed

- The ATS gate's own file writer filled `max-amplitude` and `max-frequency`
  with round numbers, so every file it produced contradicted its own header.
  The new cross-check complained about all of them — the test was wrong and
  the check was right. The writer now computes both from the data it writes.

## [1.1.0] - 2026-07-30

### Added

- **ATS browser** (`CLAMPS: Show ATS Analysis`): the tracked partials of an
  ATS analysis over time, each as its own line, with residual noise in its
  25 critical bands underneath. Hovering singles out the nearest partial and
  reads off its number, frequency, note name and level at that moment.

  The difference from the spectrogram is not the picture but what is behind
  it. A spectrogram shows a grid of bins and leaves the partials to the eye;
  an ATS file already knows them. So this view can do the one thing a
  spectrogram cannot — follow a single partial and give its numbers.

  A partial is therefore drawn as a LINE, not as a smear of bins, and a gap
  stays a gap: where the tracker had no partial, no line is drawn. Bridging
  it would invent a trajectory, and a straight line through a silence looks
  exactly like a partial that was there.

  The reader covers all four ATS types and both byte orders — the magic
  number 123.0 at the head of the file exists to reveal which. Residual noise
  is drawn separately and dimmer, because a noise band and a partial are not
  comparable objects, and that separation is the point of the format.

- **A wrong layout is refused rather than interpreted.** Every number after
  the header sits at a computed offset; get the stride wrong by one and the
  file still reads, still yields plausible frequencies and amplitudes, and
  draws a convincing analysis of a sound that is not in it. The header
  determines the file length exactly, so a mismatch is detectable — and is
  reported with both figures instead of shown.

- The reduction keeps the LOUDEST frame of a column, for frequency and
  amplitude together. Averaging would be wrong in a way that is hard to see:
  where a partial dies away and is reborn at another frequency, the mean
  lands between the two and draws a line through a place the partial never
  was.

  Partials are sorted by peak amplitude, cut off, and returned in index
  order; how many were dropped is stated. Silently showing the first 128 of a
  thousand would misrepresent the analysis.

- New gate `lisp/test-ats.lisp`. It is the only test in the project whose
  expected answer is known exactly, because ATS is a defined binary format
  and the test writes its own files — deliberately with a writer that shares
  no code with the reader, since a writer derived from the reader's idea of
  the layout would agree with it however wrong both were. Three deliberate
  mutations (stride ignoring the type, frequency offset shifted by one,
  length check removed) are caught with 4, 29 and 7 failures.

## [1.0.8] - 2026-07-30

### Fixed

- **The buffer viewer looked in the wrong package.** The REPL carries its own
  current package; a file's package comes from its last `(in-package ...)`
  form, and a scratch file usually has none, so it falls back to
  `COMMON-LISP-USER`. Define a buffer at a `CLAMPS>` prompt, put the cursor on
  its name in that file, and the viewer reported "the variable *buf* is
  unbound" — truthfully, about a different symbol of the same name. Both sides
  were right and there was no way forward.

  An unqualified symbol that is unbound in the file's package is now looked
  for in the others, and the display states where it was found rather than
  taking it silently: two variables of the same name in two packages is a
  normal situation, and which one is on screen must not be a guess.

  The search happens only for a BARE name and only after the lookup in the
  named package has failed. A qualified name means what it says. That
  distinction has to be made on the source text, not on the form read from it
  — `cl-user::*x*` reads as an ordinary symbol, and by then there is nothing
  left to tell that a package was named. The gate caught exactly that.

## [1.0.7] - 2026-07-30

### Fixed

- **The REPL printed return values without a limit.** Evaluating
  `(defparameter *buf* (make-array 100000 :element-type 'double-float ...))`
  returns the array, and the REPL printed all hundred thousand elements —
  some 800 kilobytes through the bridge, into the terminal, and past the
  scrollback, so that the input which caused it had scrolled away. A REPL
  that punishes you for making a buffer is a REPL you stop using for
  buffers. Return values are now printed with `*print-length*` 500 and
  `*print-level*` 8.

  The cap sits around the PRINTING of the result, not around the
  evaluation: code that prints for itself — a `format` in a loop, a trace,
  a `describe` — is the user's own output and must not be truncated behind
  their back. Common Lisp marks the cut with `...`, so nothing goes missing
  silently.

  The inspector had capped its previews since the beginning (`*print-length*`
  6 for slot previews, 100 for the printed form). The REPL did not, and the
  difference went unnoticed because nobody had returned a large array to it.

## [1.0.6] - 2026-07-30

### Added

- **Buffer waveform viewer** (`CLAMPS: Show Buffer Waveform`): the waveform of
  an Incudine buffer with zoom, scroll, per-channel display and a cursor
  readout in time and frames. Peak and RMS over the visible range, and a
  warning when samples reach full scale.

  The reduction happens in the image (`buffer-outline-for-repl`): three
  numbers per drawn column, minimum, maximum and RMS. An eight-minute
  recording is twenty million samples and a canvas is eight hundred pixels
  wide; whatever were transferred, almost all of it would be discarded at the
  far end.

  Two decisions look like details and are not:

  - **Minimum AND maximum, not maximum.** The spectrum reduces by maximum,
    which is right for a partial. A waveform reduced that way loses its lower
    half, and a symmetric signal comes out as a one-sided envelope — it still
    looks like a waveform, which is what makes the mistake durable. With both,
    a DC offset shows as an envelope that does not straddle zero.
  - **Every sample is examined, none stepped over.** Decimating by reading
    every Nth sample is the obvious shortcut and it defeats the purpose: a
    single clipped sample between two steps is invisible, and a click is
    nothing but that.

  The gate mutates both of these and catches them with 64 and 194 failures
  respectively, using signals in which a wrong reduction is arithmetically
  detectable rather than merely ugly.

### Fixed

- **The zoom range crept.** Ten steps in and ten out came back 479 frames away
  from the start. The cause was not the zoom arithmetic but feeding its
  rounded result back into the next call: every step lands on a whole frame,
  the error is tiny, and it accumulates. The view now keeps its range in
  fractional frames and rounds once, at the moment of the request; nothing
  rounded ever flows back.

  Two intermediate attempts are worth recording, because both looked like
  fixes: discrete zoom levels reduced the drift from 479 frames to 3 per
  cycle, and 3 frames out of 100000 looks exactly like rounding. It was still
  a bug, and the gate proves it by running the cycle twice with different
  counts — 3 frames after one cycle and 24 after eight is not rounding, it is
  creep. A range that creeps sideways is a perfectly good waveform at every
  single moment; only the sequence is wrong, and no screenshot shows it.

## [1.0.5] - 2026-07-30

### Fixed

- **The freq scope's level readout was systematically too low.** The quadratic
  interpolation over the neighbouring bins corrected the FREQUENCY but the
  level was read off the raw bin. A tone that does not fall on a bin centre
  sits in the flank of the window and its bin is therefore too quiet: about
  0.6 dB at a third of a bin, up to 1.4 dB at half a bin with Hann. A sine of
  amplitude 0.2 read −14.6 dBFS where −13.98 is right. The apex of the same
  parabola gives the level, and it is now used, clamped so that an
  interpolation cannot report more than full scale.

  The correction is an approximation, not an identity — parabolic
  interpolation in dB overestimates by roughly 0.3 dB at half a bin, because a
  window's mainlobe is not a parabola. The gate's tolerance says so rather
  than pretending otherwise, and additionally checks that the value at half a
  bin is BETTER than the raw bin, so that a version which drops the correction
  again cannot pass on a loose tolerance.

  The existing level checks used a 0.2 dB tolerance but only for tones on bin
  centres, where the error is exactly zero. That is why they never fired, and
  why this was found in a screenshot rather than by a test.

- **The spectrogram assumed a sample rate of 48000.** The rate is 44100 in a
  real session, which makes the frame accounting 9 % optimistic — enough to
  drop a frame per request at a small hop, invisibly, because the picture
  keeps scrolling. The rate reported by the image is now adopted from the
  first answer onwards and the cycle re-timed accordingly.

## [1.0.4] - 2026-07-30

### Added

- **Live spectrogram** (`CLAMPS: Show Spectrogram (frequency over time)`):
  frequency vertically, time scrolling to the left, level as colour, with a
  cursor readout in hertz, note name and seconds ago.

  The frames sit on an **absolute grid**: frame F covers the samples
  `[F*hop - fftSize, F*hop)`. Several arrive per request, the view names the
  last index it received, and Lisp answers with what is missing. Three things
  follow, and they are the reason for the arrangement:

  - One column is exactly `hop/rate` seconds, so the time axis has a unit.
    Asking for one spectrum per drawn frame would make the column spacing
    whatever the round trip happened to take — unlabelled and unlabellable.
  - Frames cannot be duplicated or silently lost. What fell out of the ring
    is counted and shown, because a gap in a spectrogram misdates everything
    to the right of it and cannot be seen.
  - Time resolution and update rate are independent: eight frames per request
    at 20 requests a second is 160 columns of axis per second over 20
    messages.

  New RPC `sticker-spectrogram-for-repl` and bridge method
  `clamps/stickerSpectrogram`; setting `clamps.spectrogramIntervalMs`.

- The poll interval follows the frame rate rather than the setting. At a hop
  of 64 the analysis produces 750 frames a second, so a configured 100 ms
  cannot be honoured: 75 frames would accrue where the protocol carries 64,
  and the remaining 11 would be dropped on every request — the view would
  slide about a second into the past per minute, with nothing in a scrolling
  picture to say that the right edge is no longer the present. The interval is
  therefore shortened until the backlog fits; the setting stays an upper
  bound. Found by the gate, not by looking.

### Changed

- The windowing, transform, peak interpolation and column reduction now live
  in one place (`%spectrum-of-samples`), used by both the scope and the
  spectrogram. Two implementations of one computation is the surest way to
  have the two place a partial in different rows, and to do so invisibly.
- The spectrogram requires more ring headroom than the scope — at least twice
  the FFT length — because between two requests the ring has to keep the
  frames accrued in the meantime. Rings that fall short are marked with the
  reason in the selector.

### Fixed

- `lisp/test-spectrum.lisp` checked frame indices and counts but never
  whether a frame's CONTENT belonged to its position, so a mutation that read
  every window from the newest end of the ring passed. The test signal was a
  steady sine, so every window looked alike and no content check could tell
  them apart — a test that runs, passes and checks nothing. The signal now
  steps in frequency every hop, and each frame's peak says which segment it
  saw.

## [1.0.3] - 2026-07-30

### Fixed

- **Structs showed no slots in the inspector.** `%struct-slot-names` went
  through `sb-kernel::layout-info`, which does not exist in SBCL 2.2.9 — it is
  called `wrapper-info` there. `find-symbol` returned `NIL`, the `funcall`
  signalled, a `handler-case` swallowed it, and the inspector presented every
  structure instance as having an empty list of parts. Not an error message:
  emptiness, which looks exactly like a struct that really has no slots. It
  worked on the SBCL the code was written against and was silently wrong on
  the next one. `sb-mop:class-slots` is now the primary path, the internal
  chain remains as a fallback trying both spellings, and if all of them fail
  the header carries a warning instead of showing nothing.

- **`lisp/test-inspect.lisp` printed `ERROR` and exited 0.** It was a smoke
  test: 80 forms, all of them printing, none of them comparing. The struct bug
  above was visible in its output the whole time and no gate read it — the same
  blind spot as a stripped comment. `setpart` now takes an expected outcome
  (four calls legitimately expect a refusal) and the file exits non-zero when
  one does not match.

- **The freq scope offered a level meter ring and then only complained.** A
  meter ring is decimated ×441 with a capacity of 256, so it can carry no
  spectrum — but it is also the ring already lying around in a session, and
  therefore the one tried first. The scope reported `Ring "meter" holds 256
  values, the FFT needs 2048` and stopped there; the recipe for a usable ring
  appeared only when no ring at all was registered. Unusable rings are now
  marked with the reason in the selector, a usable one is preferred when
  selecting, and the recipe appears whenever nothing can carry a spectrum.
  Changing the FFT size re-judges the list, because a ring that suffices for
  1024 does not for 4096.

### Changed

- The README states plainly that this extension is an independent third-party
  project, not developed, endorsed or supported by Orm Finnendahl (CLAMPS) or
  Tito Latini (Incudine), and that problems belong in its own issue tracker
  rather than with those projects.
- Remaining German developer output in the Lisp gates translated (`forms
  read`, `type-specific rendering`, `setting slots`, `edge cases` and the
  German test identifiers).

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
