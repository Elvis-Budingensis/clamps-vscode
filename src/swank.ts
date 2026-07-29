// swank.ts
//
// A direct socket connection to Swank, alongside the bridge.
//
// Why not through bridge-server.lisp? The debugger lives on ASYNCHRONOUS
// pushes from the image: as soon as a condition is signalled, Swank
// sends (:debug thread level condition restarts frames conts) of its own
// accord. Our bridge only knows request/response and has no way to pass
// something like that on. A second, direct connection is cheaper than
// extending the bridge with a push channel — and it is exactly what Sly
// does too.
//
// The price of this decision: two connections to the same image each
// have their own *package*. This class therefore tracks its package
// itself, and the debug session synchronises it deliberately.

import * as net from 'net';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------
// S-expression reader
//
// Deliberately not the naive tokenizer: Swank sends character literals
// (#\() and escaped symbols (|foo bar|), on which plain paren counting
// fails. Symbols are kept as a class of their own so that the symbol NIL
// can be told apart from the string "nil" — in plists such as
// (:value nil) the difference carries meaning.
// ---------------------------------------------------------------------

export class Sym {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

export type SExpr = SExpr[] | Sym | string | number;

const SYM_TERMINATOR = /[\s()'`,";]/;

class Reader {
  private i = 0;
  constructor(private readonly s: string) {}

  private skip(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
      if (this.s[this.i] === ';') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
        continue;
      }
      return;
    }
  }

  read(): SExpr {
    this.skip();
    if (this.i >= this.s.length) return new Sym('nil');
    const c = this.s[this.i];

    if (c === '(') return this.readList();
    if (c === ')') {
      this.i++; // defensive: skip a stray paren
      return new Sym('nil');
    }
    if (c === '"') return this.readString();
    if (c === '|') return this.readPipedSymbol();
    if (c === "'" || c === '`') {
      this.i++;
      return [new Sym('quote'), this.read()];
    }
    if (c === ',') {
      this.i++;
      if (this.s[this.i] === '@') this.i++;
      return this.read();
    }
    if (c === '#') return this.readHash();
    return this.readAtom();
  }

  private readList(): SExpr[] {
    this.i++; // (
    const out: SExpr[] = [];
    for (;;) {
      this.skip();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] === ')') {
        this.i++;
        break;
      }
      // Dotted pair: (a . b). We simply append the rest. What is lost is
      // the information that the list is improper — in the Swank
      // messages we evaluate, that does not occur.
      if (this.s[this.i] === '.' && SYM_TERMINATOR.test(this.s[this.i + 1] ?? ' ')) {
        this.i++;
        out.push(this.read());
        continue;
      }
      out.push(this.read());
    }
    return out;
  }

  private readString(): string {
    this.i++; // "
    let out = '';
    while (this.i < this.s.length) {
      const ch = this.s[this.i++];
      if (ch === '\\') {
        out += this.s[this.i++] ?? '';
      } else if (ch === '"') {
        break;
      } else {
        out += ch;
      }
    }
    return out;
  }

  private readPipedSymbol(): Sym {
    this.i++; // |
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== '|') out += this.s[this.i++];
    this.i++; // |
    return new Sym(out);
  }

  private readHash(): SExpr {
    const next = this.s[this.i + 1];
    if (next === '(') {
      this.i++; // #
      return this.readList(); // treat a vector like a list
    }
    if (next === '\\') {
      // Character literal: #\a, #\Space, #\( — the paren must NOT count
      this.i += 2;
      let out = '';
      // at least one character, then optionally further name letters
      if (this.i < this.s.length) out += this.s[this.i++];
      while (this.i < this.s.length && /[A-Za-z0-9_-]/.test(this.s[this.i])) {
        out += this.s[this.i++];
      }
      return new Sym('#\\' + out);
    }
    // #p"...", #x1F, #b101, unknown: keep the prefix, read the rest
    this.i++; // #
    const tag = this.s[this.i++] ?? '';
    const rest = this.read();
    return new Sym('#' + tag + (typeof rest === 'string' ? JSON.stringify(rest) : String(rest)));
  }

  private readAtom(): SExpr {
    const start = this.i;
    while (this.i < this.s.length && !SYM_TERMINATOR.test(this.s[this.i])) this.i++;
    const text = this.s.slice(start, this.i);
    if (/^[+-]?\d+$/.test(text)) return parseInt(text, 10);
    if (/^[+-]?\d*\.\d+(?:[esfdlESFDL][+-]?\d+)?$/.test(text)) return parseFloat(text);
    return new Sym(text);
  }
}

