import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface EvalResult {
  output: string;
  package: string;
}


/**
 * Grober Lisp-Reader-Zustand eines Eingabepuffers.
 *
 * Nötig, weil die REPL vorher jede Enter-Taste als vollständigen Ausdruck
 * an das Image geschickt hat. Bei "(dsp! si" lief der Reader dort ins
 * Dateiende — Fehlermeldung statt Fortsetzung. Wir entscheiden deshalb
 * schon hier, ob der Ausdruck fertig ist.
 *
 * Berücksichtigt Strings mit Escapes, Zeichenliterale (#\( zählt nicht
 * als Klammer), Zeilenkommentare und verschachtelte Blockkommentare.
 */
interface ReadState {
  /** Offene Klammern; > 0 heißt unvollständig. */
  depth: number;
  /** Mehr ) als ( — der Ausdruck ist kaputt, nicht unvollständig. */
  tooManyClosers: boolean;
  inString: boolean;
  inBlockComment: boolean;
}

export function readState(text: string): ReadState {
  let depth = 0;
  let tooManyClosers = false;
  let inString = false;
  let blockDepth = 0;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inString) {
      if (c === '\\') i += 2;
      else {
        if (c === '"') inString = false;
        i++;
      }
      continue;
    }

    if (blockDepth > 0) {
      if (c === '|' && text[i + 1] === '#') { blockDepth--; i += 2; continue; }
      if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
      i++;
      continue;
    }

    // Zeichenliteral: #\( darf die Bilanz nicht verschieben
    if (c === '#' && text[i + 1] === '\\') { i += 3; continue; }
    if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
    if (c === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"') { inString = true; i++; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') {
      depth--;
      if (depth < 0) { tooManyClosers = true; depth = 0; }
      i++;
      continue;
    }
    i++;
  }

  return { depth, tooManyClosers, inString, inBlockComment: blockDepth > 0 };
}

export class ClampsReplTerminal implements vscode.Pseudoterminal {
  private static instance: ClampsReplTerminal | undefined;
  private static terminal: vscode.Terminal | undefined;

  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose?: vscode.Event<void> = this.closeEmitter.event;

  private buffer = '';
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private packageName = 'COMMON-LISP-USER';
  private busy = false;

  /**
   * Terminalbreite in Spalten. Ohne sie lässt sich nicht ausrechnen, wie
   * viele BILDSCHIRMzeilen eine Eingabe belegt: eine Lisp-Zeile ist
   * regelmäßig breiter als das Panel und wird umbrochen. Die frühere
   * Fassung zählte Pufferzeilen und liess beim Neuzeichnen jede
   * umbrochene Zeile stehen — pro Tastendruck eine Kopie mehr.
   */
  private cols = 80;

  /** Bildschirmzeilen, die die letzte Eingabe belegt hat. */
  private renderedRows = 1;

  /** open() gelaufen? setDimensions kommt teils davor. */
  private opened = false;

  static show(getClient: () => LanguageClient | undefined): ClampsReplTerminal {
    if (!this.instance || !this.terminal) {
      // Scrollback für die REPL sicherstellen. Das Pseudoterminal-API
      // kennt keine per-Terminal-Option, daher setzen wir die
      // Workspace-Einstellung — aber nur erhöhend, damit eine bereits
      // höhere Nutzereinstellung nicht verkleinert wird.
      void this.ensureScrollback(10000);

      this.instance = new ClampsReplTerminal(getClient);
      this.terminal = vscode.window.createTerminal({
        name: 'CLAMPS REPL',
        pty: this.instance,
        iconPath: new vscode.ThemeIcon('terminal'),
      });
      const terminal = this.terminal;
      vscode.window.onDidCloseTerminal(closed => {
        if (closed === terminal) {
          this.instance?.dispose();
          this.instance = undefined;
          this.terminal = undefined;
        }
      });
    }
    this.terminal.show(false);
    return this.instance;
  }

