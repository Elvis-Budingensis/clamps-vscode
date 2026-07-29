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
(clamps-bridge-rpc:sticker-state-record-sample-for-repl *scope* sig)
```

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
