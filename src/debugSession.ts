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
  private threadMap = new Map<number, SExpr>();
  private readonly dapThreadId = 1;

  constructor(
    private readonly port: number,
    private readonly workspaceRoot: string,
    private readonly host = '127.0.0.1'
  ) {
    // Rohverkehr mitschreiben, wenn clamps.debugTrace gesetzt ist.
    // Ohne das bleibt bei einem unerwarteten Fehler nur Raten, welche
    // Form tatsächlich über die Leitung ging.
    if (vscode.workspace.getConfiguration('clamps').get<boolean>('debugTrace', false)) {
      this.swank.on('wire', (dir: string, payload: string) =>
        this.event('output', {
          output: `${dir} ${payload}\n`,
          category: 'console',
        })
      );
    }

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
    Promise.resolve(this.dispatch(req)).catch(e =>
      this.fail(req, 9999, e instanceof Error ? e.message : String(e))
    );
  }

  dispose(): void {
    this.swank.close();
    this.emitter.dispose();
  }

  private respond(req: DapRequest, body: any = {}): void {
    this.emitter.fire({
      seq: this.seq++, type: 'response', request_seq: req.seq,
      command: req.command, success: true, body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private fail(req: DapRequest, id: number, message: string): void {
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
        this.respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsExceptionInfoRequest: true,
          supportsRestartFrame: true,
          supportsTerminateThreadsRequest: true,
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
      case 'terminateThreads': return this.terminateThreads(req, a.threadIds ?? []);
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
        const style = text(plistGet(info, ':communication-style'));
        this.event('output', {
          output: `Swank-Version ${version || '?'}, Stil ${style || '?'}\n`,
          category: 'console',
        });
      } catch (e) {
        this.event('output', {
          output: `connection-info fehlgeschlagen: ${e}\n`,
          category: 'stderr',
        });
      }
      this.respond(req);
    } catch (e) {
      this.fail(req, 1001, `Verbindung zu Swank fehlgeschlagen: ${e}`);
    }
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

    this.event('output', {
      output:
        `\nLisp-Debugger, Ebene ${level.level}: ${level.condition} ` +
        `[${level.conditionType}]\n` +
        level.restarts.map(r => `  ${r.index}: [${r.name}] ${r.description}`).join('\n') +
        '\n',
      category: 'stderr',
    });
    this.event('stopped', {
      reason: 'exception',
      threadId: this.dapThreadId,
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

    if (this.levels.length > 0) {
      // Zurück in den äußeren Debugger: erneut als gestoppt melden.
      const outer = this.top!;
      this.event('stopped', {
        reason: 'exception', threadId: this.dapThreadId,
        text: outer.condition, description: outer.conditionType,
        allThreadsStopped: false,
      });
    } else {
      this.event('continued', { threadId: this.dapThreadId, allThreadsContinued: false });
    }
  }

  // ------------------------------------------------------------------
  // Threads, Stack, Variablen
  // ------------------------------------------------------------------

  private async threads(req: DapRequest): Promise<void> {
    try {
      const result = await this.swank.rex('(swank:list-threads)');
      const rows = asList(result);
      const threads: any[] = [];
      this.threadMap.clear();
      // Erste Zeile ist bei list-threads die Spaltenüberschrift.
      rows.slice(1).forEach((row, i) => {
        const x = asList(row);
        const id = typeof x[0] === 'number' ? (x[0] as number) : i + 1;
        this.threadMap.set(id, x[0] ?? id);
        threads.push({ id, name: `${text(x[1]) || 'thread'} (${id})` });
      });
      if (threads.length === 0) threads.push({ id: this.dapThreadId, name: 'CLAMPS / Lisp' });
      this.respond(req, { threads });
    } catch {
      this.respond(req, { threads: [{ id: this.dapThreadId, name: 'CLAMPS / Lisp' }] });
    }
  }

  private async stackTrace(req: DapRequest, start: number, levels: number): Promise<void> {
    const state = this.top;
    if (!state) {
      this.respond(req, { stackFrames: [], totalFrames: 0 });
      return;
    }
    try {
      let frames = state.frames;
      if (start + levels > frames.length) {
        const more = await this.swank.rex(
          `(swank:backtrace ${start} ${start + levels})`,
          this.swank.packageName, state.thread
        );
        const list = asList(more);
        if (list.length) {
          frames = list;
          state.frames = list;
        }
      }
      const slice = frames.slice(start, start + levels);
      const out = await Promise.all(slice.map(async (f, i) => {
        const x = asList(f);
        const id = typeof x[0] === 'number' ? (x[0] as number) : start + i;
        const src = await this.frameSource(id).catch(() => undefined);
        return {
          id,
          name: text(x[1]) || `Frame ${id}`,
          line: src?.line ?? 0,
          column: src?.column ?? 0,
          source: src?.path
            ? { name: src.path.split('/').pop(), path: src.path }
            : undefined,
        };
      }));
      this.respond(req, { stackFrames: out, totalFrames: Math.max(frames.length, start + out.length) });
    } catch (e) {
      this.fail(req, 1005, String(e));
    }
  }

  private async frameSource(
    frameId: number
  ): Promise<{ path?: string; line: number; column: number } | undefined> {
    const x = await this.swank.rex(
      `(swank:frame-source-location ${frameId})`,
      this.swank.packageName, this.thread
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
    try {
      const state = this.top;
      if (state && frameId !== undefined) state.selectedFrame = frameId;
      // eval-and-grab-output hat als einziger Einstiegspunkt eine
      // definierte Rückgabe: (ausgabe wert-als-string). interactive-eval
      // quittierte hier jeden Ausdruck mit einem Arity-Fehler,
      // listener-eval antwortete gar nicht — beides ungeklärt. Statt
      // weiter zu raten wird jetzt die gesendete Form in jeder
      // Fehlermeldung mitgeführt.
      const form =
        state && frameId !== undefined
          ? `(swank:eval-string-in-frame ${JSON.stringify(expression)} ${frameId} ${JSON.stringify(this.swank.packageName)})`
          : `(swank:eval-and-grab-output ${JSON.stringify(expression)})`;

      this.lastForm = form;
      const result = await this.swank.rex(form, this.swank.packageName, this.thread);

      // (ausgabe wert) oder ein blosser Wert, je nach Einstiegspunkt.
      const parts = asList(result);
      const rendered =
        parts.length >= 2
          ? [text(parts[0]), text(parts[1])].filter(x => x !== '').join('\n')
          : text(result);

      this.respond(req, {
        // Leeres Ergebnis sichtbar machen: sonst ist "erfolgreich, aber
        // kein Wert" von "gar keine Antwort" nicht zu unterscheiden.
        result: rendered === '' ? '; kein Wert' : rendered,
        variablesReference: 0,
        presentationHint: context === 'hover' ? { kind: 'property' } : undefined,
      });
    } catch (e) {
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
      default:
        this.respond(req, {
          result: 'Befehle: ,restarts | ,restart N | ,return AUSDRUCK | ,disassemble [N]',
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
      void this.swank
        .rex(`(swank:invoke-nth-restart-for-emacs ${state.level} ${index})`,
             this.swank.packageName, state.thread)
        .catch(() => undefined);
      this.respond(req, req.command === 'continue' ? { allThreadsContinued: false } : { invoked: index });
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

  private terminateThreads(req: DapRequest, ids: number[]): void {
    try {
      for (const id of ids) {
        void this.swank.rex(`(swank:kill-nth-thread ${id})`).catch(() => undefined);
      }
      this.respond(req);
    } catch (e) {
      this.fail(req, 1014, String(e));
    }
  }

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
        ? `(swank:eval-string-in-frame ${JSON.stringify(bind)} ${frameId} ${JSON.stringify(this.swank.packageName)})`
        : `(swank:listener-eval ${JSON.stringify(bind)})`;
    await this.swank.rex(form, this.swank.packageName, this.thread);
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