export function parse(input: string): SExpr {
  return new Reader(input).read();
}

// --- Hilfsfunktionen ------------------------------------------------

export const isSym = (x: SExpr | undefined, name?: string): x is Sym =>
  x instanceof Sym && (name === undefined || x.name.toLowerCase() === name.toLowerCase());

export const isNil = (x: SExpr | undefined): boolean =>
  x === undefined || isSym(x, 'nil') || (Array.isArray(x) && x.length === 0);

/** Textual form of a value for display. */
export function text(x: SExpr | undefined): string {
  if (x === undefined) return '';
  if (x instanceof Sym) return isNil(x) ? '' : x.name;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return printSexpr(x);
  return String(x);
}

/**
 * Lisp notation, used among other things to send thread identifiers
 * back.
 *
 * Strings go through lispString, NOT through JSON.stringify: see there.
 */
export function printSexpr(x: SExpr): string {
  if (Array.isArray(x)) return `(${x.map(printSexpr).join(' ')})`;
  if (x instanceof Sym) return x.name;
  if (typeof x === 'string') return lispString(x);
  return String(x);
}

/** Value for a key from a plist such as (:name "x" :value "1"). */
export function plistGet(list: SExpr | undefined, key: string): SExpr | undefined {
  if (!Array.isArray(list)) return undefined;
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (isSym(list[i], key)) return list[i + 1];
  }
  return undefined;
}

export const asList = (x: SExpr | undefined): SExpr[] =>
  Array.isArray(x) ? x : [];

/**
 * Build a Lisp string literal from a text.
 *
 * Deliberately NOT JSON.stringify: that produces \n, \t, \uXXXX —
 * escapes the Lisp reader does not know. It reads `\n` as the character
 * `n`, which silently corrupts the string. Inside strings the Lisp
 * reader knows only \\ and \".
 *
 * Control characters need NO escaping: a real newline inside a Lisp
 * string literal is valid and survives reading, and the Swank frame
 * counts bytes, so it tolerates newlines in the body. This was exactly
 * what multi-line REPL input hung on: via JSON.stringify every newline
 * became the symbol `n`, so that a (dsp! …) spanning three lines failed
 * with "undefined variable: n".
 */
export function lispString(s: string): string {
  return `"${s.replace(/[\\"]/g, m => '\\' + m)}"`;
}

/**
 * Decides whether a hover text is sent to Lisp at all.
 * Returns the text to send, or undefined.
 *
 * With supportsEvaluateForHovers switched on, VS Code sends EVERYTHING
 * the mouse moves over — file names, words in comments, fragments.
 *
 * Rejected are:
 *  - too long: then the mouse is not over a symbol but over a selected
 *    passage. That belongs in the debug console
 *  - control characters: not because they could not be represented (see
 *    lispString), but because a multi-line text is no longer a mouse
 *    hover query but a selected passage — and that belongs in the debug
 *    console
 *  - `#.` — read-eval. Runs BEFORE any handler and must never happen out
 *    of a mouse movement
 *  - `#<` — objects that cannot be read back, of the sort found in the
 *    backtrace and in every error message
 *  - unbalanced parens and unterminated strings
 *
 * The last two points were the actual hole: ignore-errors only takes
 * effect at EVAL, but a reader error happens as early as reading.
 * Deliberately a pure function here, so that it can be checked without a
 * running Lisp image.
 */