  private static async ensureScrollback(minLines: number): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('terminal.integrated');
      const current = config.get<number>('scrollback') ?? 1000;
      if (current < minLines) {
        await config.update(
          'scrollback',
          minLines,
          vscode.ConfigurationTarget.Workspace
        );
      }
    } catch {
      // Nicht kritisch — wenn das Setzen fehlschlägt, bleibt nur der
      // Default-Scrollback, die REPL funktioniert trotzdem.
    }
  }

  static async evaluate(getClient: () => LanguageClient | undefined, code: string): Promise<void> {
    const repl = this.show(getClient);
    await repl.evaluateCode(code);
    // Auch Auswertungen aus dem Editor können DSP-Nodes anlegen; sie
    // gehen über evaluateCode, nicht über requestEval.
    void vscode.commands
      .executeCommand('clamps.incudineRefreshSoon')
      .then(undefined, () => undefined);
  }

  private constructor(private readonly getClient: () => LanguageClient | undefined) {}

  open(initialDimensions?: vscode.TerminalDimensions): void {
    // Breite gleich beim Öffnen übernehmen, sonst rechnet der erste
    // Redraw mit dem 80-Spalten-Default.
    if (initialDimensions) this.cols = Math.max(20, initialDimensions.columns);
    this.write('\x1b[1mCLAMPS REPL\x1b[0m\r\n');
    this.write('Dieselbe laufende SBCL-/Swank-Session wie der Editor.\r\n');
    this.write('Enter: auswerten (unvollständige Formen laufen weiter) · Ctrl+J: neue Zeile\r\n');
    this.write('Ctrl+L: leeren · Ctrl+C: abbrechen · ↑/↓: Verlauf\r\n');
    if (vscode.workspace.getConfiguration('clamps').get<boolean>('replUsesDebugger', true)) {
      this.write('Bei angehängtem Debugger öffnen Fehler den Lisp-Debugger.\r\n\r\n');
    } else {
      this.write('\r\n');
    }
    this.opened = true;
    this.renderInput();
  }

  close(): void {
    this.dispose();
  }

  handleInput(data: string): void {
    // Paste-Erkennung: Ein einzelner Tastendruck liefert genau EIN Zeichen
    // (oder eine kurze Escape-Sequenz, die mit \x1b beginnt). Kommt mehr
    // als ein Zeichen auf einmal und beginnt NICHT mit \x1b, ist es
    // eingefügter Text — egal ob mit oder ohne Zeilenumbruch. (Auch
    // "paste as one line" landet hier, weil es zwar die Newlines entfernt,
    // aber immer noch als ein mehrzeichiger Block ankommt.) So löst kein
    // eingebettetes \r ein vorzeitiges submit() aus und die Prompt-Zeile
    // wird nur EINMAL gerendert statt pro Zeichen.
    if (data.length > 1 && !data.startsWith('\x1b')) {
      this.handlePaste(data);
      return;
    }

    // VS Code may deliver escape sequences in one chunk.
    for (let index = 0; index < data.length;) {
      if (data.startsWith('\x1b[A', index)) {
        this.previousHistory();
        index += 3;
      } else if (data.startsWith('\x1b[B', index)) {
        this.nextHistory();
        index += 3;
      } else if (data.startsWith('\x1b[C', index)) {
        this.moveCursor(1);
        index += 3;
      } else if (data.startsWith('\x1b[D', index)) {
        this.moveCursor(-1);
        index += 3;
      } else if (data.startsWith('\x1b[', index)) {
        // Unbekannte CSI-Sequenz (F-Tasten wie ESC[24~ für F12, Home,
        // End, PageUp, Entf ESC[3~, ...) komplett verschlucken — sonst
        // landen die druckbaren Teile ("[24~") als Müll im Buffer.
        // CSI-Format: ESC [ <Parameter '0'..';'> <Endzeichen>
        let j = index + 2;
        while (j < data.length && data[j] >= '0' && data[j] <= ';') j++;
        if (j < data.length) j++; // Endzeichen (Buchstabe oder ~) mitnehmen
        index = j;
      } else if (data.startsWith('\x1b', index)) {
        // Einzelnes ESC oder unbekannte Nicht-CSI-Sequenz: ESC + ein
        // Folgezeichen verschlucken.
        index += Math.min(2, data.length - index);
      } else {
        const ch = data[index++];
        switch (ch) {
          case '\r':
            void this.submit();
            break;
          case '\n':
          case '\x0a':
            this.insert('\n');
            break;
          case '\x7f':
          case '\b':
            this.backspace();
            break;
          case '\x03':
            this.cancelInput();
            break;
          case '\x0c':
            this.write('\x1b[2J\x1b[H');
            this.renderInput();
            break;
          default:
            if (ch >= ' ' || ch === '\t') this.insert(ch);
        }
      }
    }
  }

  /**
   * Fügt eingefügten (gepasteten) Text ein. Zeilenumbrüche (\r\n, \r, \n)
   * werden zu einem einheitlichen \n normalisiert und als Teil des
   * Buffers eingefügt — NICHT als submit interpretiert. So kann man
   * mehrzeilige Formen einfügen, ohne dass jede Zeile sofort abgeschickt
   * wird. Gerendert wird nur EINMAL am Ende, nicht pro Zeichen.
   */
  private handlePaste(data: string): void {
    const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Steuerzeichen außer \n und \t herausfiltern, damit kein \x03 o.ä.
    // im Buffer landet.
    const cleaned = Array.from(normalized)
      .filter(ch => ch === '\n' || ch === '\t' || ch >= ' ')
      .join('');
    this.buffer =
      this.buffer.slice(0, this.cursor) + cleaned + this.buffer.slice(this.cursor);
    this.cursor += cleaned.length;
    this.renderInput();
  }

  async evaluateCode(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) return;
    this.clearInputLine();
    this.write(`\x1b[36m${this.packageName}>\x1b[0m ${this.normalizeNewlines(trimmed)}\r\n`);
    await this.requestEval(trimmed);
    this.renderInput();
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const code = this.buffer.trim();

    if (!code) {
      this.clearInputLine();
      this.write('\r\n');
      this.buffer = '';
      this.cursor = 0;
      this.renderInput();
      return;
    }

    // Unvollständig? Dann nicht abschicken, sondern weitertippen lassen.
    // Fluchtweg: endet der Puffer schon auf einer Leerzeile, hat der
    // Nutzer zweimal Enter gedrückt — dann doch abschicken, damit man
    // bei einem echten Tippfehler nicht in der Fortsetzung festhängt.
    const state = readState(this.buffer);
    const incomplete =
      (state.depth > 0 || state.inString || state.inBlockComment) &&
      !state.tooManyClosers;
    if (incomplete && !/\n[ \t]*$/.test(this.buffer)) {
      this.insert('\n');
      this.renderInput();
      return;
    }

    this.clearInputLine();
    // Das Eingetippte stehen lassen: sonst ist nach einer Fehlermeldung
    // nicht mehr zu sehen, worauf sie sich bezieht.
    this.write(
      `\x1b[36m${this.packageName}>\x1b[0m ${this.normalizeNewlines(code)}\r\n`
    );
    this.buffer = '';
    this.cursor = 0;

    if (this.history[this.history.length - 1] !== code) this.history.push(code);
    this.historyIndex = this.history.length;
    await this.requestEval(code);
    this.renderInput();
  }

  /**
   * Läuft eine CLAMPS-Debug-Session, wird über deren Swank-Verbindung
   * ausgewertet statt über die Bridge.
   *
   * Der Grund: Fehler in der REPL sollen den Debugger öffnen. Die Bridge
   * kann das nicht — eval-for-repl fängt dort jede Condition ab, und ein
   * :debug-Ereignis liesse sich über den Anfrage/Antwort-Kanal ohnehin
   * nicht weiterreichen. Über den Debug-Socket kommt es an.
   *
   * Ohne angehängten Debugger bleibt alles wie bisher: Fehler werden zu
   * Text, die REPL läuft weiter.
   */
  private get debugSession(): vscode.DebugSession | undefined {
    // Standardmäßig AUS. Die Umleitung ist der jüngste und am wenigsten
    // erprobte Teil; sie soll den stabilen Rest nicht mitreißen können.
    // Einschalten über clamps.replUsesDebugger.
    const enabled = vscode.workspace
      .getConfiguration('clamps')
      .get<boolean>('replUsesDebugger', true);
    if (!enabled) return undefined;
    const s = vscode.debug.activeDebugSession;
    return s && s.type === 'clamps' ? s : undefined;
  }

  private async requestEval(code: string): Promise<void> {
    const session = this.debugSession;
    const client = this.getClient();
    if (!session && (!client || client.state !== State.Running)) {
      this.write('\x1b[31mCLAMPS ist nicht verbunden. Führe „CLAMPS: Start“ aus.\x1b[0m\r\n');
      return;
    }

    this.busy = true;
    try {
      if (session) {
        const r = await session.customRequest('clamps/replEval', {
          code,
          package: this.packageName,
        });
        if (r?.package) this.packageName = r.package;
        const output = String(r?.output ?? '');
        if (output.length > 0) {
          const colour = r?.status === 'error' ? '\x1b[31m' : '';
          const reset = colour ? '\x1b[0m' : '';
          this.write(
            `${colour}${this.normalizeNewlines(output)}${reset}` +
            (output.endsWith('\n') ? '' : '\r\n')
          );
        }
      } else {
        const result = await client!.sendRequest<EvalResult>('clamps/eval', {
          code,
          package: this.packageName,
        });
        if (result.package) this.packageName = result.package;
        const output = result.output ?? '';
        if (output.length > 0) {
          this.write(`${this.normalizeNewlines(output)}${output.endsWith('\n') ? '' : '\r\n'}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.write(`\x1b[31m${this.normalizeNewlines(message)}\x1b[0m\r\n`);
    } finally {
      this.busy = false;
      // Node-Browser nachziehen: eine Auswertung kann DSP-Nodes erzeugt
      // oder entfernt haben. Gehört in finally, nicht in catch — dort
      // lief er nur bei fehlgeschlagenen Auswertungen, also gerade nicht
      // nach einem erfolgreichen (dsp!)- oder (rt-start)-Aufruf.
      void vscode.commands
        .executeCommand('clamps.incudineRefreshSoon')
        .then(undefined, () => undefined);
    }
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.renderInput();
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
    this.renderInput();
  }

  private moveCursor(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.buffer.length, this.cursor + delta));
    this.renderInput();
  }

  private previousHistory(): void {
    if (this.history.length === 0 || this.historyIndex === 0) return;
    this.historyIndex--;
    this.buffer = this.history[this.historyIndex];
    this.cursor = this.buffer.length;
    this.renderInput();
  }

  private nextHistory(): void {
    if (this.historyIndex >= this.history.length) return;
    this.historyIndex++;
    this.buffer = this.historyIndex === this.history.length ? '' : this.history[this.historyIndex];
    this.cursor = this.buffer.length;
    this.renderInput();
  }

  private cancelInput(): void {
    this.clearInputLine();
    this.write('^C\r\n');
    this.buffer = '';
    this.cursor = 0;
    this.renderInput();
  }

  /**
   * Wie viele Bildschirmzeilen die letzte Eingabe belegt hat. Ohne das
   * lässt sich eine mehrzeilige Eingabe nicht wieder wegräumen — die
   * frühere Fassung löschte immer nur die aktuelle Zeile und liess bei
   * Fortsetzungen Reste stehen.
   */

  /**
   * Von VS Code beim Öffnen und bei jeder Größenänderung aufgerufen.
   */
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    const cols = Math.max(20, dimensions.columns);
    if (cols === this.cols) return;
    this.cols = cols;
    // Nach einer Größenänderung stimmt die alte Zeilenrechnung nicht
    // mehr; nicht versuchen aufzuräumen, sondern frisch anfangen.
    this.renderedRows = 1;
    if (this.opened) {
      this.write('\r\n');
      this.renderInput();
    }
  }

  /** Prompt-Breite in Spalten (ohne die ANSI-Sequenzen, die 0 breit sind). */
  private get promptWidth(): number {
    return this.packageName.length + 2;
  }

  /** Bildschirmzeilen, die eine Pufferzeile bei aktueller Breite belegt. */
  private rowsFor(lineLength: number): number {
    return Math.max(1, Math.ceil((this.promptWidth + lineLength) / this.cols));
  }

  private renderInput(): void {
    this.clearInputLine();

    const prompt = `\x1b[36m${this.packageName}>\x1b[0m `;
    // Fortsetzungszeilen: gleiche Breite wie der Prompt, damit die
    // Einrückung des Ausdrucks erhalten bleibt.
    const contPrompt = `\x1b[36m${'.'.repeat(this.packageName.length)}>\x1b[0m `;

    const lines = this.buffer.split('\n');
    this.write(
      lines.map((l, i) => (i === 0 ? prompt : contPrompt) + l).join('\r\n')
    );

    // Bildschirmzeilen zählen, nicht Pufferzeilen.
    const rowsPerLine = lines.map(l => this.rowsFor(l.length));
    const totalRows = rowsPerLine.reduce((a, b) => a + b, 0);
    this.renderedRows = totalRows;

    // Cursorposition im Puffer -> Bildschirmzeile/-spalte
    const before = this.buffer.slice(0, this.cursor).split('\n');
    const cursorLine = before.length - 1;
    const cursorColInLine = before[before.length - 1].length;
    const flat = this.promptWidth + cursorColInLine;
    const lineOffset = rowsPerLine
      .slice(0, cursorLine)
      .reduce((a, b) => a + b, 0);

    let cursorRow: number;
    let cursorCol: number;
    if (flat > 0 && flat % this.cols === 0) {
      // Genau auf der Umbruchgrenze. xterm.js bricht verzögert um: der
      // Cursor bleibt am ENDE der vollen Zeile stehen, nicht am Anfang
      // der nächsten. Ohne diesen Zweig käme hier eine Zeile zu viel
      // heraus und die Cursorbewegung würde negativ.
      cursorRow = lineOffset + flat / this.cols - 1;
      cursorCol = this.cols - 1;
    } else {
      cursorRow = lineOffset + Math.floor(flat / this.cols);
      cursorCol = flat % this.cols;
    }

    // Nach dem Schreiben steht der Cursor in der letzten Bildschirmzeile.
    const up = Math.max(0, totalRows - 1 - cursorRow);
    if (up > 0) this.write(`\x1b[${up}A`);
    this.write('\r');
    if (cursorCol > 0) this.write(`\x1b[${cursorCol}C`);
  }

  private clearInputLine(): void {
    // An den Anfang der Eingabe hoch, dann alles darunter löschen.
    if (this.renderedRows > 1) this.write(`\x1b[${this.renderedRows - 1}A`);
    this.write('\r\x1b[0J');
    this.renderedRows = 1;
  }

  private normalizeNewlines(value: string): string {
    return value.replace(/\r?\n/g, '\r\n');
  }

  private write(value: string): void {
    this.writeEmitter.fire(value);
  }

  private dispose(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}
