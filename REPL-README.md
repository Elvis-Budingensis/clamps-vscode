# CLAMPS terminal REPL

The REPL is implemented as a `vscode.Pseudoterminal` and evaluates code over
`clamps/eval` in the same running Swank/SBCL session.

## Usage

- `CLAMPS: Open REPL`
- `Enter`: evaluate the current buffer
- `Ctrl+J`: insert a newline
- `Arrow up/down`: history
- `Arrow left/right`: move the cursor
- `Backspace`: delete a character
- `Ctrl+C`: discard the current input
- `Ctrl+L`: clear the terminal
- `Cmd+Enter`/`Ctrl+Enter` in a Lisp editor: evaluate the selection or the current line

## Lifecycle fix

Start, stop and restart all run through a single promise queue. Restart does
not enqueue a second queue entry from within a queue entry that is already
running. In addition, a LanguageClient in state `Starting` is only stopped
once the start attempt has completed. That avoids the error
`Client is not running and can't be stopped ... state is: starting`.

## New image tools

- **Stepping:** VS Code's step into/over/out calls `swank:sldb-step`,
  `swank:sldb-next` and `swank:sldb-out`. The Lisp code in question has to be
  compiled with a high debug quality, for instance with
  `(declaim (optimize (debug 3) (speed 0) (safety 3)))`.
- **Compiler diagnostics:** when a Lisp file is saved, Swank's compiler notes
  are carried into VS Code's problems view. Can be switched off with
  `clamps.compilerDiagnosticsOnSave`.
- **Image browsers:** the CLAMPS sidebar now contains packages, classes and
  threads. A click hands the entry over to the object inspector.

## Inspector history and recursive inspector (v77)

The object inspector has a browser history with back, forward and a direct
history pick list. Navigable parts additionally have an arrow: it expands the
subobject inline without leaving the current page. Subobjects can be expanded
further, up to eight levels deep. Self-references and other cycles are
recognised and shown as a back reference to the object ID that is already
visible.

A click on the name still navigates into the object in the classic way; the
arrow is exclusively for the recursive tree view.

## Bugs fixed from v76/v77 (v78)

The three additions from v76/v77 were without effect or wrong in the version
that shipped. All three bugs were visible only against a running image, and
that is exactly what did not run: the test suite knew neither `xref` nor the
recursive expansion, and `check.py` counts parens and names, not semantics.

- **XREF entirely dead apart from definitions.** `xref-for-repl` passed
  `resolve-symbol` the package name as a string. `resolve-symbol` binds
  `*package*` to that argument, and SBCL declares `*package*` to be of type
  `PACKAGE` — the type error was silently swallowed into `NIL`. `swank:xref`
  was never called; callers, callees, references, bindings, setters and
  macroexpansions stubbornly reported "symbol not found". Now a package
  object goes in, as at all six other call sites.
- **Jump target still at the start of the file.** `%tool-entry` set `:line`
  to 1 when the backend supplies no line. The client preferred the line over
  the offset, and the character offset standing correctly next to it went
  unused — with SBCL the normal case, because source locations almost always
  contain only `(:position N)`. `:line` now stays `NIL`, and the client
  conversely prefers the offset.
- **Cycle detection could never trigger.** `%inspect-register` handed out a
  new ID for the same object on every entry. The client recognises cycles by
  the ID of a subobject already appearing in the chain of ancestors — which
  could never be true that way. An `eq` reverse table now supplies stable
  IDs; it is carried along in the FIFO eviction and when releasing.

Also:

- Labels are escaped in attributes too (`"` and `'`). String keys of a hash
  table come from `prin1-to-string` and are therefore always `"key"` — that
  broke `data-label="…"` open. In the webview, which is allowed to run
  scripts and lets Lisp be evaluated over the set message, that was more than
  a display bug.
- The expand arrow appears only on parts that have parts themselves. The
  image supplies an `expandable` field for this; if it is missing (an older
  image), the old behaviour remains.