export function hoverCandidate(raw: string, maxLength = 120): string | undefined {
  const s = raw.trim();
  if (!s || s.length > maxLength) return undefined;
  if (/[\u0000-\u001f]/.test(s)) return undefined;
  if (s.includes('#.') || s.includes('#<') || s.includes('#|')) return undefined;

  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '#' && s[i + 1] === '\\') { i += 2; continue; }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i++;
        i++;
      }
      if (i >= s.length) return undefined; // Zeichenkette offen
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return undefined;
  }
  return depth === 0 ? s : undefined;
}

/**
 * Splits a text into its top-level forms.
 *
 * Necessary because swank:eval-and-grab-output reads only the FIRST
 * form. Send two forms as one block and only the first runs, silently —
 * a bug that looks like "nothing happens". Takes strings, character
 * literals (#\( does not count), line comments and block comments into
 * account.
 */
export function splitTopLevelForms(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, i = 0;
  let inString = false, blockDepth = 0;

  const flush = (end: number) => {
    if (start >= 0) {
      const piece = text.slice(start, end).trim();
      if (piece) out.push(piece);
    }
    start = -1;
  };

  while (i < text.length) {
    const c = text[i];

    if (inString) {
      if (c === '\\') i += 2;
      else { if (c === '"') inString = false; i++; }
      continue;
    }
    if (blockDepth > 0) {
      if (c === '|' && text[i + 1] === '#') { blockDepth--; i += 2; continue; }
      if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
      i++;
      continue;
    }
    if (c === '#' && text[i + 1] === '\\') {
      if (start < 0) start = i;
      i += 3;
      continue;
    }
    if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { if (depth === 0 && start >= 0) flush(i); i++; continue; }

    if (start < 0) start = i;
    if (c === '"') { inString = true; i++; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') {
      depth--;
      i++;
      if (depth <= 0) { depth = 0; flush(i); }
      continue;
    }
    i++;
  }
  flush(text.length);
  return out;
}

// ---------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------

export class SwankError extends Error {
  constructor(readonly payload: SExpr) {
    super(`Swank: ${printSexpr(payload)}`);
  }
}

