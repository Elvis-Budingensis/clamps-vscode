// debugSession.ts
//
// Debug Adapter für CLAMPS. Bildet den Common-Lisp-Debugger auf DAP ab,
// damit VS Codes eingebaute Oberfläche (Aufrufliste, Variablen, Threads)
// benutzt werden kann, statt sie als Webview nachzubauen.
//
// Bewusste Auslassung: Stepping. SBCL-Stepping über :swank-stepper
// verlangt hoch gesetzte Debug-Qualität beim Kompilieren und ein
// Contrib, das in einem CLAMPS-Image typischerweise nicht geladen ist.
// Ein Schrittknopf, der still nichts tut, ist schlechter als keiner —
// die Step-Anfragen werden daher mit klarer Begründung abgelehnt.
//
// Ebenfalls bewusst: der Inspector wird NICHT hier nachgebaut. Ein Wert
// wird an ein frisch erzeugtes Symbol in CL-USER gebunden, und der
// vorhandene Objekt-Tabellen-Inspector bekommt dessen Namen. So gibt es
// ein Inspector-Modell statt zwei, und die Objektidentität bleibt.

import * as vscode from 'vscode';
import {
  SwankClient, SExpr, Sym, text, isSym, isNil, asList, plistGet, printSexpr,
  splitTopLevelForms,
} from './swank';

export interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: any;
}

interface Restart {
  index: number;
  name: string;
  description: string;
}

/** Ein Debugger-Level. Verschachtelte Debugger stapeln sich. */
interface DebugLevel {
  thread: SExpr;
  level: number;
  condition: string;
  conditionType: string;
  restarts: Restart[];
  frames: SExpr[];
  selectedFrame: number;
}

