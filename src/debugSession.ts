// debugSession.ts
//
// Debug Adapter für CLAMPS. Bildet den Common-Lisp-Debugger auf DAP ab,
// damit VS Codes eingebaute Oberfläche (Aufrufliste, Variablen, Threads)
// benutzt werden kann, statt sie als Webview nachzubauen.
//
// Stepping: angeboten, aber nur wo es möglich ist. Ob geschritten werden
// kann, verrät die Restart-Liste der Ebene — ohne CONTINUE-Restart
// weigert sich swank:sldb-step, und weil der Aufruf im angehaltenen
// Thread läuft, würde daraus eine neue Debugger-Ebene statt einer
// Fehlermeldung (canStep). Schlägt der Schritt trotzdem fehl, etwa weil
// der Code mit debug 0 kompiliert ist, holt resyncStopped die
// Oberfläche zurück in den angehaltenen Zustand, statt sie auf "läuft"
// stehen zu lassen.
//
// Zustand wird PRO THREAD geführt: bei Stil :spawn hat jede Auswertung
// ihren eigenen Worker, und mehrere können gleichzeitig in je eigenen
// SLDB-Ebenen stehen. Siehe `stacks`.
//
// Ebenfalls bewusst: der Inspector wird NICHT hier nachgebaut. Ein Wert
// wird an ein frisch erzeugtes Symbol in CL-USER gebunden, und der
// vorhandene Objekt-Tabellen-Inspector bekommt dessen Namen. So gibt es
// ein Inspector-Modell statt zwei, und die Objektidentität bleibt.

import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  SwankClient, SExpr, Sym, text, isSym, isNil, asList, plistGet, printSexpr,
  splitTopLevelForms, lispString, hoverCandidate,
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

interface FrameSource {
  path?: string;
  line: number;
  column: number;
}

/**
 * Ein Debugger-Level.
 *
 * Frame-IDs, Quellorte und Variablen-Referenzen gehören AN die Ebene,
 * nicht an die Session: bei Kommunikationsstil :spawn bekommt jede
 * Auswertung einen eigenen Worker, also stehen mehrere Threads
 * gleichzeitig in je eigenen SLDB-Ebenen — und deren Frame-IDs zählen
 * unabhängig voneinander ab 0. Global gehalten überschreiben sie sich
 * gegenseitig.
 */
interface DebugLevel {
  thread: SExpr;
  /** Numerische ID, die gegenüber VS Code für diesen Thread gilt. */
  threadId: number;
  level: number;
  condition: string;
  conditionType: string;
  restarts: Restart[];
  frames: SExpr[];
  selectedFrame: number;
  frameSources: Map<number, FrameSource>;
  varRefs: number[];
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
   * Debugger-Ebenen, gestapelt PRO THREAD.
   *
   * Ein einzelner Stapel war falsch. Bei Kommunikationsstil :spawn —
   * dem Normalfall in einem CLAMPS-Image — bearbeitet jede Auswertung
   * ein eigener Worker-Thread, und jeder kann unabhängig in SLDB
   * stehen. Drei gleichzeitig offene Debugger in drei Threads sind
   * nichts Ungewöhnliches, sondern der Alltag, wenn man in der REPL
   * mehrere Fehler nacheinander auslöst, ohne sie abzuräumen.
   *
   * Mit einem Stapel überschrieb der jüngste Debugger die anderen, und
   * `:debug-return` eines Threads räumte die Ebenen aller anderen
   * gleich mit weg. Genau das ist passiert.
   *
   * Schlüssel ist die gedruckte Thread-Bezeichnung, weil Swank sie in
   * jeder Nachricht so mitschickt.
   */
  private readonly stacks = new Map<string, DebugLevel[]>();

  /**
   * Thread, auf den sich frameId-behaftete Anfragen beziehen.
   *
   * DAP nennt bei `scopes` und `evaluate` nur eine frameId, keinen
   * Thread. VS Code fragt aber immer erst `stackTrace` für den Thread,
   * den es anzeigt — dort wird dieser Zeiger gesetzt.
   */
  private activeThread = '';

  /** Zuordnung numerische DAP-Thread-ID -> Schlüssel in stacks. */
  private readonly threadKeys = new Map<number, string>();
  /** Vergeben für Threads, deren Bezeichner keine Zahl ist. */
  private nextSyntheticThreadId = 900001;

  private variableSets = new Map<number, vscode.DebugProtocolMessage[]>();
  private nextVarRef = 1;
  /** Zuletzt gesendete Form — für aussagekräftige Fehlermeldungen. */
  private lastForm = '';
  /** Hinweis auf den offenen Debugger nur einmal pro Ebene zeigen. */
  private warnedAboutOpenDebugger = false;
  private threadMap = new Map<number, SExpr>();

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

  // ------------------------------------------------------------------
  // Zugriff auf die Thread-Stapel
  // ------------------------------------------------------------------

  /** Ebenen des Threads, auf den sich die laufende Anfrage bezieht. */
  private get levels(): DebugLevel[] {
    return this.stacks.get(this.activeThread) ?? [];
  }

