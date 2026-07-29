import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface EvalResult {
  output: string;
  package: string;
  presentations?: Array<{ id: number; preview: string; type: string }>;
}


/**
 * A rough Lisp reader state for an input buffer.
 *
 * Necessary because the REPL previously sent every Enter key to the image
 * as a complete expression. With "(dsp! si" the reader there ran off the
 * end of the file — an error message instead of a continuation. So we
 * decide here already whether the expression is finished.
 *
 * Takes strings with escapes, character literals (#\( does not count as a
 * paren), line comments and nested block comments into account.
 */
interface ReadState {
  /** Open parens; > 0 means incomplete. */
  depth: number;
  /** More ) than ( — the expression is broken, not incomplete. */
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

    // Character literal: #\( must not shift the balance
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
   * The buffer at the last Tab. Two Tabs without a change in between
   * lists the candidates — the same behaviour as in readline and in SLY.
   * Without this record one would have to guess whether the user wants to
   * see the list, and one would get there either too early or never.
   */
  private lastCompletionAt: string | undefined;

  /**
   * Terminal width in columns. Without it there is no way to compute how
   * many SCREEN lines an input occupies: a Lisp line is regularly wider
   * than the panel and gets wrapped. The earlier version counted buffer
   * lines and left every wrapped line standing on redraw — one more copy
   * per keystroke.
   */
  private cols = 80;

  /** Screen lines that the last input occupied. */
  private renderedRows = 1;

  /** open() gelaufen? setDimensions kommt teils davor. */
  private opened = false;

  static show(getClient: () => LanguageClient | undefined): ClampsReplTerminal {
    if (!this.instance || !this.terminal) {
      // Make sure the REPL has scrollback. The pseudoterminal API knows
      // no per-terminal option, so we set the workspace setting — but only
      // upwards, so that an already higher user setting is not reduced.
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
      // Not critical — if setting it fails, only the default scrollback
      // remains and the REPL still works.
    }
  }

  static async evaluate(getClient: () => LanguageClient | undefined, code: string): Promise<void> {
    const repl = this.show(getClient);
    await repl.evaluateCode(code);
    // Evaluations from the editor can create DSP nodes too; they go
    // through evaluateCode, not through requestEval.
    void vscode.commands
      .executeCommand('clamps.incudineRefreshSoon')
      .then(undefined, () => undefined);
  }

  private constructor(private readonly getClient: () => LanguageClient | undefined) {}