export class ClampsDebugSession implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private seq = 1;

  private readonly swank = new SwankClient();

  /** clamps.debugTrace: schreibt Swank- UND DAP-Verkehr in die Konsole. */
  private readonly trace = vscode.workspace
    .getConfiguration('clamps')
    .get<boolean>('debugTrace', false);

  /** Meldet der Client, dass er das invalidated-Ereignis versteht? */
  private supportsInvalidated = false;

  /**
   * Swank-Request-ID der laufenden REPL-Auswertung und der zugehörige
   * DAP-Request. Wird gesetzt, solange eine replEval-Auswertung offen
   * ist, damit onDebug (a) gezielt NUR ihre Frist löscht und (b) den
   * DAP-Request sofort beantwortet, statt die Kette REPL→DAP→Swank→
   * Restart offen zu halten.
   */
  private inflightRepl:
    | { swankId: number; req: DapRequest; pkg: string; answered: boolean }
    | undefined;

  /**
   * Stelligkeit von swank:eval-string-in-frame in DIESEM Image.
   *
   * Sie schwankt zwischen SLIME-Versionen: mal (string frame), mal
   * (string frame package). Ein Aufruf mit der falschen Zahl landet
   * nicht in einer Fehlermeldung, sondern im Lisp-Debugger — und weil
   * VS Code beim Anhalten automatisch Frame 0 auswählt, traf das jede
   * weitere Eingabe und stapelte Debugger-Ebenen.
   */
  private frameEvalArity = 3;

  /**
   * Stapel der Debugger-Ebenen. Der Prototyp hatte nur einen Zustand;
   * ein Fehler im Debugger (rekursiver Debugger) hätte den äußeren
   * überschrieben und beim Verlassen einen inkonsistenten Zustand
   * hinterlassen.
   */
  private levels: DebugLevel[] = [];

  private variableSets = new Map<number, vscode.DebugProtocolMessage[]>();
  private nextVarRef = 1;
  /** Zuletzt gesendete Form — für aussagekräftige Fehlermeldungen. */
  private lastForm = '';
  /** Hinweis auf den offenen Debugger nur einmal pro Ebene zeigen. */
  private warnedAboutOpenDebugger = false;
  private threadMap = new Map<number, SExpr>();

  /**
   * Thread-ID, die gegenüber VS Code als angehalten gemeldet wird.
   *
   * Muss zwingend in der Antwort auf `threads` vorkommen — sonst findet
   * VS Code den angehaltenen Thread nicht und zeigt gar keine
   * Aufrufliste. Genau das war der Grund, warum sich der Backtrace nicht
   * aufklappen liess: hier stand fest 1, während `threads` die echten
   * Lisp-IDs lieferte.
   */
  private stoppedThreadId = 1;

  constructor(
    private readonly port: number,
    private readonly workspaceRoot: string,
    private readonly host = '127.0.0.1'
  ) {
    // Rohverkehr mitschreiben, wenn clamps.debugTrace gesetzt ist.
    // Ohne das bleibt bei einem unerwarteten Fehler nur Raten, welche
    // Form tatsächlich über die Leitung ging.
    if (this.trace) {
      this.swank.on('wire', (dir: string, payload: string) =>
        this.event('output', {
          output: `${dir} ${payload}\n`,
          category: 'console',
        })
      );
    }

    // Fragt Lisp nach Eingabe (etwa ein Restart, der einen Wert will),
    // schickt Swank :read-string und wartet. Ohne Antwort läuft der
    // Aufruf ins Dateiende — genau so kippte [replace-function] in eine
    // weitere Debugger-Ebene.
    this.swank.on('readString', m => void this.onReadString(m));

    this.swank.on('debug', m => this.onDebug(m));
    this.swank.on('debugReturn', m => this.onDebugReturn(m));
    this.swank.on('writeString', m =>
      this.event('output', { output: text(asList(m)[1]), category: 'stdout' })
    );
    this.swank.on('close', () => this.event('terminated'));
    this.swank.on('socketError', e =>
      this.event('output', { output: `Swank-Socketfehler: ${e}\n`, category: 'stderr' })
    );
    this.swank.on('protocolError', (e, raw) =>
      this.event('output', {
        output: `Swank-Parsefehler: ${e}\n${String(raw).slice(0, 400)}\n`,
        category: 'stderr',
      })
    );
  }

  private async onReadString(msg: SExpr): Promise<void> {
    const m = asList(msg);
    const thread = m[1] ?? new Sym('t');
    const tag = m[2];
    const answer = await vscode.window.showInputBox({
      title: 'CLAMPS: Lisp erwartet eine Eingabe',
      prompt: 'Der Lisp-Prozess wartet auf Text (etwa ein Restart-Argument).',
      ignoreFocusOut: true,
    });
    // Auch bei Abbruch antworten, sonst hängt das Image.
    const value = (answer ?? '') + '\n';
    this.swank.emacsReturnString(thread, tag, value);
    this.event('output', {
      output: `; Eingabe an Lisp: ${JSON.stringify(answer ?? '')}\n`,
      category: 'console',
    });
  }

  private get top(): DebugLevel | undefined {
    return this.levels[this.levels.length - 1];
  }

  private get thread(): SExpr {
    return this.top?.thread ?? new Sym('t');
  }

  // ------------------------------------------------------------------
  // DAP-Grundgerüst
  // ------------------------------------------------------------------

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const req = message as unknown as DapRequest;
    if (this.trace) {
      this.event('output', {
        output: `DAP> ${req.command} ${JSON.stringify(req.arguments ?? {})}\n`,
        category: 'console',
      });
    }
    Promise.resolve(this.dispatch(req)).catch(e =>
      this.fail(req, 9999, e instanceof Error ? e.message : String(e))
    );
  }

  dispose(): void {
    this.swank.close();
    this.emitter.dispose();
  }

  private respond(req: DapRequest, body: any = {}): void {
    if (this.trace) {
      const summary = JSON.stringify(body);
      this.event('output', {
        output: `DAP< ${req.command} ${summary.length > 300 ? summary.slice(0, 300) + '…' : summary}\n`,
        category: 'console',
      });
    }
    this.emitter.fire({
      seq: this.seq++, type: 'response', request_seq: req.seq,
      command: req.command, success: true, body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private fail(req: DapRequest, id: number, message: string): void {
    if (this.trace) {
      this.event('output', {
        output: `DAP! ${req.command} FEHLER ${message}\n`,
        category: 'stderr',
      });
    }
    this.emitter.fire({
      seq: this.seq++, type: 'response', request_seq: req.seq,
      command: req.command, success: false, message,
      body: { error: { id, format: message } },
    } as unknown as vscode.DebugProtocolMessage);
  }

  private event(event: string, body: any = {}): void {
    this.emitter.fire({
      seq: this.seq++, type: 'event', event, body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private async dispatch(req: DapRequest): Promise<void> {
    const a = req.arguments ?? {};
    switch (req.command) {
      case 'initialize':
        this.supportsInvalidated = a.supportsInvalidatedEvent === true;
        this.respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsExceptionInfoRequest: true,
          supportsRestartFrame: true,
          supportsDelayedStackTraceLoading: true,
          // Kein supportsStepBack, kein Stepping: siehe Kopfkommentar.
          exceptionBreakpointFilters: [],
        });
        this.event('initialized');
        return;

      case 'attach':          return this.attach(req);
      case 'configurationDone': this.respond(req); return;
      case 'disconnect':      return this.disconnect(req);
      case 'threads':         return this.threads(req);
      case 'stackTrace':      return this.stackTrace(req, a.startFrame ?? 0, a.levels ?? 200);
      case 'scopes':          return this.scopes(req, a.frameId);
      case 'variables':       this.respond(req, { variables: this.variableSets.get(a.variablesReference) ?? [] }); return;
      case 'evaluate':        return this.evaluate(req, String(a.expression ?? ''), a.frameId, a.context);
      case 'continue':        return this.continue(req);
      case 'pause':           return this.pause(req, a.threadId);
      case 'restartFrame':    return this.restartFrame(req, a.frameId);
      case 'exceptionInfo':   return this.exceptionInfo(req);

      case 'next':
      case 'stepIn':
      case 'stepOut':
        this.fail(req, 1008,
          'Schrittweises Ausführen ist nicht angebunden: SBCL-Stepping ' +
          'braucht das Contrib :swank-stepper und Code, der mit hoher ' +
          'Debug-Qualität kompiliert wurde. Nutze stattdessen die ' +
          'Restarts oder werte Ausdrücke im Frame aus.');
        return;

      case 'setBreakpoints':
        this.respond(req, {
          breakpoints: (a.breakpoints ?? []).map((b: any) => ({
            verified: false, line: b.line,
            message: 'Swank bietet keine portablen Quelltext-Breakpoints. ' +
                     'Der Lisp-Debugger öffnet sich bei Conditions.',
          })),
        });
        return;
      case 'setFunctionBreakpoints': this.respond(req, { breakpoints: [] }); return;
      case 'setExceptionBreakpoints': this.respond(req); return;

      // --- eigene Anfragen -------------------------------------------
      case 'clamps/restarts':
        this.respond(req, { restarts: this.top?.restarts ?? [] });
        return;
      case 'clamps/invokeRestart':
        return this.invokeRestart(req, Number(a.index));
      case 'clamps/abortAll':
        return this.abortAll(req);
      case 'clamps/replEval':
        return this.replEval(req, String(a.code ?? ''), String(a.package ?? 'COMMON-LISP-USER'));
      case 'clamps/bindForInspector':
        return this.bindForInspector(req, String(a.expression ?? ''), a.frameId);
      case 'clamps/bindCondition':
        return this.bindCondition(req);
      case 'clamps/returnFromFrame':
        return this.returnFromFrame(req, Number(a.frameId ?? this.top?.selectedFrame ?? 0), String(a.expression ?? 'nil'));
      case 'clamps/disassembleFrame':
        return this.simpleFrameCall(req, 'swank:disassemble-frame', Number(a.frameId ?? this.top?.selectedFrame ?? 0));

      default:
        this.respond(req);
        return;
    }
  }

  // ------------------------------------------------------------------
  // Verbindung
  // ------------------------------------------------------------------

  private async attach(req: DapRequest): Promise<void> {
    try {
      await this.swank.connect(this.port, this.host);
      // Merken, an welchem Port wir hängen: startet CLAMPS neu, bekommt
      // es einen anderen, und diese Session zeigt dann auf ein totes
      // Image. Ohne den Hinweis sieht das wie ein Fehler im Debugger aus.
      this.event('output', {
        output:
          'Hinweis: Diese Sitzung ist an genau dieses Image gebunden. ' +
          'Nach „CLAMPS: Restart" muss der Debugger neu angehängt werden.\n',
        category: 'console',
      });
      this.event('output', {
        output: `An CLAMPS-Swank auf ${this.host}:${this.port} angehängt.\n`,
        category: 'console',
      });

      // Handshake. SLIME schickt das als allererstes; wir haben es
      // bisher übersprungen. Nebennutzen: die Antwort nennt Version und
      // Kommunikationsstil, was Arity-Unterschiede zwischen Swank-
      // Versionen überhaupt erst erkennbar macht.
      try {
        const info = await this.swank.rex('(swank:connection-info)');
        const version = text(plistGet(info, ':version')) ||
                        text(plistGet(info, ':lisp-implementation'));
        // Der Schlüssel heisst :style, nicht :communication-style.
        const style = text(plistGet(info, ':style'));
        this.event('output', {
          output: `Swank-Version ${version || '?'}, Stil ${style || '?'}\n`,
          category: 'console',
        });
        await this.probeFrameEvalArity();
      } catch (e) {
        // connection-info ist die allererste Anfrage. Antwortet schon
        // die nicht, hängt das Image bereits — meist, weil es aus einem
        // früheren Lauf noch im Lisp-Debugger steht.
        this.event('output', {
          output:
            `Das Image antwortet nicht (${e}).\n` +
            'Vermutlich steht es noch im Lisp-Debugger. Abhilfe: ' +
            '„CLAMPS: Alle Debugger-Ebenen verlassen“, sonst ' +
            '„CLAMPS: Restart“ oder im Terminal `pkill -f bootstrap.lisp`.\n',
          category: 'stderr',
        });
      }
      this.respond(req);
    } catch (e) {
      this.fail(req, 1001, `Verbindung zu Swank fehlgeschlagen: ${e}`);
    }
  }

  /** Parameternamen von eval-string-in-frame in DIESEM Image. */
  private frameEvalParams: string[] = ['string', 'frame', 'package'];

  /**
   * Ermittelt die echte Lambda-Liste von eval-string-in-frame.
   *
   * Nicht über swank:operator-arglist — das ist für die Anzeige gedacht
   * und lässt &optional weg, wodurch fünf Pflichtargumente vorgetäuscht
   * werden. sb-introspect liefert die tatsächliche Liste.
   */
  private async probeFrameEvalArity(): Promise<void> {
    try {
      const r = await this.swank.rex(
        '(swank:eval-and-grab-output ' +
          '"(sb-introspect:function-lambda-list (quote swank:eval-string-in-frame))")',
        this.swank.packageName, new Sym('t'), 8000
      );
      // (ausgabe wert) — der Wert ist die gedruckte Lambda-Liste
      const parts = asList(r);
      // ACHTUNG: function-lambda-list liefert ZWEI Werte (Liste und ein
      // Flag), und eval-and-grab-output druckt beide untereinander. Ohne
      // die erste Zeile herauszuschneiden zählt das angehängte NIL als
      // zusätzlicher Parameter mit.
      const raw = (text(parts[1]) || text(r)).trim();
      const arglist = raw.split(/[\r\n]+/)[0].trim();
      if (!arglist) return;

      const tokens = arglist.replace(/^\(|\)$/g, '').trim().split(/\s+/);
      const required: string[] = [];
      for (const t of tokens) {
        if (t.startsWith('&')) break; // &optional / &rest / &key
        if (!t) continue;
        // Paketpräfix abstreifen: swank::frame -> frame
        required.push(t.toLowerCase().replace(/^[^:]*::?/, ''));
      }
      if (required.length >= 2) {
        this.frameEvalParams = required;
        this.frameEvalArity = required.length;
      }
      this.event('output', {
        output:
          `eval-string-in-frame ${arglist} — ` +
          `${this.frameEvalArity} Pflichtargumente (${this.frameEvalParams.join(', ')})\n`,
        category: 'console',
      });
    } catch (e) {
      this.event('output', {
        output: `Lambda-Liste von eval-string-in-frame nicht ermittelbar (${e}); nehme 3 an.\n`,
        category: 'stderr',
      });
    }
  }

  /**
   * Aufrufform für eine Auswertung im Frame.
   *
   * Nach Parameternamen befüllt, nicht nach Position: lines und width
   * sind Druckparameter und wollen Zahlen. Mit nil aufgefüllt quittierte
   * Lisp mit "The value nil is not of type number".
   */
  private frameEvalForm(expression: string, frameId: number): string {
    const byName: Record<string, string> = {
      string: JSON.stringify(expression),
      frame: String(frameId),
      package: JSON.stringify(this.swank.packageName),
      lines: '10',
      width: '80',
      'print-right-margin': '80',
      'print-lines': '10',
    };
    const args = this.frameEvalParams.map(p => byName[p] ?? 'nil');
    return `(swank:eval-string-in-frame ${args.join(' ')})`;
  }

  private async disconnect(req: DapRequest): Promise<void> {
    // Steckt das Image noch im Debugger, würde ein blosses Trennen es
    // dort stehen lassen — also vorher abbrechen.
    const abort = this.top?.restarts.find(r => r.name.toUpperCase() === 'ABORT');
    if (this.top && abort) {
      try {
        await this.swank.rex(
          `(swank:invoke-nth-restart-for-emacs ${this.top.level} ${abort.index})`,
          this.swank.packageName, this.thread
        );
      } catch {
        // Beim Trennen nicht weiter stören.
      }
    }
    this.swank.close();
    this.respond(req);
  }

  // ------------------------------------------------------------------
  // Debugger-Ereignisse
  // ------------------------------------------------------------------

  private onDebug(msg: SExpr): void {
    const m = asList(msg);
    // (:debug thread level condition restarts frames continuations)
    const condRaw = asList(m[3]);
    const level: DebugLevel = {
      thread: m[1] ?? new Sym('t'),
      level: Number(m[2] ?? this.levels.length + 1),
      condition: text(condRaw[0]),
      conditionType: text(condRaw[1]) || 'LISP-CONDITION',
      restarts: asList(m[4]).map((r, index) => {
        const x = asList(r);
        return {
          index,
          name: text(x[0]) || `RESTART-${index}`,
          description: text(x[1]),
        };
      }),
      frames: asList(m[5]),
      selectedFrame: 0,
    };
    this.levels.push(level);
    this.variableSets.clear();
    this.frameSources.clear();
    this.warnedAboutOpenDebugger = false;

    // Die ID aus der Debug-Nachricht übernehmen, damit `threads` und
    // `stopped` dieselbe meinen.
    this.stoppedThreadId = typeof m[1] === 'number' ? (m[1] as number) : 1;

    // Nur der auslösenden REPL-Anfrage die Frist nehmen — sie bleibt bis
    // zum Restart offen. Alle anderen Anfragen (Threads, Frames, Hover)
    // behalten ihre Frist. Das pauschale Löschen aller Fristen war ein
    // Fehler: es liess unbeteiligte Anfragen bei ausbleibender Antwort
    // für immer offen.
    if (this.inflightRepl) {
      this.swank.clearRequestTimeout(this.inflightRepl.swankId);

      // Den DAP-Request SOFORT beantworten, statt die Kette
      // REPL→DAP→Swank→Restart offen zu halten. Sonst bleibt das REPL-
      // Terminal busy, während der Debugger auf einen Restart wartet,
      // der wiederum über denselben blockierten Kanal ausgelöst würde.
      if (!this.inflightRepl.answered) {
        this.inflightRepl.answered = true;
        this.respond(this.inflightRepl.req, {
          status: 'debugging',
          output: '; Lisp-Debugger offen — Restart im Debug-Bereich wählen.',
          package: this.inflightRepl.pkg,
        });
      }
    }

    this.event('output', {
      output:
        `\nLisp-Debugger, Ebene ${level.level}: ${level.condition} ` +
        `(Thread ${printSexpr(level.thread)}, ${level.frames.length} Frames) ` +
        `[${level.conditionType}]\n` +
        level.restarts.map(r => `  ${r.index}: [${r.name}] ${r.description}`).join('\n') +
        '\n; Ziffer eintippen wählt den Restart. ,abort verlässt alle Ebenen. ' +
        'Aufrufliste und Variablen stehen im Debug-Bereich (Cmd+Shift+D).\n',
      category: 'stderr',
    });
    this.event('stopped', {
      reason: 'exception',
      threadId: this.stoppedThreadId,
      text: level.condition,
      description: level.conditionType,
      allThreadsStopped: false,
    });
  }

  private onDebugReturn(msg: SExpr): void {
    const m = asList(msg);
    const level = Number(m[2] ?? 0);
    // Genau die verlassene Ebene entfernen, nicht blind leeren — sonst
    // verliert ein rekursiver Debugger beim Verlassen der inneren Ebene
    // auch die äußere.
    const at = this.levels.findIndex(l => l.level === level);
    if (at >= 0) this.levels.splice(at);
    else this.levels.pop();
    this.variableSets.clear();
    this.frameSources.clear();

    if (this.levels.length > 0) {
      // Zurück in den äußeren Debugger: erneut als gestoppt melden.
      const outer = this.top!;
      this.event('stopped', {
        reason: 'exception', threadId: this.stoppedThreadId,
        text: outer.condition, description: outer.conditionType,
        allThreadsStopped: false,
      });
    } else {
      this.event('continued', { threadId: this.stoppedThreadId, allThreadsContinued: false });
      // Alle Ebenen verlassen: eine noch registrierte REPL-Auswertung
      // ist damit erledigt.
      if (this.inflightRepl?.answered) this.inflightRepl = undefined;
    }
  }

  // ------------------------------------------------------------------
  // Threads, Stack, Variablen
  // ------------------------------------------------------------------

  private async threads(req: DapRequest): Promise<void> {
    const threads: any[] = [];
    try {
      const result = await this.swank.rex('(swank:list-threads)', undefined, undefined, 5000);
      const rows = asList(result);
      this.threadMap.clear();
      // Erste Zeile ist bei list-threads die Spaltenüberschrift.
      rows.slice(1).forEach((row, i) => {
        const x = asList(row);
        const id = typeof x[0] === 'number' ? (x[0] as number) : i + 1;
        this.threadMap.set(id, x[0] ?? id);
        threads.push({ id, name: `${text(x[1]) || 'thread'} (${id})` });
      });
    } catch {
      // list-threads ist Beiwerk; die Aufrufliste darf nicht daran hängen.
    }

    // Der angehaltene Thread MUSS dabei sein, sonst zeigt VS Code keine
    // Aufrufliste — auch dann, wenn list-threads ihn nicht auflistet
    // oder ganz fehlschlägt.
    if (this.top && !threads.some(t => t.id === this.stoppedThreadId)) {
      threads.unshift({
        id: this.stoppedThreadId,
        name: `Lisp (angehalten, Ebene ${this.top.level})`,
      });
    }
    if (threads.length === 0) {
      threads.push({ id: this.stoppedThreadId, name: 'CLAMPS / Lisp' });
    }
    this.respond(req, { threads });
  }

  private async stackTrace(req: DapRequest, start: number, levels: number): Promise<void> {
    const state = this.top;
    if (!state) {
      this.respond(req, { stackFrames: [], totalFrames: 0 });
      return;
    }

    // Die Frames stehen bereits in der :debug-Nachricht. Erst antworten,
    // dann erst — falls überhaupt — Quellorte nachreichen.
    //
    // Die frühere Fassung holte für JEDEN Frame swank:frame-source-location,
    // und zwar über den Thread, der im Debugger steht. Bei 200 Frames
    // waren das 200 parallele Anfragen an genau den Kanal, der ohnehin
    // empfindlich ist; die Aufrufliste kam nie zustande.
    let frames = state.frames;
    if (frames.length === 0) {
      try {
        const more = await this.swank.rex(
          `(swank:backtrace ${start} ${start + levels})`,
          this.swank.packageName, state.thread, 5000
        );
        frames = asList(more);
        state.frames = frames;
      } catch (e) {
        this.event('output', {
          output: `Backtrace nicht abrufbar: ${e}\n`,
          category: 'stderr',
        });
      }
    }

    const slice = frames.slice(start, start + levels);
    const out = slice.map((f, i) => {
      const x = asList(f);
      const id = typeof x[0] === 'number' ? (x[0] as number) : start + i;
      const src = this.frameSources.get(id);
      return {
        id,
        name: text(x[1]) || `Frame ${id}`,
        line: src?.line ?? 0,
        column: src?.column ?? 0,
        source: src?.path
          ? { name: src.path.split('/').pop(), path: src.path }
          : undefined,
        // KEIN presentationHint 'subtle' für quellenlose Frames: VS Code
        // klappt subtle-Frames hinter "Show N More Stack Frames"
        // zusammen. Bei Lisp hat der Grossteil der Frames keinen
        // Quellort, also verschwände fast der ganze Backtrace.
      };
    });

    this.respond(req, {
      stackFrames: out,
      totalFrames: Math.max(frames.length, start + out.length),
    });

    // Quellorte im Hintergrund nachladen, nur für die obersten Frames.
    // Kommt etwas zurück, meldet ein 'invalidated'-Ereignis VS Code,
    // dass die Aufrufliste neu geholt werden soll.
    void this.enrichSources(slice.slice(0, 5), start);
  }

  /** frameId -> Quellort, einmal ermittelt und gemerkt. */
  private frameSources = new Map<number, { path?: string; line: number; column: number }>();

  private async enrichSources(frames: SExpr[], start: number): Promise<void> {
    let changed = false;
    for (let i = 0; i < frames.length; i++) {
      const x = asList(frames[i]);
      const id = typeof x[0] === 'number' ? (x[0] as number) : start + i;
      if (this.frameSources.has(id)) continue;
      try {
        // Nacheinander, nicht parallel: der Debugger-Thread verarbeitet
        // ohnehin seriell, und ein Schwall Anfragen bringt nichts.
        const src = await this.frameSource(id);
        if (src) {
          this.frameSources.set(id, src);
          changed = true;
        }
      } catch {
        // Ohne Debug-Info gibt es keinen Quellort — kein Fehler.
      }
    }
    // Nur senden, wenn der Client das Ereignis überhaupt angekündigt hat —
    // sonst ist es im besten Fall wirkungslos.
    if (changed && this.supportsInvalidated) {
      this.event('invalidated', { areas: ['stacks'] });
    }
  }

  private async frameSource(
    frameId: number
  ): Promise<{ path?: string; line: number; column: number } | undefined> {
    const x = await this.swank.rex(
      `(swank:frame-source-location ${frameId})`,
      this.swank.packageName, this.thread, 4000
    );
    const list = asList(x);
    // (:location (:file "…") (:position N) …) oder (:error "…")
    if (isSym(list[0], ':error')) return undefined;
    const flat = printSexpr(x);
    const file = /:file\s+"([^"]+)"/i.exec(flat)?.[1];
    const line = /:line\s+(\d+)/i.exec(flat)?.[1];
    const col = /:column\s+(\d+)/i.exec(flat)?.[1];
    if (!file) return undefined;
    const path = file.startsWith('/') ? file : `${this.workspaceRoot}/${file}`;
    return { path, line: Number(line ?? 1), column: Number(col ?? 1) };
  }

  private async scopes(req: DapRequest, frameId: number): Promise<void> {
    const state = this.top;
    if (!state) {
      this.respond(req, { scopes: [] });
      return;
    }
    state.selectedFrame = frameId;
    try {
      const result = await this.swank.rex(
        `(swank:frame-locals-and-catch-tags ${frameId})`,
        this.swank.packageName, state.thread
      );
      // Format laut Swank: (locals catch-tags), locals sind Plists
      // (:name NAME :id ID :value VALUE-STRING). Der Prototyp hat die
      // Struktur per Array-Proben geraten; hier wird sie gelesen.
      const outer = asList(result);
      const locals = asList(outer[0]).map((entry, i) => {
        const name = text(plistGet(entry, ':name')) || `local-${i}`;
        return {
          name,
          value: text(plistGet(entry, ':value')),
          variablesReference: 0,
          evaluateName: name,
        };
      });
      const catches = asList(outer[1]).map((tag, i) => ({
        name: `tag-${i}`,
        value: text(tag),
        variablesReference: 0,
      }));

      const scopes: any[] = [
        { name: 'Locals', variablesReference: this.store(locals), expensive: false },
      ];
      if (catches.length) {
        scopes.push({ name: 'Catch-Tags', variablesReference: this.store(catches), expensive: false });
      }
      this.respond(req, { scopes });
    } catch (e) {
      this.fail(req, 1002, String(e));
    }
  }

  private store(vars: any[]): number {
    const ref = this.nextVarRef++;
    this.variableSets.set(ref, vars);
    return ref;
  }

  // ------------------------------------------------------------------
  // Auswerten und Restarts
  // ------------------------------------------------------------------

  private async evaluate(
    req: DapRequest, expression: string, frameId?: number, context?: string
  ): Promise<void> {
    if (expression.startsWith(',')) return this.consoleCommand(req, expression);

    // Blosse Ziffer bei offenem Debugger = Restart wählen, wie in SLDB.
    // In Emacs ist 0/1/2 eine Tastenbindung; hier ist es eine Eingabe-
    // zeile, die die Zahl sonst als Lisp-Ausdruck auswertet und
    // wortwörtlich 0 zurückgibt — was aussieht, als passiere nichts.
    const bare = expression.trim();
    if (this.top && /^\d+$/.test(bare)) {
      const n = Number(bare);
      if (n < this.top.restarts.length) return this.invokeRestart(req, n);
      this.respond(req, {
        result:
          `; Restart ${n} gibt es nicht (0–${this.top.restarts.length - 1}). ` +
          `Zum Auswerten der Zahl: ,eval ${n}`,
        variablesReference: 0,
      });
      return;
    }

    // Hinweis genau einmal pro Debugger-Ebene, nicht bei jeder Eingabe.
    if (this.top && frameId === undefined && !this.warnedAboutOpenDebugger) {
      this.warnedAboutOpenDebugger = true;
      this.event('output', {
        output:
          '; Der Lisp-Debugger ist offen. Diese Auswertung läuft in einem ' +
          'eigenen Thread, nicht im angehaltenen. Für Auswertung IM Frame ' +
          'zuerst einen Frame in der Aufrufliste auswählen.\n',
        category: 'console',
      });
    }
    return this.evaluateForms(req, expression, frameId, context);
  }

  private async evaluateForms(
    req: DapRequest, expression: string, frameId?: number, context?: string
  ): Promise<void> {
    try {
      const state = this.top;
      if (state && frameId !== undefined) state.selectedFrame = frameId;
      // eval-and-grab-output hat als einziger Einstiegspunkt eine
      // definierte Rückgabe: (ausgabe wert-als-string). interactive-eval
      // quittierte hier jeden Ausdruck mit einem Arity-Fehler,
      // listener-eval antwortete gar nicht — beides ungeklärt. Statt
      // weiter zu raten wird jetzt die gesendete Form in jeder
      // Fehlermeldung mitgeführt.
      // Mehrere Formen einzeln schicken: eval-and-grab-output liest nur
      // die erste. Ohne das verschwinden alle weiteren stillschweigend.
      const forms =
        state && frameId !== undefined ? [expression] : splitTopLevelForms(expression);
      const chunks: string[] = [];
      for (const raw of forms.length > 1 ? forms : [expression]) {
        // Hover-Auswertungen in ignore-errors kapseln.
        //
        // VS Code schickt bei eingeschaltetem supportsEvaluateForHovers
        // ALLES, worüber die Maus fährt — auch Dateinamen und Kommentar-
        // wörter. Jeder Fehlschlag öffnete eine neue Debugger-Ebene;
        // beim Überfahren von swank.lisp stapelten sich so binnen
        // Sekunden mehrere Ebenen, bis das Image nicht mehr antwortete.
        // (values ...) drumherum kappt den zweiten Rückgabewert:
        // ignore-errors liefert bei einem Fehler nil UND das
        // Condition-Objekt, was im Tooltip als
        // "nil, #<unbound-variable rpc …>" landete.
        // Hover NIE im Frame auswerten.
        //
        // ignore-errors nützt im Frame nichts: eval-string-in-frame läuft
        // mit aktivem SLDB-Debugger-Hook, sodass Swank bei einer Condition
        // in den Debugger springt, BEVOR der Handler sie fangen kann. Ein
        // Hover über ein unbekanntes Wort (etwa "n" in der REPL-Anleitung)
        // öffnete so bei ausgewähltem Frame eine neue Ebene je Mausbewegung.
        // Auf oberster Ebene (eval-and-grab-output) fängt ignore-errors
        // dagegen zuverlässig.
        const asHover = context === 'hover';
        const single = asHover ? `(values (ignore-errors ${raw}))` : raw;
        const useFrame = state && frameId !== undefined && !asHover;
        const one = useFrame
          ? this.frameEvalForm(single, frameId!)
          : `(swank:eval-and-grab-output ${JSON.stringify(single)})`;
        this.lastForm = one;
        // WICHTIG: nur eine Auswertung IM FRAME geht an den angehaltenen
        // Thread. Alles andere bekommt einen frischen Worker (Thread-
        // Bezeichner t).
        //
        // Der Thread im Debugger sitzt in Swanks SLDB-Schleife; ein
        // gewöhnlicher :emacs-rex dorthin quittiert mit einem
        // Arity-Fehler und öffnet eine weitere Debugger-Ebene. Genau so
        // kam die Kette Ebene 2, 3, 4 zustande — und am Ende hing das
        // Image, weil sich die Ebenen stapelten.
        const target = useFrame ? this.thread : new Sym('t');
        const r = await this.swank.rex(one, this.swank.packageName, target);
        const p = asList(r);
        const shown =
          p.length >= 2
            ? [text(p[0]), text(p[1])].filter(x => x !== '').join('\n')
            : text(r);
        chunks.push(shown);
      }
      const rendered = chunks.filter(c => c !== '').join('\n');

      this.respond(req, {
        // Leeres Ergebnis sichtbar machen: sonst ist "erfolgreich, aber
        // kein Wert" von "gar keine Antwort" nicht zu unterscheiden.
        // Beim Hover bleibt es leer, sonst klebt an jedem Wort ein
        // Tooltip mit "kein Wert".
        result: rendered === '' ? (context === 'hover' ? '' : '; kein Wert') : rendered,
        variablesReference: 0,
        presentationHint: context === 'hover' ? { kind: 'property' } : undefined,
      });
    } catch (e) {
      // Ein aufgerufener Restart bricht die laufende Auswertung ab —
      // Swank antwortet dann mit (:abort …). Das ist der gewollte
      // Ausgang und keine Störung.
      if (/:abort/i.test(String(e))) {
        this.respond(req, {
          result: '; Auswertung durch Restart abgebrochen',
          variablesReference: 0,
        });
        return;
      }
      if (context === 'hover') {
        // Ein fehlgeschlagener Hover ist kein Ereignis, über das der
        // Nutzer informiert werden will.
        this.respond(req, { result: '', variablesReference: 0 });
        return;
      }
      // Die gesendete Form gehört in die Meldung — ohne sie bleibt bei
      // einem Protokollproblem nur Raten.
      this.fail(req, 1003, `${e}\n  gesendet: ${this.lastForm}`);
    }
  }

  private async consoleCommand(req: DapRequest, line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'restarts':
        this.respond(req, {
          result:
            this.top?.restarts.map(r => `${r.index}: [${r.name}] ${r.description}`).join('\n') ||
            'Kein aktiver Debugger.',
          variablesReference: 0,
        });
        return;
      case 'restart':
        return this.invokeRestart(req, Number(rest[0]));
      case 'return':
        return this.returnFromFrame(req, this.top?.selectedFrame ?? 0, arg || 'nil');
      case 'disassemble':
        return this.simpleFrameCall(req, 'swank:disassemble-frame',
          Number(rest[0] ?? this.top?.selectedFrame ?? 0));
      case 'eval':
        // Fluchtweg, um bei offenem Debugger doch eine Zahl auszuwerten.
        return this.evaluateForms(req, arg, undefined, 'repl');
      case 'abort':
        return this.abortAll(req);
      default:
        this.respond(req, {
          result:
            'Befehle: ZIFFER (Restart wählen) | ,restarts | ,restart N | ,abort\n' +
            '         ,eval AUSDRUCK | ,return AUSDRUCK | ,disassemble [N]',
          variablesReference: 0,
        });
    }
  }

  /**
   * Restart aufrufen und die Antwort abwarten. Der Prototyp feuerte ein
   * rohes Rex mit der fest verdrahteten ID 9000001 ab — zwei Aufrufe
   * hintereinander hätten dieselbe ID benutzt.
   */
  private async invokeRestart(req: DapRequest, index: number): Promise<void> {
    const state = this.top;
    if (!state) {
      this.fail(req, 1006, 'Kein aktiver Lisp-Debugger.');
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= state.restarts.length) {
      this.fail(req, 1007, `Restart ${index} gibt es nicht.`);
      return;
    }
    const chosen = state.restarts[index];
    this.event('output', {
      output: `Restart ${index}: [${chosen.name}] ${chosen.description}\n`,
      category: 'console',
    });
    try {
      // Die Antwort kommt erst, wenn der Restart durchgelaufen ist —
      // das kann dauern und ist kein Fehler.
      // Restarts sind SLDB-Kommandos und gehören an den angehaltenen
      // Thread — anders als gewöhnliche Auswertungen.
      void this.swank
        .rex(`(swank:invoke-nth-restart-for-emacs ${state.level} ${index})`,
             this.swank.packageName, state.thread, 0)
        .catch(e => {
          // Ein Restart, der den Stack abwickelt, beendet die laufende
          // Anfrage mit (:abort …). Das ist der Normalfall und keine
          // Störung — nur alles andere ist meldenswert.
          if (!/:abort/i.test(String(e))) {
            this.event('output', {
              output: `Restart ${index} fehlgeschlagen: ${e}\n`,
              category: 'stderr',
            });
          }
        });
      this.respond(
        req,
        req.command === 'continue'
          ? { allThreadsContinued: false }
          : req.command === 'evaluate'
            ? { result: `; Restart ${index} [${chosen.name}] aufgerufen`,
                variablesReference: 0 }
            : { invoked: index }
      );
    } catch (e) {
      this.fail(req, 1007, String(e));
    }
  }

  /**
   * DAP "Continue" auf einen Restart abbilden. Die Wahl ist nicht
   * eindeutig — CONTINUE, falls es ihn gibt, sonst ABORT, sonst der
   * erste. Welcher genommen wurde, steht in der Konsole, damit das
   * nicht raten bleibt.
   */
  private async continue(req: DapRequest): Promise<void> {
    const state = this.top;
    if (!state || state.restarts.length === 0) {
      this.fail(req, 1006, 'Kein aktiver Lisp-Debugger.');
      return;
    }
    const byName = (n: string) =>
      state.restarts.findIndex(r => r.name.toUpperCase() === n);
    const index = [byName('CONTINUE'), byName('ABORT')].find(i => i >= 0) ?? 0;
    return this.invokeRestart(req, index);
  }

  /**
   * Zurück auf die oberste Ebene. Häuft sich der Debugger auf mehrere
   * Ebenen (jeder fehlgeschlagene Eval legt eine drauf), ist das der
   * kürzeste Weg heraus. SLIME nennt diesen Restart *ABORT.
   */
  private async abortAll(req: DapRequest): Promise<void> {
    const state = this.top;
    if (!state) {
      this.respond(req, { aborted: false });
      return;
    }
    const idx = state.restarts.findIndex(r => r.name.toUpperCase() === '*ABORT');
    if (idx < 0) {
      this.fail(req, 1023, 'Kein *ABORT-Restart vorhanden.');
      return;
    }
    return this.invokeRestart(req, idx);
  }

  /**
   * Auswertung für das CLAMPS-REPL-Terminal über DIESE Verbindung.
   *
   * Der Sinn: Fehler aus der REPL sollen den Debugger öffnen. Über die
   * Bridge geht das nicht — dort fängt eval-for-repl jede Condition ab,
   * und selbst ohne das könnte die Bridge ein :debug-Ereignis nicht
   * weiterreichen. Läuft die Auswertung dagegen über den Debug-Socket,
   * kommt das Ereignis hier an und VS Code öffnet den Debugger.
   *
   * Ohne Frist: tritt der Debugger auf den Plan, antwortet Swank erst,
   * wenn ein Restart gewählt wurde. Das kann beliebig lange dauern und
   * ist kein Fehler.
   */
  private async replEval(req: DapRequest, code: string, pkg: string): Promise<void> {
    if (!code.trim()) {
      this.respond(req, { status: 'ok', output: '', package: pkg });
      return;
    }
    // Nur eine REPL-Auswertung gleichzeitig. Läuft schon eine (im
    // Debugger wartend), diese ablehnen statt die Verfolgung zu verlieren.
    if (this.inflightRepl && !this.inflightRepl.answered) {
      this.respond(req, {
        status: 'busy',
        output: '; Vorherige Auswertung steht noch im Debugger. Erst Restart wählen.',
        package: pkg,
      });
      return;
    }

    const entry = { swankId: -1, req, pkg, answered: false };
    this.inflightRepl = entry;
    try {
      // Frist bleibt gesetzt: öffnet sich der Debugger, wird sie in
      // onDebug gezielt für DIESE Anfrage gelöscht. Bleibt dagegen eine
      // Antwort ohne Debugger aus (Funktion fehlt im Image), greift der
      // Timeout und die REPL hängt nicht stumm.
      const r = await this.swank.rex(
        `(clamps-bridge-rpc:eval-for-repl-debuggable ${JSON.stringify(code)} ${JSON.stringify(pkg)})`,
        pkg, new Sym('t'), 15000,
        id => { entry.swankId = id; }
      );
      // Kam eine echte Antwort (kein Debugger), normal beantworten —
      // sofern onDebug den Request nicht schon gelöst hat.
      const parts = asList(r);
      if (!entry.answered) {
        entry.answered = true;
        this.respond(req, {
          status: 'ok',
          output: text(parts[1]),
          package: text(parts[2]) || pkg,
        });
      } else {
        // Der Debugger hatte den Request bereits beantwortet; die
        // Auswertung ist danach doch noch normal zu Ende gelaufen (etwa
        // nach [continue]). Ergebnis als Ausgabe nachschieben.
        this.event('output', {
          output: `${text(parts[1])}\n`,
          category: 'stdout',
        });
      }
    } catch (e) {
      if (entry.answered) {
        // Schon beantwortet (Debugger); ein danach eintreffender
        // (:abort …) ist der normale Ausgang eines Restarts.
        if (!/:abort/i.test(String(e))) {
          this.event('output', {
            output: `; REPL-Auswertung: ${e}\n`, category: 'stderr',
          });
        }
        return;
      }
      // Ein Restart, der abbricht, beendet die Auswertung mit (:abort …).
      const msg = String(e);
      const aborted = /:abort/i.test(msg);
      const timedOut = /Keine Antwort von Swank/.test(msg);
      entry.answered = true;
      this.respond(req, {
        status: aborted ? 'aborted' : 'error',
        output: aborted
          ? '; durch Restart abgebrochen'
          : timedOut
            ? msg +
              '\n; Prüfe, ob das laufende Image die Funktion kennt:\n' +
              ";   (fboundp 'clamps-bridge-rpc::eval-for-repl-debuggable)\n" +
              '; Kommt NIL, hilft „CLAMPS: Restart“.'
            : msg,
        package: pkg,
      });
    } finally {
      if (this.inflightRepl === entry && entry.answered) {
        this.inflightRepl = undefined;
      }
    }
  }

  private pause(req: DapRequest, threadId: number): void {
    try {
      this.swank.interrupt(this.threadMap.get(threadId) ?? new Sym('t'));
      this.respond(req);
    } catch (e) {
      this.fail(req, 1004, String(e));
    }
  }

  private async restartFrame(req: DapRequest, frameId: number): Promise<void> {
    try {
      await this.swank.rex(`(swank:restart-frame ${frameId})`, this.swank.packageName, this.thread);
      this.respond(req);
    } catch (e) {
      this.fail(req, 1009, String(e));
    }
  }

  private async returnFromFrame(req: DapRequest, frameId: number, expression: string): Promise<void> {
    try {
      const x = await this.swank.rex(
        `(swank:return-from-frame ${frameId} ${JSON.stringify(expression)})`,
        this.swank.packageName, this.thread
      );
      this.respond(req, { result: text(x) || 'ok', variablesReference: 0 });
    } catch (e) {
      this.fail(req, 1010, String(e));
    }
  }

  private async simpleFrameCall(req: DapRequest, fn: string, frameId: number): Promise<void> {
    try {
      const x = await this.swank.rex(`(${fn} ${frameId})`, this.swank.packageName, this.thread);
      this.respond(req, { result: text(x), variablesReference: 0 });
    } catch (e) {
      this.fail(req, 1011, String(e));
    }
  }

  // terminateThreads bewusst NICHT angeboten.
  //
  // swank:kill-nth-thread erwartet einen INDEX in Swanks Threadliste,
  // während wir gegenüber VS Code die Thread-IDs aus der :debug-Nachricht
  // führen. Beides zu verwechseln heisst, einen beliebigen Thread zu
  // killen — trifft es den Control- oder Reader-Thread, ist das ganze
  // Image weg, ohne dass irgendwo ein Fehler protokolliert würde. Und
  // VS Code bietet "Thread beenden" im Kontextmenü der Aufrufliste an,
  // sobald man die Fähigkeit meldet. Threads zu töten gehört ohnehin
  // nicht in eine Debugger-Oberfläche; dafür gibt es die Restarts.

  private exceptionInfo(req: DapRequest): void {
    const s = this.top;
    this.respond(req, {
      exceptionId: s?.conditionType ?? 'LISP-CONDITION',
      description: s?.condition ?? 'Keine aktive Condition',
      breakMode: 'always',
      details: { message: s?.condition ?? '', typeName: s?.conditionType ?? '' },
    });
  }

  // ------------------------------------------------------------------
  // Übergabe an den vorhandenen Inspector
  // ------------------------------------------------------------------

  /**
   * Bindet einen Wert an ein frisch erzeugtes Symbol in CL-USER und
   * liefert dessen Namen zurück. Der bestehende Inspector kann darauf
   * angesetzt werden, ohne dass hier ein zweites Inspector-Modell
   * entsteht — und die Objektidentität bleibt erhalten, weil der Wert
   * nicht neu berechnet, sondern nur benannt wird.
   */
  private async bind(expression: string, frameId?: number): Promise<{ expression: string; package: string }> {
    const token = `CLAMPS-DEBUG-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const bind = `(setf (symbol-value (intern ${JSON.stringify(token)} "COMMON-LISP-USER")) ${expression})`;
    const form =
      frameId !== undefined
        ? this.frameEvalForm(bind, frameId)
        : `(swank:eval-and-grab-output ${JSON.stringify(bind)})`;
    // Ohne Frame in einen frischen Worker, aus demselben Grund wie bei
    // evaluate: der angehaltene Thread nimmt keine gewöhnlichen Anfragen.
    const target = frameId !== undefined ? this.thread : new Sym('t');
    await this.swank.rex(form, this.swank.packageName, target);
    return { expression: `common-lisp-user::|${token}|`, package: 'COMMON-LISP-USER' };
  }

  private async bindForInspector(req: DapRequest, expression: string, frameId?: number): Promise<void> {
    if (!expression.trim()) {
      this.fail(req, 1020, 'Kein Ausdruck angegeben.');
      return;
    }
    try {
      this.respond(req, await this.bind(expression, frameId ?? this.top?.selectedFrame));
    } catch (e) {
      this.fail(req, 1021, `Wert konnte nicht für den Inspector gebunden werden: ${e}`);
    }
  }

  private async bindCondition(req: DapRequest): Promise<void> {
    try {
      // Swank hält die aktive Condition in SWANK::*SLDB-CONDITION*.
      // find-symbol statt direkter Referenz, weil der Export zwischen
      // Swank-Versionen schwankt.
      const expr =
        `(let ((s (find-symbol "*SLDB-CONDITION*" "SWANK"))) ` +
        `(if (and s (boundp s)) (symbol-value s) ` +
        `(error "Dieses Swank stellt die aktive Condition nicht bereit.")))`;
      this.respond(req, await this.bind(expr, this.top?.selectedFrame ?? 0));
    } catch (e) {
      this.fail(req, 1022, `Condition konnte nicht gebunden werden: ${e}`);
    }
  }
}