  /** Innerste Ebene dieses Threads. */
  private get top(): DebugLevel | undefined {
    const s = this.levels;
    return s[s.length - 1];
  }

  private get thread(): SExpr {
    return this.top?.thread ?? new Sym('t');
  }

  /** Thread-ID, die gegenüber VS Code als angehalten gemeldet wird. */
  private get stoppedThreadId(): number {
    return this.top?.threadId ?? 1;
  }

  /** Steht IRGENDEIN Thread im Debugger? */
  private get anyLevel(): boolean {
    for (const s of this.stacks.values()) if (s.length > 0) return true;
    return false;
  }

  /**
   * Numerische DAP-ID für eine Thread-Bezeichnung.
   *
   * Bei :spawn ist der Bezeichner eine Zahl und wird direkt genommen —
   * so meinen `threads` und `stopped` denselben Thread. Nur für den
   * Sonderfall `t` (Stil :sigio, ein Thread) wird eine ID erfunden.
   */
  private threadIdFor(thread: SExpr, key: string): number {
    if (typeof thread === 'number') {
      this.threadKeys.set(thread, key);
      return thread;
    }
    for (const [id, k] of this.threadKeys) if (k === key) return id;
    const id = this.nextSyntheticThreadId++;
    this.threadKeys.set(id, key);
    return id;
  }

  /**
   * Setzt activeThread auf den Thread mit dieser DAP-ID. Rückgabe sagt,
   * ob dort überhaupt ein Debugger steht.
   */
  private focusThread(threadId: number | undefined): boolean {
    if (threadId === undefined) return this.levels.length > 0;
    const key = this.threadKeys.get(threadId);
    if (key !== undefined && (this.stacks.get(key)?.length ?? 0) > 0) {
      this.activeThread = key;
      return true;
    }
    return this.levels.length > 0;
  }

  /** Nach dem Verlassen eines Stapels auf einen noch offenen umschalten. */
  private focusAnyOpen(): void {
    if (this.levels.length > 0) return;
    for (const [key, s] of this.stacks) {
      if (s.length > 0) {
        this.activeThread = key;
        return;
      }
    }
  }

  /** Variablen-Referenzen einer verlassenen Ebene freigeben. */
  private dropLevel(level: DebugLevel): void {
    for (const ref of level.varRefs) this.variableSets.delete(ref);
    level.frameSources.clear();
  }

  // --- Frame-IDs ------------------------------------------------------
  //
  // DAP verlangt Frame-IDs, die über ALLE Threads eindeutig sind. Lisp
  // zählt sie dagegen pro Thread ab 0. Ohne Kodierung bezeichnete
  // frameId 0 drei verschiedene Frames, und `scopes` hätte nur über die
  // Aufrufreihenfolge (stackTrace zuerst) erraten können, welcher
  // gemeint ist — was bei zwei aufgeklappten Threads schiefgeht.

  private readonly threadSlots = new Map<string, number>();
  private nextSlot = 1;
  private static readonly FRAME_SPAN = 100000;

  private slotFor(key: string): number {
    let slot = this.threadSlots.get(key);
    if (slot === undefined) {
      slot = this.nextSlot++;
      this.threadSlots.set(key, slot);
    }
    return slot;
  }

  private encodeFrame(key: string, frame: number): number {
    return this.slotFor(key) * ClampsDebugSession.FRAME_SPAN + frame;
  }