- Every level has its own filter. Previously each one carried the same
  `id="filter"`, so that only the topmost field reacted at all, and it also
  hid rows in expanded subobjects.
- The inspect fallback path of an XREF hit works. `swank:xref` delivers names
  as strings; the old `symbolp` test was always false.
- A missing Swank package yields the intended message instead of a package
  type error.
- A second XREF search while one is running is reported instead of being
  discarded without comment.
- `resolve-symbol` no longer interns symbols. A typo used to create a new
  symbol in the package via `read-from-string` and return it as if it had
  been found.
- `loadcheck.lisp` no longer turns `#:foo` into the read-time conditional
  `#-foo`. The bug was latent, because up to then `#:` only occurred in files
  that are readable without rewriting.

New gates: `sbcl --script lisp/test-xref.lisp` and `node test/xref.test.js`,
both wired into `npm run gates`. Against the state of v77 they fail.

## Multi-line input to Swank (v79)

Multi-line code arrived in the image mangled as soon as it went through the
debugger — and that is the normal case, because `clamps.replUsesDebugger` is
`true`. Every newline became the letter `n`:

```text
(dsp! simple (freq amp)          ->  (dsp! simple (freq amp)
  (with-samples ((in (sine …))))      n (with-samples ((in (sine …)))
    (out in in)))                     n (out in in))
```

SBCL thereupon reported `undefined variable: n` or `The variable n is
unbound` — on a symbol that appears nowhere in the source.

The cause was `JSON.stringify` being used to build Lisp string literals.
Inside strings the Lisp reader knows only `\\` and `\"`; every other `\x` it
reads as the bare character `x`. So `\n` became `n`, `\t` became `t`. Because
backslash and quotation mark are escaped identically in JSON and in Lisp, it
never showed up with single-line input.

`lispString` in `swank.ts` already did it correctly, but was used in only
three places. Now every string that goes over the wire as Lisp source passes
through it:

- REPL evaluation in the debugger (`eval-for-repl-debuggable`)
- the debug console and hover (`eval-and-grab-output`, `eval-string-in-frame`)
- `return-from-frame`, and the binding of values for the inspector
- `printSexpr`, and with it `:emacs-rex` and `:emacs-return-string`

A real newline needs no escaping: it is valid inside a Lisp string literal,
and the Swank frame counts bytes.

Only the route through the debugger was affected. The bridge always built its
forms with `~S`, which is why the same input worked with
`clamps.replUsesDebugger: false` — and that was also the proof of the cause.

New gate: `node test/lispstring.test.js`. It checks the escaping and
statically forbids `JSON.stringify` in forms with Lisp syntax.

## Autodoc and XREF navigation

- While typing inside a function form, VS Code shows the lambda list as
  signature help.
- The active parameter is marked on the basis of the current Lisp form.
- `Go to definition` still uses the Swank source locations.
- `Find references` is now also available as a native LSP command.
- `Alt+-` jumps back to the origin of the last CLAMPS XREF jump.
- `Alt+Shift+-` moves forward again in the CLAMPS XREF history.

Autodoc lives additively in `lisp/autodoc.lisp`. If the module cannot be
loaded, the REPL, completion, the debugger and the previous XREF search stay
active.

## Freq scope (1.0.1)

`CLAMPS: Show Spectrum (Freq Scope)` opens a real-time spectrum of a sticker
ring, modelled on SuperCollider's FreqScope: logarithmic or linear frequency
axis, decibels vertically, peak hold with fall, and a cursor readout in hertz
with the nearest note name and cent deviation.

The FFT runs in Lisp (`sticker-spectrum-for-repl`), not in the webview, and
what is transferred is one number per drawn column. The alternative — fetching
samples and computing in the webview — would need, at 2048 points and 20
frames per second, some 41 000 values per second down a wire that writes every
number as text, because the analysis windows overlap. This way the amount of
data depends on the window width in pixels rather than on the sample rate and
the FFT size.

