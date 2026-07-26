// swank.ts
//
// Direkte Socket-Verbindung zu Swank, parallel zur Bridge.
//
// Warum nicht über bridge-server.lisp? Der Debugger lebt von
// ASYNCHRONEN Pushes aus dem Image: sobald eine Condition signalisiert
// wird, schickt Swank von sich aus (:debug thread level condition
// restarts frames conts). Unsere Bridge kennt nur Anfrage/Antwort und
// hat keinen Weg, so etwas weiterzureichen. Eine zweite, direkte
// Verbindung ist billiger als die Bridge um einen Push-Kanal zu
// erweitern — und sie ist genau das, was Sly auch tut.
//
// Preis dieser Entscheidung: zwei Verbindungen zum selben Image haben
// je ein eigenes *package*. Deshalb hält diese Klasse ihr Paket selbst
// nach und die Debug-Session synchronisiert es bewusst.

import * as net from 'net';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------
// S-Expression-Reader
//
// Bewusst nicht der naive Tokenizer: Swank schickt Zeichenliterale
// (#\() und escapte Symbole (|foo bar|), an denen eine reine
// Klammerzählung scheitert. Symbole werden als eigene Klasse geführt,
// damit sich das Symbol NIL vom String "nil" unterscheiden lässt — bei
// Plists wie (:value nil) ist der Unterschied bedeutungstragend.
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
      this.i++; // defensiv: verirrte Klammer überspringen
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
      // Dotted pair: (a . b). Wir hängen den Rest einfach an. Verlustig
      // geht dabei die Information, dass die Liste unecht ist — in den
      // Swank-Nachrichten, die wir auswerten, kommt das nicht vor.
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
      return this.readList(); // Vektor wie eine Liste behandeln
    }
    if (next === '\\') {
      // Zeichenliteral: #\a, #\Space, #\( — die Klammer darf NICHT zählen
      this.i += 2;
      let out = '';
      // mindestens ein Zeichen, dann optional weitere Namensbuchstaben
      if (this.i < this.s.length) out += this.s[this.i++];
      while (this.i < this.s.length && /[A-Za-z0-9_-]/.test(this.s[this.i])) {
        out += this.s[this.i++];
      }
      return new Sym('#\\' + out);
    }
    // #p"...", #x1F, #b101, unbekanntes: Präfix behalten, Rest lesen
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

/** Textform eines Werts fürs Anzeigen. */
export function text(x: SExpr | undefined): string {
  if (x === undefined) return '';
  if (x instanceof Sym) return isNil(x) ? '' : x.name;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return printSexpr(x);
  return String(x);
}

/**
 * Lisp-Schreibweise, u.a. um Thread-Bezeichner zurückzusenden.
 *
 * Strings gehen über lispString, NICHT über JSON.stringify: siehe dort.
 */
export function printSexpr(x: SExpr): string {
  if (Array.isArray(x)) return `(${x.map(printSexpr).join(' ')})`;
  if (x instanceof Sym) return x.name;
  if (typeof x === 'string') return lispString(x);
  return String(x);
}

/** Wert zu einem Schlüssel aus einer Plist wie (:name "x" :value "1"). */
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
 * Ein Lisp-Stringliteral aus einem Text bauen.
 *
 * Bewusst NICHT JSON.stringify: das erzeugt \n, \t, \uXXXX — Escapes,
 * die der Lisp-Reader nicht kennt. `\n` liest er als das Zeichen `n`,
 * womit der String stillschweigend verfälscht wird. Der Lisp-Reader
 * kennt in Strings nur \\ und \".
 *
 * Steuerzeichen brauchen KEINE Maskierung: ein echter Zeilenumbruch
 * innerhalb eines Lisp-Stringliterals ist gültig und bleibt beim Lesen
 * erhalten, und der Swank-Rahmen zählt Bytes, verträgt also Umbrüche im
 * Rumpf. Genau daran hing die mehrzeilige REPL-Eingabe: über
 * JSON.stringify wurde aus jedem Umbruch das Symbol `n`, sodass
 * (dsp! …) über drei Zeilen mit "undefined variable: n" scheiterte.
 */
export function lispString(s: string): string {
  return `"${s.replace(/[\\"]/g, m => '\\' + m)}"`;
}