interface Pending {
  resolve: (x: SExpr) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class SwankClient extends EventEmitter {
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** The package last reported by the image (via :new-package). */
  packageName = 'COMMON-LISP-USER';

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  connect(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port }, () => resolve());
      this.socket = s;
      s.once('error', reject);
      s.on('data', b => {
        this.buffer = Buffer.concat([this.buffer, b]);
        this.drain();
      });
      s.on('error', e => this.emit('socketError', e));
      s.on('close', () => {
        this.rejectAll(new Error('Swank-Verbindung geschlossen.'));
        this.emit('close');
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  /**
   * Sends a form and waits for the answer. Every request gets its own ID
   * — fixed IDs (as in the prototype) collide as soon as two requests
   * are open at the same time.
   */
  /**
   * Sends a form and waits for the answer.
   *
   * onId is called with the assigned request ID before sending — this
   * lets the caller release EXACTLY that request from its deadline
   * (clearTimeout(id)) instead of clearing all deadlines wholesale.
   * Clearing wholesale was a real bug: it also left uninvolved requests
   * that happened to be open at the same time (threads, stack frames,
   * hover) without a timeout, so that a missing answer left them hanging
   * in pending forever.
   */
  rex(
    form: string,
    pkg = this.packageName,
    thread: SExpr = new Sym('t'),
    timeoutMs = 20000,
    onId?: (id: number) => void
  ): Promise<SExpr> {
    const id = this.nextId++;
    if (onId) onId(id);
    return new Promise((resolve, reject) => {
      // Without a deadline a request that is never answered stays open
      // forever — and the caller simply sees nothing. That is exactly
      // what happened when switching to listener-eval: no answer, no
      // error message, a mute window. A timeout turns the silence into a
      // statement.
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (!this.pending.has(id)) return;
            this.pending.delete(id);
            reject(new Error(
              `No answer from Swank after ${timeoutMs} ms to: ${form}`
            ));
          }, timeoutMs)
        : undefined;

      const done = (fn: (x: any) => void) => (x: any) => {
        const p = this.pending.get(id);
        if (p?.timer) clearTimeout(p.timer);
        fn(x);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), timer });
      try {
        this.send(`(:emacs-rex ${form} ${lispString(pkg)} ${printSexpr(thread)} ${id})`);
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Switch off all running deadlines.
   *
   * Once the Lisp debugger is open, Swank deliberately does not answer
   * the triggering request — it stays pending until a restart is
   * invoked. Without this call the timeout would then wrongly report an
   * error although everything is taking its course.
   */
  /**
   * Takes the deadline away from ONE request — the one that triggered
   * the debugger. Swank only answers it after a restart; without
   * releasing the deadline the timeout wrongly reported an error. All
   * other requests keep their deadline, so that missing answers do not
   * stay open forever.
   */
  clearRequestTimeout(id: number): void {
    const p = this.pending.get(id);
    if (p?.timer) {
      clearTimeout(p.timer);
      p.timer = undefined;
    }
  }

  /** Answer to a :read-string — otherwise the image waits forever. */
  emacsReturnString(thread: SExpr, tag: SExpr | undefined, value: string): void {
    this.send(
      `(:emacs-return-string ${printSexpr(thread)} ${printSexpr(tag ?? 1)} ${lispString(value)})`
    );
  }

  interrupt(thread: SExpr = new Sym('t')): void {
    this.send(`(:emacs-interrupt ${printSexpr(thread)})`);
  }

  private rejectAll(e: unknown): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private send(payload: string): void {
    if (!this.socket) throw new Error('Not connected to Swank.');
    this.emit('wire', '>>', payload);
    const body = Buffer.from(payload, 'utf8');
    // Swank frame: six hex digits giving the length of the body, then the body.
    const head = Buffer.from(body.length.toString(16).padStart(6, '0'), 'ascii');
    this.socket.write(Buffer.concat([head, body]));
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 6) return;
      const n = parseInt(this.buffer.subarray(0, 6).toString('ascii'), 16);
      if (!Number.isFinite(n) || n < 0) {
        this.emit('protocolError', new Error('Invalid Swank header'));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 6 + n) return;
      const body = this.buffer.subarray(6, 6 + n).toString('utf8');
      this.buffer = this.buffer.subarray(6 + n);
      this.emit('wire', '<<', body);
      try {
        this.route(parse(body));
      } catch (e) {
        this.emit('protocolError', e, body);
      }
    }
  }

  private route(msg: SExpr): void {
    if (!Array.isArray(msg) || msg.length === 0) return;
    const tag = text(msg[0]).toLowerCase();

    if (tag === ':return') {
      const id = Number(msg[2]);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      const payload = msg[1];
      if (Array.isArray(payload) && isSym(payload[0], ':ok')) {
        p.resolve(payload.length === 2 ? payload[1] : payload.slice(1));
      } else {
        p.reject(new SwankError(payload));
      }
      return;
    }

    if (tag === ':new-package') {
      this.packageName = text(msg[1]) || this.packageName;
    }

    this.emit('message', msg);
    switch (tag) {
      case ':debug':          this.emit('debug', msg); break;
      case ':debug-activate': this.emit('debugActivate', msg); break;
      case ':debug-return':   this.emit('debugReturn', msg); break;
      case ':write-string':   this.emit('writeString', msg); break;
      case ':read-string':    this.emit('readString', msg); break;
      case ':new-package':    this.emit('newPackage', msg); break;
    }
  }
}