A ring for the scope has to be undecimated and hold at least the FFT length:

```lisp
(defparameter *scope* (clamps-bridge-rpc:make-sticker-sample-state-for-repl 4096 1))
(clamps-bridge-rpc:register-sticker-state-for-repl "scope" *scope*)
```

and unconditionally in the `dsp!` body:

```lisp
(dsp! simple (freq amp)
  (with-samples ((in (sine freq amp 0)))
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl *scope* in)
    (out in in)))
```

A level meter ring will **not** do. Those are created with a decimation of
441 and a capacity of 256, which fails on both counts — too small for the FFT,
and decimated. Since a meter ring is what a session usually already holds, it
is also the one most likely to be tried first; the selector therefore marks
unusable rings with the reason.

Three situations are named rather than silently accepted, because a spectrum
always looks plausible:

- A **decimated ring** is computed with the correct effective rate and marked
  with a warning. Without a pre-filter, decimation folds everything above half
  the effective rate back down, where it stands like a genuine partial. That
  cannot be undone, so it has to be stated.
- Without Incudine the **sample rate** is unknown; 48 000 Hz is then used as a
  fallback and the display says so. A frequency axis that is scaled wrongly
  and does not say that it might be is worse than none at all.
- **Non-finite samples** are counted as 0 and reported. A feedback loop
  running away produces NaN, and a single NaN colours the whole FFT: without
  this handling the display would show silence at exactly the moment when one
  is looking.

New gates: `sbcl --script lisp/test-spectrum.lisp` checks the FFT against a
naive DFT, the level accuracy of all three window functions, sub-bin frequency
interpolation and the column reduction; `node test/freqscope.test.js` checks
the note names, the peak hold and that the frequency axis is computed
identically in `rpc.lisp`, in `freqScope.ts` and in the webview twin.

## Live spectrogram (1.0.4)

`CLAMPS: Show Spectrogram (frequency over time)` shows frequency vertically,
time scrolling to the left and level as colour. Hovering reads off frequency,
note name and how long ago the column was recorded.

Technically it is the same FFT as the freq scope — literally the same, because
the windowing, transform, peak interpolation and column reduction live in
`%spectrum-of-samples`, which both call. What differs is the handling of time,
and that is the point of the view.

The frames sit on an absolute grid: frame *F* covers the samples
`[F*hop - fftSize, F*hop)`. Several frames arrive per request; the view names
the last index it received and Lisp answers with what is missing. So:

- One column is exactly `hop/rate` seconds. Asking for one spectrum per drawn
  frame instead would make the column spacing whatever the round trip happened
  to take, and the time axis would carry no unit.
- Frames cannot be duplicated or silently lost. What fell out of the ring is
  counted and reported, because a gap misdates everything to the right of it
  and is invisible in the picture.
- Time resolution and update rate are independent: eight frames per request at
  20 requests a second gives 160 columns of axis per second over 20 messages.

The **hop** is the time resolution and the FFT length the frequency
resolution; the two trade off against each other. A hop of a quarter of the
window is the usual compromise. Note that the update rate follows from the
hop: at a hop of 64 the analysis produces 750 frames a second, and the request
cycle is shortened accordingly, because at most 64 frames fit in one answer.

A spectrogram needs **more ring headroom than the scope** — at least twice the
FFT length — because between two requests the ring has to keep the frames
accrued in the meantime:

```lisp
(defparameter *scope* (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8192 1))
(clamps-bridge-rpc:register-sticker-state-for-repl "scope" *scope*)
```

New gates: the frame grid is checked in `lisp/test-spectrum.lisp` against a
signal that steps in frequency every hop, so that each frame's peak says which
segment it saw; `test/spectrogram.test.js` checks the ring requirement, that a
request covers what accrues, that the colour ramp never darkens as the level
rises, and that low frequencies are drawn at the bottom.