/**
 * Entscheidet, ob ein Hover-Text überhaupt an Lisp geschickt wird.
 * Rückgabe: der zu sendende Text oder undefined.
 *
 * VS Code schickt bei eingeschaltetem supportsEvaluateForHovers ALLES,
 * worüber die Maus fährt — Dateinamen, Kommentarwörter, Bruchstücke.
 *
 * Abgelehnt wird:
 *  - zu lang: dann steht die Maus nicht über einem Symbol, sondern über
 *    einer markierten Passage. Die gehört in die Debug-Konsole
 *  - Steuerzeichen: nicht weil sie sich nicht darstellen liessen (siehe
 *    lispString), sondern weil ein mehrzeiliger Text keine Maus-Hover-
 *    Abfrage mehr ist, sondern eine markierte Passage — die gehört in
 *    die Debug-Konsole
 *  - `#.` — Read-Eval. Läuft VOR jedem Handler und darf niemals aus
 *    einer Mausbewegung heraus passieren
 *  - `#<` — nicht wieder einlesbare Objekte, wie sie im Backtrace und in
 *    jeder Fehlermeldung stehen
 *  - unbalancierte Klammern und offene Zeichenketten
 *
 * Die letzten beiden Punkte waren das eigentliche Loch: ignore-errors
 * greift erst bei EVAL, ein Reader-Fehler passiert aber schon beim
 * Lesen. Bewusst hier als reine Funktion, damit sie ohne laufendes
 * Lisp-Image geprüft werden kann.
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
 * Zerlegt einen Text in seine Top-Level-Formen.
 *
 * Nötig, weil swank:eval-and-grab-output nur die ERSTE Form liest.
 * Schickt man zwei Formen als einen Block, läuft stillschweigend nur
 * die erste — ein Fehler, der wie "es passiert nichts" aussieht.
 * Berücksichtigt Strings, Zeichenliterale (#\( zählt nicht), Zeilen-
 * und Blockkommentare.
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

  /** Zuletzt vom Image gemeldetes Paket (über :new-package). */
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
   * Schickt ein Formular und wartet auf die Antwort. Jede Anfrage
   * bekommt eine eigene ID — feste IDs (wie im Prototyp) kollidieren,
   * sobald zwei Anfragen gleichzeitig offen sind.
   */
  /**
   * Schickt ein Formular und wartet auf die Antwort.
   *
   * onId wird mit der vergebenen Request-ID aufgerufen, bevor gesendet
   * wird — so kann der Aufrufer GENAU diese Anfrage später von ihrer
   * Frist befreien (clearTimeout(id)), statt pauschal alle Fristen zu
   * löschen. Das pauschale Löschen war ein echter Fehler: es machte auch
   * unbeteiligte, gleichzeitig offene Anfragen (Threads, Stackframes,
   * Hover) timeoutlos, sodass eine ausbleibende Antwort sie für immer in
   * pending hängen liess.
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
      // Ohne Frist bleibt eine Anfrage, die nie beantwortet wird, für
      // immer offen — und der Aufrufer sieht schlicht nichts. Genau das
      // ist beim Umstieg auf listener-eval passiert: keine Antwort,
      // keine Fehlermeldung, ein stummes Fenster. Ein Timeout macht aus
      // dem Schweigen eine Aussage.
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (!this.pending.has(id)) return;
            this.pending.delete(id);
            reject(new Error(
              `Keine Antwort von Swank nach ${timeoutMs} ms auf: ${form}`
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
   * Alle laufenden Fristen abschalten.
   *
   * Sobald der Lisp-Debugger offen ist, antwortet Swank auf die
   * auslösende Anfrage absichtlich nicht — sie bleibt hängen, bis ein
   * Restart aufgerufen wird. Ohne diesen Aufruf meldet der Timeout dann
   * fälschlich einen Fehler, obwohl alles seinen Gang geht.
   */
  /**
   * Nimmt EINER Anfrage ihre Frist — der, die den Debugger ausgelöst hat.
   * Swank antwortet auf sie erst nach einem Restart; ohne Fristentzug
   * meldete der Timeout fälschlich einen Fehler. Alle anderen Anfragen
   * behalten ihre Frist, damit ausbleibende Antworten nicht ewig offen
   * bleiben.
   */
  clearRequestTimeout(id: number): void {
    const p = this.pending.get(id);
    if (p?.timer) {
      clearTimeout(p.timer);
      p.timer = undefined;
    }
  }

  /** Antwort auf ein :read-string — sonst wartet das Image ewig. */
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
    if (!this.socket) throw new Error('Nicht mit Swank verbunden.');
    this.emit('wire', '>>', payload);
    const body = Buffer.from(payload, 'utf8');
    // Swank-Rahmen: sechs Hex-Ziffern Länge des Rumpfs, dann der Rumpf.
    const head = Buffer.from(body.length.toString(16).padStart(6, '0'), 'ascii');
    this.socket.write(Buffer.concat([head, body]));
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 6) return;
      const n = parseInt(this.buffer.subarray(0, 6).toString('ascii'), 16);
      if (!Number.isFinite(n) || n < 0) {
        this.emit('protocolError', new Error('Ungültiger Swank-Header'));
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