  /**
   * Zerlegt eine DAP-Frame-ID und setzt activeThread auf den zugehörigen
   * Thread. Rückgabe ist die echte Lisp-Frame-Nummer.
   */
  private decodeFrame(dapFrameId: number | undefined): number | undefined {
    if (dapFrameId === undefined || !Number.isFinite(dapFrameId)) return undefined;
    const span = ClampsDebugSession.FRAME_SPAN;
    const slot = Math.floor(dapFrameId / span);
    const frame = dapFrameId % span;
    if (slot > 0) {
      for (const [key, s] of this.threadSlots) {
        if (s === slot && (this.stacks.get(key)?.length ?? 0) > 0) {
          this.activeThread = key;
          break;
        }
      }
    }
    return frame;
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
          supportsSetVariable: true,
          supportsFunctionBreakpoints: true,
          supportsDelayedStackTraceLoading: true,
          supportsStepInTargetsRequest: false,
          supportsSteppingGranularity: false,
          exceptionBreakpointFilters: [],
        });
        this.event('initialized');
        return;

      case 'attach':          return this.attach(req);
      case 'configurationDone': this.respond(req); return;
      case 'disconnect':      return this.disconnect(req);
      case 'threads':         return this.threads(req);
      case 'stackTrace':      return this.stackTrace(req, a.threadId, a.startFrame ?? 0, a.levels ?? 200);
      case 'scopes':          return this.scopes(req, a.frameId);
      case 'variables':       return this.variables(req, a.variablesReference);
      case 'setVariable':     return this.setVariable(
                                req, a.variablesReference,
                                String(a.name ?? ''), String(a.value ?? ''));
      // frameId wird hier dekodiert: alles dahinter rechnet mit echten
      // Lisp-Frame-Nummern, und das Dekodieren richtet gleich den
      // Thread-Fokus auf den Frame, den VS Code meint.
      case 'evaluate':        return this.evaluate(
                                req, String(a.expression ?? ''),
                                this.decodeFrame(a.frameId), a.context);
      case 'continue':        return this.continue(req);
      case 'pause':           return this.pause(req, a.threadId);
      case 'restartFrame':    return this.restartFrame(req, this.decodeFrame(a.frameId));
      case 'exceptionInfo':   return this.exceptionInfo(req);

      case 'next':            return this.step(req, 'swank:sldb-next');
      case 'stepIn':          return this.step(req, 'swank:sldb-step');
      case 'stepOut':         return this.step(req, 'swank:sldb-out');

      case 'setBreakpoints':
        this.respond(req, {
          breakpoints: (a.breakpoints ?? []).map((b: any) => ({
            verified: false, line: b.line,
            message: 'Swank bietet keine portablen Quelltext-Breakpoints. ' +
                     'Der Lisp-Debugger öffnet sich bei Conditions.',
          })),
        });
        return;
      case 'setFunctionBreakpoints': return this.setFunctionBreakpoints(req, a.breakpoints ?? []);
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
      case 'clamps/frameLocals':
        return this.frameLocals(req, this.decodeFrame(a.frameId));
      case 'clamps/bindForInspector':
        return this.bindForInspector(req, String(a.expression ?? ''), this.decodeFrame(a.frameId));
      case 'clamps/bindCondition':
        return this.bindCondition(req);
      case 'clamps/returnFromFrame':
        return this.returnFromFrame(
          req,
          this.decodeFrame(a.frameId) ?? this.top?.selectedFrame ?? 0,
          String(a.expression ?? 'nil'));
      case 'clamps/disassembleFrame':
        return this.simpleFrameCall(
          req, 'swank:disassemble-frame',
          this.decodeFrame(a.frameId) ?? this.top?.selectedFrame ?? 0);

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
      string: lispString(expression),
      frame: String(frameId),
      package: lispString(this.swank.packageName),
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
    // dort stehen lassen — also vorher abbrechen. Und zwar JEDEN Thread
    // und mit *ABORT: die vorige Fassung nahm nur die oberste Ebene des
    // aktiven Threads und den gewöhnlichen ABORT, sodass bei gestapelten
    // Ebenen oder mehreren angehaltenen Threads das Image nach dem
    // Trennen weiter in SLDB stand — sichtbar erst beim nächsten
    // Anhängen, wo dann connection-info nicht mehr antwortet.
    for (const stack of this.stacks.values()) {
      const inner = stack[stack.length - 1];
      if (!inner) continue;
      // *ABORT geht auf die oberste Ebene zurück, ABORT nur eine Ebene.
      const idx = inner.restarts.findIndex(r => r.name.toUpperCase() === '*ABORT');
      const use = idx >= 0
        ? idx
        : inner.restarts.findIndex(r => r.name.toUpperCase() === 'ABORT');
      if (use < 0) continue;
      try {
        await this.swank.rex(
          `(swank:invoke-nth-restart-for-emacs ${inner.level} ${use})`,
          this.swank.packageName, inner.thread, 3000
        );
      } catch {
        // Beim Trennen nicht weiter stören.
      }
    }
    this.stacks.clear();
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
    const thread = m[1] ?? new Sym('t');
    const key = printSexpr(thread);
    const stack = this.stacks.get(key) ?? [];
    const level: DebugLevel = {
      thread,
      threadId: this.threadIdFor(thread, key),
      level: Number(m[2] ?? stack.length + 1),
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
      frameSources: new Map(),
      varRefs: [],
    };
    stack.push(level);
    this.stacks.set(key, stack);
    // Der neue Debugger bekommt den Fokus — aber die Ebenen der anderen
    // Threads bleiben unangetastet. Frühere Fassung: variableSets und
    // frameSources global geleert, wodurch ein Fehler in Thread B die
    // schon geholten Frames von Thread A entwertete.
    this.activeThread = key;
    this.warnedAboutOpenDebugger = false;

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
    // (:debug-return thread level stepping)
    const m = asList(msg);
    const thread = m[1] ?? new Sym('t');
    const key = printSexpr(thread);
    const level = Number(m[2] ?? 0);

    // NUR den Stapel dieses Threads anfassen. Die frühere Fassung suchte
    // in einem globalen Stapel nach der Ebenennummer — und weil jeder
    // Thread bei 1 anfängt, traf `splice` regelmäßig die Ebenen fremder
    // Threads und löschte sie mit.
    const stack = this.stacks.get(key);
    if (!stack || stack.length === 0) {
      // Unbekannter Thread: nichts zu tun, aber melden, dass er läuft.
      this.event('continued', {
        threadId: typeof thread === 'number' ? thread : 1,
        allThreadsContinued: false,
      });
      return;
    }

    const at = stack.findIndex(l => l.level === level);
    const removed = at >= 0 ? stack.splice(at) : stack.splice(stack.length - 1);
    for (const l of removed) this.dropLevel(l);

    const threadId = removed[0]?.threadId ?? this.threadIdFor(thread, key);

    if (stack.length > 0) {
      // Zurück in den äußeren Debugger DIESES Threads.
      const outer = stack[stack.length - 1];
      this.activeThread = key;
      this.event('stopped', {
        reason: 'exception', threadId: outer.threadId,
        text: outer.condition, description: outer.conditionType,
        allThreadsStopped: false,
      });
      return;
    }

    this.stacks.delete(key);
    this.threadKeys.delete(threadId);
    this.event('continued', { threadId, allThreadsContinued: false });
    // Steht noch ein anderer Thread im Debugger, den Fokus dorthin
    // ziehen — sonst zeigen frameId-Anfragen ins Leere.
    if (this.activeThread === key) this.activeThread = '';
    this.focusAnyOpen();

    // Erst wenn KEIN Thread mehr im Debugger steht, ist eine registrierte
    // REPL-Auswertung erledigt.
    if (!this.anyLevel && this.inflightRepl?.answered) {
      this.inflightRepl = undefined;
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

    // JEDER angehaltene Thread MUSS dabei sein, sonst zeigt VS Code für
    // ihn keine Aufrufliste — auch dann, wenn list-threads ihn nicht
    // auflistet oder ganz fehlschlägt. Bei :spawn sind das mehrere
    // gleichzeitig, jeder mit eigenem SLDB.
    for (const [key, stack] of this.stacks) {
      if (stack.length === 0) continue;
      const inner = stack[stack.length - 1];
      const label =
        stack.length > 1
          ? `Lisp ${key} (angehalten, Ebene ${inner.level} von ${stack.length})`
          : `Lisp ${key} (angehalten, Ebene ${inner.level})`;
      const at = threads.findIndex(t => t.id === inner.threadId);
      if (at >= 0) threads[at].name = label;
      else threads.unshift({ id: inner.threadId, name: label });
    }
    if (threads.length === 0) {
      threads.push({ id: this.stoppedThreadId, name: 'CLAMPS / Lisp' });
    }
    this.respond(req, { threads });
  }

  private async stackTrace(
    req: DapRequest, threadId: number | undefined, start: number, levels: number
  ): Promise<void> {
    // Hier — und nur hier — nennt VS Code den Thread, den es anzeigt.
    // Der Zeiger muss gesetzt werden, BEVOR scopes/evaluate mit einer
    // nackten frameId hereinkommen. Vorher wurde a.threadId ignoriert,
    // sodass bei mehreren angehaltenen Threads immer die Frames des
    // jüngsten geliefert wurden — auch wenn man einen anderen anklickte.
    this.focusThread(threadId);
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

    const key = this.activeThread;
    const slice = frames.slice(start, start + levels);
    const out = slice.map((f, i) => {
      const x = asList(f);
      const id = typeof x[0] === 'number' ? (x[0] as number) : start + i;
      const src = state.frameSources.get(id);
      return {
        id: this.encodeFrame(key, id),
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
    void this.enrichSources(state, slice.slice(0, 5), start);
  }

  private async enrichSources(
    level: DebugLevel, frames: SExpr[], start: number
  ): Promise<void> {
    let changed = false;
    for (let i = 0; i < frames.length; i++) {
      const x = asList(frames[i]);
      const id = typeof x[0] === 'number' ? (x[0] as number) : start + i;
      if (level.frameSources.has(id)) continue;
      try {
        // Nacheinander, nicht parallel: der Debugger-Thread verarbeitet
        // ohnehin seriell, und ein Schwall Anfragen bringt nichts.
        const src = await this.frameSource(level, id);
        if (src) {
          level.frameSources.set(id, src);
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

  /** Dateiinhalte, um Zeichen-Offsets in Zeilen umzurechnen. */
  private readonly fileCache = new Map<string, string | undefined>();

  private fileText(path: string): string | undefined {
    if (!this.fileCache.has(path)) {
      try {
        this.fileCache.set(path, fs.readFileSync(path, 'utf8'));
      } catch {
        this.fileCache.set(path, undefined);
      }
    }
    return this.fileCache.get(path);
  }

  /**
   * Zeichen-Offset in Zeile/Spalte umrechnen, beide 1-basiert.
   *
   * SBCL liefert in :position einen OFFSET, keine Zeilennummer. Genau
   * das war der Grund, warum das Exception-Banner immer auf Zeile 1
   * klebte: das alte Regex suchte :line, fand nichts, und der Rückfall
   * war 1. Ein Debugger, der jeden Fehler in Zeile 1 verortet, ist beim
   * Lesen eines Backtrace nutzlos.
   */
  private offsetToLineColumn(path: string, offset: number): FrameSource {
    const src = this.fileText(path);
    if (src === undefined) return { path, line: 1, column: 1 };
    // Swank zählt Zeichen ab 1; ein Offset von 0 wäre schon Zeile 1.
    const cut = Math.max(0, Math.min(src.length, offset - 1));
    let line = 1, lastBreak = -1;
    for (let i = 0; i < cut; i++) {
      if (src.charCodeAt(i) === 10) { line++; lastBreak = i; }
    }
    // Auf vorhandene Zeilen begrenzen. Ist die Datei seit dem Kompilieren
    // kürzer geworden, zeigt der Offset hinter das Ende — und ein
    // abschließender Zeilenumbruch machte daraus eine Zeile, die es im
    // Editor nicht gibt. Dann lieber auf die letzte echte Zeile.
    const count = src.split('\n').length;
    const maxLine = Math.max(1, src.endsWith('\n') ? count - 1 : count);
    return { path, line: Math.min(line, maxLine), column: cut - lastBreak };
  }

  /** Zeile eines Schnipsels suchen — Rückfall, wenn kein Offset kommt. */
  private snippetToLine(path: string, snippet: string): number | undefined {
    const src = this.fileText(path);
    if (src === undefined) return undefined;
    // Nur die erste Zeile des Schnipsels, und Leerraum tolerant.
    const first = snippet.split(/[\r\n]/)[0].trim();
    if (first.length < 4) return undefined;
    const at = src.indexOf(first);
    if (at < 0) return undefined;
    return src.slice(0, at).split('\n').length;
  }

  private async frameSource(
    level: DebugLevel, frameId: number
  ): Promise<FrameSource | undefined> {
    const x = await this.swank.rex(
      `(swank:frame-source-location ${frameId})`,
      this.swank.packageName, level.thread, 4000
    );
    const list = asList(x);
    // (:location (:file "…") (:position N) (:snippet "…")) oder (:error "…")
    if (isSym(list[0], ':error')) return undefined;
    const flat = printSexpr(x);
    const file = /:file\s+"((?:[^"\\]|\\.)+)"/i.exec(flat)?.[1];
    if (!file) return undefined;
    const path = file.replace(/\\(.)/g, '$1');
    const abs = path.startsWith('/') ? path : `${this.workspaceRoot}/${path}`;

    // :line, falls das Backend es doch liefert — dann ist nichts zu rechnen.
    const line = /:line\s+(\d+)/i.exec(flat)?.[1];
    if (line) {
      const col = /:column\s+(\d+)/i.exec(flat)?.[1];
      return { path: abs, line: Number(line), column: Number(col ?? 1) };
    }

    const position = /:position\s+(\d+)/i.exec(flat)?.[1];
    if (position) return this.offsetToLineColumn(abs, Number(position));

    // Kein Offset: über den Schnipsel suchen. Weniger genau, aber immer
    // noch besser als Zeile 1.
    const snippet = /:snippet\s+"((?:[^"\\]|\\.)*)"/i.exec(flat)?.[1];
    if (snippet) {
      const found = this.snippetToLine(abs, snippet.replace(/\\(.)/g, '$1'));
      if (found !== undefined) return { path: abs, line: found, column: 1 };
    }
    return undefined;
  }

  private async scopes(req: DapRequest, dapFrameId: number): Promise<void> {
    // Dekodieren setzt gleich activeThread auf den Thread dieses Frames.
    const frameId = this.decodeFrame(dapFrameId);
    const state = this.top;
    if (!state || frameId === undefined) {
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
          // Herkunft mitführen, damit setVariable weiß, in welchem Frame
          // und Thread die Zuweisung stattfinden muss. Wird vor dem
          // Senden entfernt (siehe variables).
          __frame: frameId,
          __settable: true,
        };
      });
      const catches = asList(outer[1]).map((tag, i) => ({
        name: `tag-${i}`,
        value: text(tag),
        variablesReference: 0,
      }));

      const scopes: any[] = [
        { name: 'Locals', variablesReference: this.store(state, locals), expensive: false },
      ];
      if (catches.length) {
        scopes.push({
          name: 'Catch-Tags',
          variablesReference: this.store(state, catches),
          expensive: false,
        });
      }
      this.respond(req, { scopes });
    } catch (e) {
      this.fail(req, 1002, String(e));
    }
  }

  /**
   * Locals eines Frames als flache Liste — Grundlage für Inline Values.
   *
   * Eigene Anfrage statt scopes/variables: der Inline-Values-Anbieter
   * läuft bei jedem Sprung im Editor und braucht nur Namen und Werte,
   * keine Referenzen, keine Catch-Tags. Antwortet bewusst mit leerer
   * Liste statt mit einem Fehler, wenn nichts angehalten ist — ein
   * fehlgeschlagener Request pro Cursorbewegung wäre nur Lärm.
   */
  private async frameLocals(req: DapRequest, frameId: number | undefined): Promise<void> {
    const level = this.top;
    if (!level || frameId === undefined) {
      this.respond(req, { locals: [] });
      return;
    }
    try {
      const result = await this.swank.rex(
        `(swank:frame-locals-and-catch-tags ${frameId})`,
        this.swank.packageName, level.thread, 4000
      );
      const locals = asList(asList(result)[0]).map((entry, i) => ({
        name: text(plistGet(entry, ':name')) || `local-${i}`,
        value: text(plistGet(entry, ':value')),
      }));
      this.respond(req, { locals });
    } catch {
      this.respond(req, { locals: [] });
    }
  }

  /**
   * Variablensatz ausliefern. Die internen Felder __frame/__settable
   * gehen NICHT über die Leitung: DAP-Clients dürfen unbekannte Felder
   * ignorieren, aber sie sind Ballast und würden im Protokollmitschnitt
   * verwirren.
   */
  private variables(req: DapRequest, ref: number): void {
    const set = this.variableSets.get(ref) ?? [];
    const variables = (set as any[]).map(v => {
      const { __frame, __settable, ...rest } = v;
      return rest;
    });
    this.respond(req, { variables });
  }

  /**
   * Eine lokale Variable im angehaltenen Frame setzen.
   *
   * Swank hat dafür keinen eigenen Aufruf; der Weg ist eine Zuweisung
   * IM FRAME über eval-string-in-frame. Das funktioniert nur, wenn SBCL
   * die Variable als setzbar führt — bei hoch optimiertem Code ist sie
   * das oft nicht, und die Zuweisung läuft ins Leere, ohne zu klagen.
   *
   * Deshalb wird nach dem Setzen NEU GELESEN und der tatsächliche Wert
   * zurückgemeldet. Sonst zeigt VS Code den Wunschwert an, während im
   * Image der alte steht — die schlimmste Art von Debugger-Anzeige.
   */
  private async setVariable(
    req: DapRequest, ref: number, name: string, value: string
  ): Promise<void> {
    const set = (this.variableSets.get(ref) ?? []) as any[];
    const entry = set.find(v => v.name === name);
    if (!entry) {
      this.fail(req, 1013, `Unbekannte Variable ${name}.`);
      return;
    }
    if (!entry.__settable) {
      this.fail(req, 1014, `${name} ist nicht setzbar (kein Frame-Local).`);
      return;
    }
    const level = this.top;
    const frame = entry.__frame;
    if (!level || frame === undefined) {
      this.fail(req, 1015, 'Kein aktiver Frame.');
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      this.fail(req, 1016, 'Leerer Wert.');
      return;
    }
    try {
      // Zuweisung und Rückgabe des danach gelesenen Werts in EINEM
      // Aufruf: zwei Rundreisen könnten sich einen Restart einfangen,
      // der zwischen ihnen die Ebene wechselt.
      const form = `(progn (setq ${name} ${trimmed}) ${name})`;
      const raw = await this.swank.rex(
        this.frameEvalForm(form, frame), this.swank.packageName, level.thread, 8000
      );
      const shown = text(raw).trim();
      // Gegenprobe: den Frame neu einlesen und den Eintrag aktualisieren,
      // damit die Variablenansicht und das Rückgabefeld dasselbe sagen.
      entry.value = shown;
      this.respond(req, { value: shown, variablesReference: 0 });
      if (shown !== trimmed) {
        this.event('output', {
          category: 'console',
          output:
            `${name} = ${shown}` +
            (shown === '' ? ' (leer — Zuweisung hat vermutlich nicht gegriffen)\n' : '\n'),
        });
      }
    } catch (e) {
      // Der häufigste Fall: die Variable ist im kompilierten Code nicht
      // setzbar. Die Meldung sagt, was zu tun ist.
      this.fail(
        req, 1017,
        `${name} konnte nicht gesetzt werden: ${e}\n` +
        'Bei wegoptimierten Locals hilft nur, die Funktion mit ' +
        '(declaim (optimize (debug 3) (speed 0))) neu zu kompilieren.'
      );
    }
  }

  /**
   * Variablensatz ablegen. Die Referenz wird an die Ebene gehängt, damit
   * sie beim Verlassen GENAU dieser Ebene wegfällt — früher wurde bei
   * jedem neuen Debugger die ganze Tabelle geleert, auch die Sätze
   * anderer Threads.
   */
  private store(level: DebugLevel, vars: any[]): number {
    const ref = this.nextVarRef++;
    this.variableSets.set(ref, vars);
    level.varRefs.push(ref);
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
    // Hover geht einen eigenen, abgesicherten Weg — siehe evaluateHover.
    if (context === 'hover') return this.evaluateHover(req, expression);
    try {
      const state = this.top;
      if (state && frameId !== undefined) state.selectedFrame = frameId;
      // eval-and-grab-output hat als einziger Einstiegspunkt eine
      // definierte Rückgabe: (ausgabe wert-als-string). interactive-eval
      // quittierte hier jeden Ausdruck mit einem Arity-Fehler,
      // listener-eval antwortete gar nicht — beides ungeklärt. Statt
      // weiter zu raten wird jetzt die gesendete Form in jeder
      // Fehlermeldung mitgeführt.
      // Mehrere Formen einzeln schicken: eval-and-grab-output UND
      // eval-string-in-frame lesen jeweils nur die erste. Ohne das
      // verschwinden alle weiteren stillschweigend.
      //
      // Der Frame-Pfad war davon ausgenommen — mit der Begründung, im
      // Frame werte man einzelne Ausdrücke aus. Das ging schief, weil
      // VS Code beim Anhalten automatisch Frame 0 auswählt und die
      // frameId bei JEDER Eingabe mitschickt. Damit lief der Ausnahme-
      // zweig immer, und `(+ 1 2) (+ 3 4)` ergab nur 3.
      const forms = splitTopLevelForms(expression);
      const chunks: string[] = [];
      for (const raw of forms.length > 0 ? forms : [expression]) {
        const useFrame = state && frameId !== undefined;
        const one = useFrame
          ? this.frameEvalForm(raw, frameId!)
          : `(swank:eval-and-grab-output ${lispString(raw)})`;
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
        result: rendered === '' ? '; kein Wert' : rendered,
        variablesReference: 0,
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
      // Die gesendete Form gehört in die Meldung — ohne sie bleibt bei
      // einem Protokollproblem nur Raten.
      this.fail(req, 1003, `${e}\n  gesendet: ${this.lastForm}`);
    }
  }

  // ------------------------------------------------------------------
  // Hover
  // ------------------------------------------------------------------

  /**
   * Hover-Auswertung. Nie im Frame, nie im angehaltenen Thread, und der
   * Ausdruck wird ERST INNERHALB von ignore-errors gelesen.
   *
   * Das war der verbleibende Weg in den Debugger: bei
   * `(swank:eval-and-grab-output "(values (ignore-errors X))")` liest
   * Swank den ganzen String, bevor irgendein Handler steht. Ein
   * Reader-Fehler in X — `#<`, eine offene Klammer — sprang deshalb
   * trotz ignore-errors in den Debugger, und beim Überfahren eines
   * Backtrace stapelten sich die Ebenen im Sekundentakt.
   *
   * Mit read-from-string INNEN passiert das Lesen während der
   * Auswertung, also im Schutz von ignore-errors.
   *
   * (values ...) kappt den zweiten Rückgabewert: ignore-errors liefert
   * bei einem Fehler nil UND das Condition-Objekt, was im Tooltip als
   * "nil, #<unbound-variable rpc …>" landete.
   */
  private async evaluateHover(req: DapRequest, expression: string): Promise<void> {
    const safe = hoverCandidate(expression);
    if (safe === undefined) {
      this.respond(req, { result: '', variablesReference: 0 });
      return;
    }
    const inner =
      `(values (ignore-errors (eval (read-from-string ${lispString(safe)}))))`;
    const one = `(swank:eval-and-grab-output ${lispString(inner)})`;
    try {
      // Immer frischer Worker (t): der angehaltene Thread sitzt in der
      // SLDB-Schleife, und eval-string-in-frame läuft mit aktivem
      // Debugger-Hook, wo ignore-errors nichts nützt.
      const r = await this.swank.rex(one, this.swank.packageName, new Sym('t'), 4000);
      const p = asList(r);
      const shown =
        p.length >= 2
          ? [text(p[0]), text(p[1])].filter(x => x !== '').join('\n')
          : text(r);
      this.respond(req, {
        // Leer bleibt leer: sonst klebt an jedem Wort ein Tooltip.
        result: shown,
        variablesReference: 0,
        presentationHint: { kind: 'property' },
      });
    } catch {
      // Ein fehlgeschlagener Hover ist kein Ereignis, über das der
      // Nutzer informiert werden will.
      this.respond(req, { result: '', variablesReference: 0 });
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
   * Ist ein Schritt aus DIESER Ebene heraus überhaupt möglich?
   *
   * Die Bedingung steht in den Restarts, die Swank ohnehin mitgeschickt
   * hat — es braucht keine Rundreise ins Image. swank:sldb-step macht:
   *
   *   (cond ((find-restart 'continue) (activate-stepping frame)
   *                                   (invoke-restart 'continue))
   *         (t (error "Not currently single-stepping, …")))
   *
   * Ohne CONTINUE-Restart signalisiert der Aufruf also einen Fehler, und
   * weil er im angehaltenen Thread läuft, wird daraus eine NEUE
   * Debugger-Ebene statt einer abgelehnten Anfrage.
   *
   * Eine Probe auf (fboundp 'swank:sldb-step) war die falsche Frage: die
   * Funktion ist da, sie weigert sich nur. Genau daran ist die vorige
   * Fassung vorbeigelaufen und hat Ebene 2 mit
   * "Not currently single-stepping" produziert.
   */
  private canStep(level: DebugLevel): boolean {
    return level.restarts.some(r => r.name.toUpperCase() === 'CONTINUE');
  }

  private async step(req: DapRequest, operation: string): Promise<void> {
    const level = this.top;
    if (!level) {
      this.fail(req, 1008, 'Stepping ist nur in einer angehaltenen Lisp-Debugger-Sitzung möglich.');
      return;
    }
    if (!this.canStep(level)) {
      // Ablehnen und die Sitzung sichtbar angehalten lassen — KEIN
      // 'continued'. VS Code zeigt die Begründung als Meldung an.
      this.fail(
        req, 1012,
        'Aus dieser Condition heraus kann nicht geschritten werden: sie bietet ' +
        'keinen CONTINUE-Restart, ohne den SBCL das Single-Stepping nicht ' +
        'aufnehmen kann. Weiter geht es über die Restarts im Debug-Bereich. ' +
        'Stepping setzt außerdem hohe Debug-Qualität voraus, etwa ' +
        '(declaim (optimize (debug 3) (speed 0) (safety 3))).'
      );
      return;
    }
    const frame = level.selectedFrame ?? 0;
    // Wie bei Restarts nicht auf die RPC-Rückgabe warten: sldb-step setzt
    // die Ausführung fort und antwortet häufig erst am nächsten Step-Stop
    // oder beim Verlassen des Frames. Der DAP-Request muss sofort frei sein.
    void this.swank
      .rex(`(${operation} ${frame})`, this.swank.packageName, level.thread, 0)
      .catch(e => {
        if (/:abort/i.test(String(e))) return; // regulärer Ausgang
        this.event('output', {
          output:
            `Stepping fehlgeschlagen: ${e}. Der Code muss mit hoher Debug-Qualität ` +
            'kompiliert sein, z. B. (declaim (optimize (debug 3) (speed 0) (safety 3))).\n',
          category: 'stderr',
        });
        // Zustand wieder geradeziehen: das 'continued' von unten war eine
        // Vorauszahlung auf einen Schritt, der nicht stattgefunden hat.
        // Ohne das bleibt die Oberfläche auf "läuft" stehen, während Lisp
        // in SLDB wartet — und die nächste Condition legte eine Ebene auf
        // einen Zustand, den VS Code gar nicht mehr anzeigte.
        this.resyncStopped();
      });
    this.respond(req);
    this.event('continued', { threadId: this.stoppedThreadId, allThreadsContinued: false });
  }

  /** Die aktuelle Debugger-Ebene erneut als angehalten melden. */
  private resyncStopped(): void {
    const s = this.top;
    if (!s) return;
    this.event('stopped', {
      reason: 'exception',
      threadId: this.stoppedThreadId,
      text: s.condition,
      description: s.conditionType,
      allThreadsStopped: false,
      preserveFocusHint: true,
    });
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
        `(clamps-bridge-rpc:eval-for-repl-debuggable ${lispString(code)} ${lispString(pkg)})`,
        pkg, new Sym('t'), 15000,
        id => { entry.swankId = id; }
      );
      // Kam eine echte Antwort (kein Debugger), normal beantworten —
      // sofern onDebug den Request nicht schon gelöst hat.
      const parts = asList(r);
      if (!entry.answered) {
        entry.answered = true;
        const rawPresentations = asList(parts[3]);
        const presentations = rawPresentations.map(item => {
          const fields = asList(item);
          return {
            id: Number(fields[0] ?? 0),
            preview: text(fields[1]),
            type: text(fields[2]),
          };
        }).filter(item => Number.isFinite(item.id) && item.id > 0);
        this.respond(req, {
          status: 'ok',
          output: text(parts[1]),
          package: text(parts[2]) || pkg,
          presentations,
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

  private async restartFrame(req: DapRequest, frameId: number | undefined): Promise<void> {
    if (frameId === undefined) {
      this.fail(req, 1009, 'Kein Frame ausgewählt.');
      return;
    }
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
        `(swank:return-from-frame ${frameId} ${lispString(expression)})`,
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


  private async setFunctionBreakpoints(req: DapRequest, specs: any[]): Promise<void> {
    try {
      const names = specs.map(s => String(s.name ?? '').trim()).filter(Boolean);
      const form = `(clamps-bridge-rpc:set-function-breakpoints-for-repl ` +
        `'(${names.map(n => lispString(n)).join(' ')}) ${lispString(this.swank.packageName || 'COMMON-LISP-USER')})`;
      const raw = await this.swank.rex(form, this.swank.packageName, new Sym('t'), 5000);
      const top = asList(raw);
      if (!top.length || !isSym(top[0], ':ok')) {
        const message = top.length > 1 ? text(top[1]) : printSexpr(raw);
        this.respond(req, { breakpoints: names.map(name => ({ verified: false, message, source: undefined })) });
        return;
      }
      const entries = asList(top[1]);
      const breakpoints = entries.map((entry, index) => {
        const pl = asList(entry);
        const verified = !isNil(plistGet(pl, ':verified'));
        return {
          id: index + 1,
          verified,
          message: text(plistGet(pl, ':message')) || (verified ? 'Aktiv.' : 'Nicht gesetzt.'),
        };
      });
      this.respond(req, { breakpoints });
    } catch (e) {
      this.respond(req, {
        breakpoints: specs.map(() => ({ verified: false, message: `Funktions-Breakpoint fehlgeschlagen: ${e}` })),
      });
    }
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
    const bind = `(setf (symbol-value (intern ${lispString(token)} "COMMON-LISP-USER")) ${expression})`;
    const form =
      frameId !== undefined
        ? this.frameEvalForm(bind, frameId)
        : `(swank:eval-and-grab-output ${lispString(bind)})`;
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