## Buffer waveform viewer (1.0.6)

`CLAMPS: Show Buffer Waveform` displays an Incudine buffer. It takes the
selection, the symbol at the cursor, or asks. Mouse wheel zooms towards the
pointer, the arrow buttons scroll, and the cursor reads off time and frame
number.

The reduction happens in the image: three numbers per drawn column — minimum,
maximum and RMS. An eight-minute recording is twenty million samples and the
canvas is eight hundred pixels wide.

Two decisions look like details and are not:

- **Minimum and maximum, not maximum.** The spectrum reduces by maximum, which
  is right for a partial. A waveform reduced that way loses its lower half and
  a symmetric signal comes out as a one-sided envelope — it still looks like a
  waveform, which is what makes the mistake durable. With both, a DC offset is
  visible as an envelope that does not straddle zero.
- **Every sample is examined.** Reading every Nth sample is the obvious
  shortcut and it defeats the purpose: a single clipped sample between two
  steps is invisible, and a click is nothing but that.

The envelope is drawn first and the RMS on top of it. The gap between them is
the dynamic range: a compressed passage and a loud one have the same envelope
and different bodies.

Any vector of numbers works too, not only an Incudine buffer — which is what
makes the reduction testable against a bare SBCL, without Incudine, without an
audio device and without a sound file. Without a buffer there is no sample
rate, and the axis then says frames rather than inventing seconds.

Gates: `lisp/test-buffer.lisp` uses signals in which a wrong reduction is
arithmetically detectable — an asymmetric waveform, a single spike among a
hundred thousand quiet samples, a DC offset — and catches both shortcuts above
when they are introduced deliberately. `test/buffer.test.js` covers the zoom,
whose failures are invisible in any single picture.

## ATS browser (1.1.0)

`CLAMPS: Show ATS Analysis` opens an `.ats` file and draws its tracked
partials over time, each as its own line, with the residual noise bands
underneath. Hovering singles out the nearest partial and gives its number,
frequency, note name and level at that instant.

This is what an ATS analysis has over a spectrogram: the partials are already
tracked, so one of them can be followed on its own. A partial is drawn as a
line rather than as a smear of bins, and that makes visible what matters in a
tracked analysis — where a partial begins and ends, where the tracker lost it
and picked it up again elsewhere, whether an apparent glissando is one
trajectory or two.

A gap stays a gap. Where the tracker had no partial, no line is drawn;
bridging it would invent a trajectory, and a straight line through a silence
looks exactly like a partial that was there.

The caption states the analysis window and the frequency resolution that
follows from it. That figure says which distinctions in the picture are real:
partials closer together than the window allows cannot have been separated, so
two lines that nearly touch may be one partial the tracker split.

All four ATS types are read, and both byte orders — the magic number at the
head of the file reveals which. If the header and the file length disagree,
nothing is displayed and both figures are reported: every number after the
header sits at a computed offset, so a wrong layout produces plausible
frequencies and amplitudes and draws a convincing analysis of a sound that is
not in the file.

## Sample browser (1.3.0)

`CLAMPS: Browse Samples` lists the sound files of a folder with format,
channels, sample rate, bit depth, duration and size. Any column sorts; a click
on a row opens that file's waveform.

Only the headers are read — a folder of samples is gigabytes and everything in
the table is in the first few hundred bytes of each file.

WAV and AIFF are both read, including AIFF's 80-bit extended sample rate. That
last point is the one worth knowing about: it is a format nothing else uses,
and a sloppy decoder gets it almost right. 44099.99 instead of 44100 passes
every glance and then makes every duration and every resampling ratio subtly
wrong.

Files whose header cannot be read appear in the list marked with a question
mark rather than being dropped. Fractional sample rates are shown in full
instead of rounded, because a rate that is not a whole number of hertz almost
always means something upstream resampled the file.