  open(initialDimensions?: vscode.TerminalDimensions): void {
    // Adopt the width right at opening, otherwise the first redraw
    // computes with the 80-column default.
    if (initialDimensions) this.cols = Math.max(20, initialDimensions.columns);
    this.write('\x1b[1mCLAMPS REPL\x1b[0m\r\n');
    this.write('The same running SBCL/Swank session as the editor.\r\n');
    this.write('Enter: evaluate (incomplete forms carry on) \u00b7 Ctrl+J: new line\r\n');
    this.write('Tab: complete (twice lists) \u00b7 Ctrl+L: clear\r\n');
    this.write('Ctrl+C: cancel · ↑/↓: history\r\n');
    if (vscode.workspace.getConfiguration('clamps').get<boolean>('replUsesDebugger', true)) {
      this.write('With the debugger attached, errors open the Lisp debugger.\r\n\r\n');
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
    // Paste detection: a single keystroke delivers exactly ONE character
    // (or a short escape sequence beginning with \x1b). If more than one
    // character arrives at once and it does NOT begin with \x1b, it is
    // pasted text — whether or not it contains a newline. ("Paste as one
    // line" also ends up here, because although it removes the newlines it
    // still arrives as one multi-character block.) That way no embedded
    // \r triggers a premature submit() and the prompt line is rendered
    // only ONCE instead of once per character.
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
        // Swallow an unknown CSI sequence entirely (function keys such as
        // ESC[24~ for F12, Home, End, PageUp, Delete ESC[3~, ...) —
        // otherwise the printable parts ("[24~") land in the buffer as
        // junk. CSI format: ESC [ <parameters '0'..';'> <final character>
        let j = index + 2;
        while (j < data.length && data[j] >= '0' && data[j] <= ';') j++;
        if (j < data.length) j++; // take the final character (a letter or ~) along
        index = j;
      } else if (data.startsWith('\x1b', index)) {
        // A lone ESC or an unknown non-CSI sequence: swallow ESC plus one
        // following character.
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
          case '\t':
            // Tab completes rather than putting a tab character into the
            // buffer. A tab in Lisp source is not something one wants to
            // type anyway.
            void this.complete();
            break;
          default:
            if (ch >= ' ') this.insert(ch);
        }
      }
    }
  }

  /**
   * Inserts pasted text. Newlines (\r\n, \r, \n) are normalised to a
   * uniform \n and inserted as part of the buffer — NOT interpreted as a
   * submit. That way multi-line forms can be pasted without every line
   * being sent off immediately. Rendering happens only ONCE at the end,
   * not per character.
   */
  private handlePaste(data: string): void {
    const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Filter out control characters except \n and \t, so that no \x03 or
    // the like ends up in the buffer.
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

    // Incomplete? Then do not send it, let the user carry on typing.
    // An escape route: if the buffer already ends on a blank line, the
    // user has pressed Enter twice — then send it after all, so that a
    // genuine typo does not leave one stuck in the continuation.
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
    // Leave what was typed standing: otherwise, after an error message,
    // there is no seeing what it refers to.
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
   * If a CLAMPS debug session is running, evaluation goes over its Swank
   * connection rather than over the bridge.
   *
   * The reason: errors in the REPL should open the debugger. The bridge
   * cannot do that — there eval-for-repl catches every condition, and a
   * :debug event could not be passed on over the request/response channel
   * anyway. Over the debug socket it arrives.
   *
   * Without an attached debugger everything stays as before: errors
   * become text and the REPL carries on.
   */
  private get debugSession(): vscode.DebugSession | undefined {
    // OFF by default. The redirection is the newest and least tried part;
    // it must not be able to drag the stable rest down with it. Switch it
    // on via clamps.replUsesDebugger.
    const enabled = vscode.workspace
      .getConfiguration('clamps')
      .get<boolean>('replUsesDebugger', true);
    if (!enabled) return undefined;
    const s = vscode.debug.activeDebugSession;
    return s && s.type === 'clamps' ? s : undefined;
  }

  private async requestEval(code: string): Promise<void> {
    if (code.startsWith(',')) {
      await this.handleCommaCommand(code);
      return;
    }
    const session = this.debugSession;
    const client = this.getClient();
    if (!session && (!client || client.state !== State.Running)) {
      this.write('\x1b[31mCLAMPS is not connected. Run "CLAMPS: Start".\x1b[0m\r\n');
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
        const presentations = Array.isArray(r?.presentations) ? r.presentations : [];
        for (const p of presentations) {
          this.write(`\x1b[2m  [#${p.id} ${p.type}] ,inspect ${p.id}\x1b[0m\r\n`);
        }
      } else {
        const result = await client!.sendRequest<EvalResult>('clamps/eval', {
          code,
          package: this.packageName,
        });
        if (result.package) this.packageName = result.package;
        const output = result.output ?? '';
        const presentations = result.presentations ?? [];
        if (output.length > 0) {
          this.write(`${this.normalizeNewlines(output)}${output.endsWith('\n') ? '' : '\r\n'}`);
        }
        if (presentations.length > 0) {
          for (const p of presentations) this.write(`\x1b[2m  [#${p.id} ${p.type}] ,inspect ${p.id}\x1b[0m\r\n`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.write(`\x1b[31m${this.normalizeNewlines(message)}\x1b[0m\r\n`);
    } finally {
      this.busy = false;
      // Pull the node browser along: an evaluation may have created or
      // removed DSP nodes. This belongs in finally, not in catch — there
      // it only ran on failed evaluations, that is, precisely not after a
      // successful (dsp!) or (rt-start) call.
      void vscode.commands
        .executeCommand('clamps.incudineRefreshSoon')
        .then(undefined, () => undefined);
    }
  }

  private async handleCommaCommand(code: string): Promise<void> {
    const [name, ...args] = code.slice(1).trim().split(/\s+/);
    switch ((name || 'help').toLowerCase()) {
      case 'inspect': {
        const id = Number(args[0]);
        if (Number.isFinite(id)) await vscode.commands.executeCommand('clamps.inspectPresentation', id);
        else this.write('Usage: ,inspect <id>\r\n');
        break;
      }
      case 'load': case 'compile': case 'test':
        await vscode.commands.executeCommand(`clamps.asdf.${name}`); break;
      case 'stickers': await vscode.commands.executeCommand('clamps.stickersShow'); break;
      case 'package': if (args[0]) this.packageName = args[0].toUpperCase(); else this.write(`${this.packageName}\r\n`); break;
      default: this.write(',inspect ID · ,load · ,compile · ,test · ,stickers · ,package NAME\r\n');
    }
  }

  /** Characters that belong to a Lisp symbol. Mirrors
   *  symbol-constituent-p in bridge-server.lisp. If the two drift apart,
   *  the client cuts off a different prefix from the one the server
   *  expects — and the suggestions silently stop fitting. */
  private static readonly SYMBOL_CHARS = /[A-Za-z0-9\-+*/<>=!?_%&^~.:@]*$/;

  /** The typed start of a symbol to the left of the cursor. */
  private currentToken(): string {
    const upToCursor = this.buffer.slice(0, this.cursor);
    return ClampsReplTerminal.SYMBOL_CHARS.exec(upToCursor)?.[0] ?? '';
  }

  /**
   * Tab completion. A single candidate is inserted, several are shortened
   * to their longest common prefix, and if that gains nothing more, the
   * second Tab shows the list.
   */
  private async complete(): Promise<void> {
    if (this.busy) return;
    const client = this.getClient();
    if (!client || client.state !== State.Running) return;

    const token = this.currentToken();
    const before = this.buffer.slice(0, this.cursor);
    const wantList = this.lastCompletionAt === this.buffer;

    let items: { label: string; detail?: string }[];
    try {
      const r = await client.sendRequest<{ items?: { label: string; detail?: string }[] }>(
        'clamps/replComplete',
        { prefix: token, package: this.packageName, context: before }
      );
      items = r?.items ?? [];
    } catch {
      // A failed completion is no reason to disturb the input. Stay quiet
      // and let the user carry on typing.
      return;
    }
    if (items.length === 0) return;

    const labels = items.map(i => i.label);
    const insertion = labels.length === 1
      ? labels[0]
      : ClampsReplTerminal.commonPrefix(labels);

    if (insertion.length > token.length) {
      this.replaceToken(token, insertion);
      // After insertion the record is void: the next Tab should ask
      // again, not list immediately.
      this.lastCompletionAt = undefined;
      return;
    }

    if (wantList) {
      this.writeCandidates(items);
      this.lastCompletionAt = undefined;
    } else {
      this.lastCompletionAt = this.buffer;
    }
  }

  /**
   * The longest common prefix. Compared character for character: the
   * bridge always delivers symbol names in lower case, so a
   * case-insensitive comparison would gain nothing and could insert mixed
   * case.
   */
  private static commonPrefix(labels: string[]): string {
    let prefix = labels[0] ?? '';
    for (const label of labels.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < label.length && prefix[i] === label[i]) i++;
      prefix = prefix.slice(0, i);
      if (prefix.length === 0) break;
    }
    return prefix;
  }

  private replaceToken(token: string, replacement: string): void {
    const start = this.cursor - token.length;
    this.buffer = this.buffer.slice(0, start) + replacement + this.buffer.slice(this.cursor);
    this.cursor = start + replacement.length;
    this.renderInput();
  }

  /**
   * Print the candidates above the input line and then redraw the input —
   * the way cancelInput() does it, otherwise the old prompt line stays
   * standing.
   */
  private writeCandidates(items: { label: string; detail?: string }[]): void {
    const shown = items.slice(0, 40);
    const width = Math.max(...shown.map(i => i.label.length), 1);
    this.clearInputLine();
    this.write('\r\n');
    for (const item of shown) {
      const detail = item.detail ? `  \x1b[2m${item.detail}\x1b[0m` : '';
      this.write(`  ${item.label.padEnd(width)}${detail}\r\n`);
    }
    if (items.length > shown.length) {
      this.write(`  \x1b[2m… ${items.length - shown.length} weitere\x1b[0m\r\n`);
    }
    this.renderInput();
  }

  private insert(text: string): void {
    this.lastCompletionAt = undefined;
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.renderInput();
  }

  private backspace(): void {
    this.lastCompletionAt = undefined;
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
   * How many screen lines the last input occupied. Without this a
   * multi-line input cannot be cleared away again — the earlier version
   * always cleared only the current line and left remnants standing on
   * continuations.
   */

  /**
   * Called by VS Code on opening and on every resize.
   */
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    const cols = Math.max(20, dimensions.columns);
    if (cols === this.cols) return;
    this.cols = cols;
    // After a resize the old line arithmetic no longer holds; do not try
    // to tidy up, start afresh instead.
    this.renderedRows = 1;
    if (this.opened) {
      this.write('\r\n');
      this.renderInput();
    }
  }

  /** Prompt width in columns (without the ANSI sequences, which are 0 wide). */
  private get promptWidth(): number {
    return this.packageName.length + 2;
  }

  /** Screen lines that one buffer line occupies at the current width. */
  private rowsFor(lineLength: number): number {
    return Math.max(1, Math.ceil((this.promptWidth + lineLength) / this.cols));
  }

  private renderInput(): void {
    this.clearInputLine();

    const prompt = `\x1b[36m${this.packageName}>\x1b[0m `;
    // Continuation lines: the same width as the prompt, so that the
    // indentation of the expression is preserved.
    const contPrompt = `\x1b[36m${'.'.repeat(this.packageName.length)}>\x1b[0m `;

    const lines = this.buffer.split('\n');
    this.write(
      lines.map((l, i) => (i === 0 ? prompt : contPrompt) + l).join('\r\n')
    );

    // Count screen lines, not buffer lines.
    const rowsPerLine = lines.map(l => this.rowsFor(l.length));
    const totalRows = rowsPerLine.reduce((a, b) => a + b, 0);
    this.renderedRows = totalRows;

    // Cursor position in the buffer -> screen line/column
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
      // Exactly on the wrap boundary. xterm.js wraps lazily: the cursor
      // stays at the END of the full line, not at the start of the next
      // one. Without this branch one line too many would come out here and
      // the cursor movement would go negative.
      cursorRow = lineOffset + flat / this.cols - 1;
      cursorCol = this.cols - 1;
    } else {
      cursorRow = lineOffset + Math.floor(flat / this.cols);
      cursorCol = flat % this.cols;
    }

    // After writing, the cursor is in the last screen line.
    const up = Math.max(0, totalRows - 1 - cursorRow);
    if (up > 0) this.write(`\x1b[${up}A`);
    this.write('\r');
    if (cursorCol > 0) this.write(`\x1b[${cursorCol}C`);
  }

  private clearInputLine(): void {
    // Up to the start of the input, then clear everything below it.
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
