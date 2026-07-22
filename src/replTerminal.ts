import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface EvalResult {
  output: string;
  package: string;
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
  }

  private constructor(private readonly getClient: () => LanguageClient | undefined) {}

  open(): void {
    this.write('\x1b[1mCLAMPS REPL\x1b[0m\r\n');
    this.write('Dieselbe laufende SBCL-/Swank-Session wie der Editor.\r\n');
    this.write('Enter: auswerten · Ctrl+J: neue Zeile · Ctrl+L: leeren · ↑/↓: Verlauf\r\n\r\n');
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
    this.clearInputLine();
    this.write('\r\n');
    this.buffer = '';
    this.cursor = 0;
    if (!code) {
      this.renderInput();
      return;
    }

    if (this.history[this.history.length - 1] !== code) this.history.push(code);
    this.historyIndex = this.history.length;
    await this.requestEval(code);
    this.renderInput();
  }

  private async requestEval(code: string): Promise<void> {
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.write('\x1b[31mCLAMPS ist nicht verbunden. Führe „CLAMPS: Start“ aus.\x1b[0m\r\n');
      return;
    }

    this.busy = true;
    try {
      const result = await client.sendRequest<EvalResult>('clamps/eval', {
        code,
        package: this.packageName,
      });
      if (result.package) this.packageName = result.package;
      const output = result.output ?? '';
      if (output.length > 0) this.write(`${this.normalizeNewlines(output)}${output.endsWith('\n') ? '' : '\r\n'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.write(`\x1b[31m${this.normalizeNewlines(message)}\x1b[0m\r\n`);
    } finally {
      this.busy = false;
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

  private renderInput(): void {
    const prompt = `\x1b[36m${this.packageName}>\x1b[0m `;
    const visibleBuffer = this.normalizeNewlines(this.buffer);
    this.write(`\r\x1b[2K${prompt}${visibleBuffer}`);
    const charsAfterCursor = this.buffer.length - this.cursor;
    if (charsAfterCursor > 0) this.write(`\x1b[${charsAfterCursor}D`);
  }

  private clearInputLine(): void {
    this.write('\r\x1b[2K');
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
