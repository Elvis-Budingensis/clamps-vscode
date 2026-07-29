// debugSession.ts
//
// Debug adapter for CLAMPS. Maps the Common Lisp debugger onto DAP, so
// that VS Code's built-in interface (call stack, variables, threads) can
// be used instead of rebuilding it as a webview.
//
// Stepping: offered, but only where it is possible. Whether stepping is
// possible is revealed by the restart list of the level — without a
// CONTINUE restart swank:sldb-step refuses, and because the call runs in
// the halted thread, that would produce a new debugger level rather than
// an error message (canStep). If the step fails anyway, for instance
// because the code was compiled with debug 0, resyncStopped brings the
// interface back into the halted state instead of leaving it on
// "running".
//
// State is kept PER THREAD: with style :spawn every evaluation has its
// own worker, and several can stand in SLDB levels of their own at the
// same time. See `stacks`.
//
// Also deliberate: the inspector is NOT rebuilt here. A value is bound to
// a freshly created symbol in CL-USER, and the existing object-table
// inspector is given its name. That way there is one inspector model
// rather than two, and object identity is preserved.

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
 * One debugger level.
 *
 * Frame IDs, source locations and variable references belong TO the
 * level, not to the session: with communication style :spawn every
 * evaluation gets its own worker, so several threads stand in SLDB levels
 * of their own at the same time — and their frame IDs count from 0
 * independently of each other. Held globally they overwrite one another.
 */
interface DebugLevel {
  thread: SExpr;
  /** The numeric ID that applies to this thread towards VS Code. */
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

  /** clamps.debugTrace: writes Swank AND DAP traffic to the console. */
  private readonly trace = vscode.workspace
    .getConfiguration('clamps')
    .get<boolean>('debugTrace', false);

  /** Does the client report that it understands the invalidated event? */
  private supportsInvalidated = false;

  /**
   * Swank request ID of the running REPL evaluation and the associated
   * DAP request. It is set while a replEval evaluation is open, so that
   * onDebug (a) clears ONLY its deadline, deliberately, and (b) answers
   * the DAP request immediately instead of keeping the chain
   * REPL→DAP→Swank→restart open.
   */
  private inflightRepl:
    | { swankId: number; req: DapRequest; pkg: string; answered: boolean }
    | undefined;

  /**
   * The arity of swank:eval-string-in-frame in THIS image.
   *
   * It varies between SLIME versions: sometimes (string frame), sometimes
   * (string frame package). A call with the wrong number does not end up
   * in an error message but in the Lisp debugger — and because VS Code
   * automatically selects frame 0 when halting, that hit every further
   * input and piled up debugger levels.
   */
  private frameEvalArity = 3;

  /**
   * Debugger levels, stacked PER THREAD.
   *
   * A single stack was wrong. With communication style :spawn — the
   * normal case in a CLAMPS image — every evaluation is handled by a
   * worker thread of its own, and each one can stand in SLDB
   * independently. Three debuggers open at once in three threads is
   * nothing unusual; it is everyday life when you trigger several errors
   * in a row in the REPL without clearing them.
   *
   * With one stack the newest debugger overwrote the others, and a
   * `:debug-return` of one thread cleared away the levels of all the
   * others along with it. That is exactly what happened.
   *
   * The key is the printed thread designator, because that is how Swank
   * sends it in every message.
   */
  private readonly stacks = new Map<string, DebugLevel[]>();

  /**
   * The thread that frameId-bearing requests refer to.
   *
   * For `scopes` and `evaluate` DAP names only a frameId, no thread. But
   * VS Code always asks for `stackTrace` first, for the thread it is
   * displaying — that is where this pointer is set.
   */
  private activeThread = '';

  /** Mapping from numeric DAP thread ID to the key in stacks. */
  private readonly threadKeys = new Map<number, string>();
  /** Assigned for threads whose designator is not a number. */
  private nextSyntheticThreadId = 900001;

  private variableSets = new Map<number, vscode.DebugProtocolMessage[]>();
  private nextVarRef = 1;
  /** The last form sent — for meaningful error messages. */
  private lastForm = '';
  /** Show the hint about the open debugger only once per level. */
  private warnedAboutOpenDebugger = false;
  private threadMap = new Map<number, SExpr>();

  constructor(
    private readonly port: number,
    private readonly workspaceRoot: string,
    private readonly host = '127.0.0.1'
  ) {
    // Record the raw traffic when clamps.debugTrace is set. Without it,
    // on an unexpected error all that is left is guessing which form
    // actually went over the wire.
    if (this.trace) {
      this.swank.on('wire', (dir: string, payload: string) =>
        this.event('output', {
          output: `${dir} ${payload}\n`,
          category: 'console',
        })
      );
    }

    // If Lisp asks for input (a restart that wants a value, say), Swank
    // sends :read-string and waits. Without an answer the call runs off
    // the end of the file — that is exactly how [replace-function] tipped
    // into a further debugger level.
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
      title: 'CLAMPS: Lisp is waiting for input',
      prompt: 'The Lisp process is waiting for text (a restart argument, say).',
      ignoreFocusOut: true,
    });
    // Answer even on cancellation, otherwise the image hangs.
    const value = (answer ?? '') + '\n';
    this.swank.emacsReturnString(thread, tag, value);
    this.event('output', {
      output: `; Eingabe an Lisp: ${JSON.stringify(answer ?? '')}\n`,
      category: 'console',
    });
  }

  // ------------------------------------------------------------------
  // Access to the thread stacks
  // ------------------------------------------------------------------

  /** Levels of the thread the running request refers to. */
  private get levels(): DebugLevel[] {
    return this.stacks.get(this.activeThread) ?? [];
  }

  /** The innermost level of this thread. */
  private get top(): DebugLevel | undefined {
    const s = this.levels;
    return s[s.length - 1];
  }

  private get thread(): SExpr {
    return this.top?.thread ?? new Sym('t');
  }

  /** The thread ID reported to VS Code as halted. */
  private get stoppedThreadId(): number {
    return this.top?.threadId ?? 1;
  }

  /** Is ANY thread in the debugger? */
  private get anyLevel(): boolean {
    for (const s of this.stacks.values()) if (s.length > 0) return true;
    return false;
  }

  /**
   * Numeric DAP ID for a thread designator.
   *
   * With :spawn the designator is a number and is taken directly — that
   * way `threads` and `stopped` mean the same thread. Only for the special
   * case `t` (style :sigio, one thread) is an ID invented.
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
   * Sets activeThread to the thread with this DAP ID. The return value
   * says whether a debugger stands there at all.
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

  /** After leaving a stack, switch to one that is still open. */
  private focusAnyOpen(): void {
    if (this.levels.length > 0) return;
    for (const [key, s] of this.stacks) {
      if (s.length > 0) {
        this.activeThread = key;
        return;
      }
    }
  }

  /** Release the variable references of a level that has been left. */
  private dropLevel(level: DebugLevel): void {
    for (const ref of level.varRefs) this.variableSets.delete(ref);
    level.frameSources.clear();
  }

  // --- Frame IDs ------------------------------------------------------
  //
  // DAP requires frame IDs that are unique across ALL threads. Lisp, by
  // contrast, counts them per thread from 0. Without an encoding, frameId
  // 0 denoted three different frames, and `scopes` could only have
  // guessed which one was meant from the call order (stackTrace first) —
  // which goes wrong with two threads expanded.

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
   * Takes a DAP frame ID apart and sets activeThread to the associated
   * thread. The return value is the real Lisp frame number.
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
  // DAP scaffolding
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
      // frameId is decoded here: everything beyond this point works with
      // real Lisp frame numbers, and the decoding also aims the thread
      // focus at the frame VS Code means.
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
            message: 'Swank offers no portable source breakpoints. ' +
                     'The Lisp debugger opens on conditions.',
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
      // Remember which port we are hanging off: if CLAMPS restarts it
      // gets a different one, and this session then points at a dead
      // image. Without the hint that looks like a bug in the debugger.
      this.event('output', {
        output:
          'Note: this session is bound to exactly this image. ' +
          'After "CLAMPS: Restart" the debugger has to be attached again.\n',
        category: 'console',
      });
      this.event('output', {
        output: `Attached to CLAMPS Swank at ${this.host}:${this.port}.\n`,
        category: 'console',
      });

      // Handshake. SLIME sends this first of all; we have skipped it so
      // far. A side benefit: the answer names the version and the
      // communication style, which is what makes arity differences
      // between Swank versions recognisable in the first place.
      try {
        const info = await this.swank.rex('(swank:connection-info)');
        const version = text(plistGet(info, ':version')) ||
                        text(plistGet(info, ':lisp-implementation'));
        // The key is called :style, not :communication-style.
        const style = text(plistGet(info, ':style'));
        this.event('output', {
          output: `Swank-Version ${version || '?'}, Stil ${style || '?'}\n`,
          category: 'console',
        });
        await this.probeFrameEvalArity();
      } catch (e) {
        // connection-info is the very first request. If even that gets
        // no answer, the image is already hanging — usually because it
        // is still standing in the Lisp debugger from an earlier run.
        this.event('output', {
          output:
            `The image is not answering (${e}).\n` +
            'It is probably still in the Lisp debugger. Remedy: ' +
            '"CLAMPS: Leave All Debugger Levels", otherwise ' +
            '"CLAMPS: Restart" or `pkill -f bootstrap.lisp` in a terminal.\n',
          category: 'stderr',
        });
      }
      this.respond(req);
    } catch (e) {
      this.fail(req, 1001, `Verbindung zu Swank fehlgeschlagen: ${e}`);
    }
  }

  /** The parameter names of eval-string-in-frame in THIS image. */
  private frameEvalParams: string[] = ['string', 'frame', 'package'];

  /**
   * Determines the real lambda list of eval-string-in-frame.
   *
   * Not via swank:operator-arglist — that is meant for display and omits
   * &optional, thereby feigning five required arguments. sb-introspect
   * supplies the actual list.
   */
  private async probeFrameEvalArity(): Promise<void> {
    try {
      const r = await this.swank.rex(
        '(swank:eval-and-grab-output ' +
          '"(sb-introspect:function-lambda-list (quote swank:eval-string-in-frame))")',
        this.swank.packageName, new Sym('t'), 8000
      );
      // (output value) — the value is the printed lambda list
      const parts = asList(r);
      // NOTE: function-lambda-list returns TWO values (the list and a
      // flag), and eval-and-grab-output prints both one below the other.
      // Without cutting out the first line, the appended NIL counts as an
      // additional parameter.
      const raw = (text(parts[1]) || text(r)).trim();
      const arglist = raw.split(/[\r\n]+/)[0].trim();
      if (!arglist) return;

      const tokens = arglist.replace(/^\(|\)$/g, '').trim().split(/\s+/);
      const required: string[] = [];
      for (const t of tokens) {
        if (t.startsWith('&')) break; // &optional / &rest / &key
        if (!t) continue;
        // Strip the package prefix: swank::frame -> frame
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
        output: `Cannot determine the lambda list of eval-string-in-frame (${e}); assuming 3.\n`,
        category: 'stderr',
      });
    }
  }

  /**
   * The call form for an evaluation in the frame.
   *
   * Filled in by parameter name, not by position: lines and width are
   * printing parameters and want numbers. Padded with nil, Lisp responded
   * with "The value nil is not of type number".
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
    // If the image is still in the debugger, merely disconnecting would
    // leave it standing there — so abort first. And do so for EVERY
    // thread and with *ABORT: the previous version took only the topmost
    // level of the active thread and the ordinary ABORT, so that with
    // stacked levels or several halted threads the image was still in
    // SLDB after disconnecting — visible only at the next attach, where
    // connection-info then no longer answers.
    for (const stack of this.stacks.values()) {
      const inner = stack[stack.length - 1];
      if (!inner) continue;
      // *ABORT goes back to the topmost level, ABORT only one level.
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
        // Do not disturb any further while disconnecting.
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
    // The new debugger gets the focus — but the levels of the other
    // threads are left untouched. Earlier version: variableSets and
    // frameSources were cleared globally, so that an error in thread B
    // invalidated the frames already fetched for thread A.
    this.activeThread = key;
    this.warnedAboutOpenDebugger = false;

    // Take the deadline away only from the triggering REPL request — it
    // stays open until the restart. All other requests (threads, frames,
    // hover) keep their deadline. Clearing all deadlines wholesale was a
    // bug: it left uninvolved requests open forever when an answer failed
    // to arrive.
    if (this.inflightRepl) {
      this.swank.clearRequestTimeout(this.inflightRepl.swankId);

      // Answer the DAP request IMMEDIATELY instead of keeping the chain
      // REPL→DAP→Swank→restart open. Otherwise the REPL terminal stays
      // busy while the debugger waits for a restart that would in turn be
      // triggered over the same blocked channel.
      if (!this.inflightRepl.answered) {
        this.inflightRepl.answered = true;
        this.respond(this.inflightRepl.req, {
          status: 'debugging',
          output: '; Lisp debugger open — choose a restart in the debug view.',
          package: this.inflightRepl.pkg,
        });
      }
    }

    this.event('output', {
      output:
        `\nLisp debugger, level ${level.level}: ${level.condition} ` +
        `(Thread ${printSexpr(level.thread)}, ${level.frames.length} Frames) ` +
        `[${level.conditionType}]\n` +
        level.restarts.map(r => `  ${r.index}: [${r.name}] ${r.description}`).join('\n') +
        '\n; Typing a digit chooses the restart. ,abort leaves all levels. ' +
        'Call stack and variables are in the debug view (Cmd+Shift+D).\n',
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

    // Touch ONLY this thread's stack. The earlier version searched a
    // global stack for the level number — and because every thread starts
    // at 1, `splice` regularly hit the levels of other threads and
    // deleted them along with it.
    const stack = this.stacks.get(key);
    if (!stack || stack.length === 0) {
      // Unknown thread: nothing to do, but report that it is running.
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
      // Back into the outer debugger of THIS thread.
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
    // If another thread is still in the debugger, pull the focus there —
    // otherwise frameId requests point into the void.
    if (this.activeThread === key) this.activeThread = '';
    this.focusAnyOpen();

    // Only when NO thread is in the debugger any more is a registered
    // REPL evaluation finished.
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
      // With list-threads the first line is the column heading.
      rows.slice(1).forEach((row, i) => {
        const x = asList(row);
        const id = typeof x[0] === 'number' ? (x[0] as number) : i + 1;
        this.threadMap.set(id, x[0] ?? id);
        threads.push({ id, name: `${text(x[1]) || 'thread'} (${id})` });
      });
    } catch {
      // list-threads is an extra; the call stack must not depend on it.
    }

    // EVERY halted thread MUST be included, otherwise VS Code shows no
    // call stack for it — even when list-threads does not list it or
    // fails entirely. With :spawn there are several at once, each with an
    // SLDB of its own.
    for (const [key, stack] of this.stacks) {
      if (stack.length === 0) continue;
      const inner = stack[stack.length - 1];
      const label =
        stack.length > 1
          ? `Lisp ${key} (halted, level ${inner.level} of ${stack.length})`
          : `Lisp ${key} (halted, level ${inner.level})`;
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
    // Here — and only here — does VS Code name the thread it is
    // displaying. The pointer has to be set BEFORE scopes/evaluate come
    // in with a bare frameId. Previously a.threadId was ignored, so that
    // with several halted threads the frames of the newest were always
    // delivered — even when you clicked on another one.
    this.focusThread(threadId);
    const state = this.top;
    if (!state) {
      this.respond(req, { stackFrames: [], totalFrames: 0 });
      return;
    }

    // The frames are already in the :debug message. Answer first, and
    // only then — if at all — supply source locations.
    //
    // The earlier version fetched swank:frame-source-location for EVERY
    // frame, and did so over the thread that is in the debugger. With 200
    // frames that was 200 parallel requests on exactly the channel that
    // is sensitive anyway; the call stack never came about.
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
          output: `Backtrace not retrievable: ${e}\n`,
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
        // NO presentationHint 'subtle' for frames without a source: VS
        // Code collapses subtle frames behind "Show N More Stack Frames".
        // In Lisp the majority of frames have no source location, so
        // almost the whole backtrace would disappear.
      };
    });

    this.respond(req, {
      stackFrames: out,
      totalFrames: Math.max(frames.length, start + out.length),
    });

    // Load source locations in the background, only for the topmost
    // frames. If something comes back, an 'invalidated' event tells VS
    // Code that the call stack should be fetched again.
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
        // One after another, not in parallel: the debugger thread
        // processes serially anyway, and a flood of requests gains
        // nothing.
        const src = await this.frameSource(level, id);
        if (src) {
          level.frameSources.set(id, src);
          changed = true;
        }
      } catch {
        // Without debug info there is no source location — not an error.
      }
    }
    // Only send it if the client announced the event at all — otherwise
    // it is at best without effect.
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
   * Convert a character offset into line/column, both 1-based.
   *
   * In :position SBCL supplies an OFFSET, not a line number. That was
   * exactly why the exception banner always stuck to line 1: the old
   * regex looked for :line, found nothing, and the fallback was 1. A
   * debugger that locates every error on line 1 is useless when reading a
   * backtrace.
   */
  private offsetToLineColumn(path: string, offset: number): FrameSource {
    const src = this.fileText(path);
    if (src === undefined) return { path, line: 1, column: 1 };
    // Swank counts characters from 1; an offset of 0 would already be
    // line 1.
    const cut = Math.max(0, Math.min(src.length, offset - 1));
    let line = 1, lastBreak = -1;
    for (let i = 0; i < cut; i++) {
      if (src.charCodeAt(i) === 10) { line++; lastBreak = i; }
    }
    // Clamp to the lines that exist. If the file has become shorter since
    // it was compiled, the offset points past the end — and a trailing
    // newline turned that into a line that does not exist in the editor.
    // In that case, better the last real line.
    const count = src.split('\n').length;
    const maxLine = Math.max(1, src.endsWith('\n') ? count - 1 : count);
    return { path, line: Math.min(line, maxLine), column: cut - lastBreak };
  }

  /** Find the line of a snippet — the fallback when no offset arrives. */
  private snippetToLine(path: string, snippet: string): number | undefined {
    const src = this.fileText(path);
    if (src === undefined) return undefined;
    // Only the first line of the snippet, and tolerant about whitespace.
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
    // (:location (:file "…") (:position N) (:snippet "…")) or (:error "…")
    if (isSym(list[0], ':error')) return undefined;
    const flat = printSexpr(x);
    const file = /:file\s+"((?:[^"\\]|\\.)+)"/i.exec(flat)?.[1];
    if (!file) return undefined;
    const path = file.replace(/\\(.)/g, '$1');
    const abs = path.startsWith('/') ? path : `${this.workspaceRoot}/${path}`;

    // :line, in case the backend does supply it after all — then there is
    // nothing to compute.
    const line = /:line\s+(\d+)/i.exec(flat)?.[1];
    if (line) {
      const col = /:column\s+(\d+)/i.exec(flat)?.[1];
      return { path: abs, line: Number(line), column: Number(col ?? 1) };
    }

    const position = /:position\s+(\d+)/i.exec(flat)?.[1];
    if (position) return this.offsetToLineColumn(abs, Number(position));

    // No offset: search via the snippet. Less precise, but still better
    // than line 1.
    const snippet = /:snippet\s+"((?:[^"\\]|\\.)*)"/i.exec(flat)?.[1];
    if (snippet) {
      const found = this.snippetToLine(abs, snippet.replace(/\\(.)/g, '$1'));
      if (found !== undefined) return { path: abs, line: found, column: 1 };
    }
    return undefined;
  }

  private async scopes(req: DapRequest, dapFrameId: number): Promise<void> {
    // Decoding also sets activeThread to the thread of this frame.
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
      // The format according to Swank: (locals catch-tags), where locals
      // are plists (:name NAME :id ID :value VALUE-STRING). The prototype
      // guessed the structure by probing arrays; here it is read.
      const outer = asList(result);
      const locals = asList(outer[0]).map((entry, i) => {
        const name = text(plistGet(entry, ':name')) || `local-${i}`;
        return {
          name,
          value: text(plistGet(entry, ':value')),
          variablesReference: 0,
          evaluateName: name,
          // Carry the origin along, so that setVariable knows in which
          // frame and thread the assignment has to take place. It is
          // removed before sending (see variables).
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
   * Locals of a frame as a flat list — the basis for inline values.
   *
   * A request of its own rather than scopes/variables: the inline values
   * provider runs on every jump in the editor and needs only names and
   * values, no references, no catch tags. It deliberately answers with an
   * empty list rather than an error when nothing is halted — one failed
   * request per cursor movement would be nothing but noise.
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
   * Deliver a variable set. The internal fields __frame/__settable do NOT
   * go over the wire: DAP clients may ignore unknown fields, but they are
   * ballast and would be confusing in a protocol trace.
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
   * Set a local variable in the halted frame.
   *
   * Swank has no dedicated call for this; the way is an assignment IN THE
   * FRAME via eval-string-in-frame. That only works when SBCL carries the
   * variable as settable — with highly optimised code it often is not,
   * and the assignment runs into the void without complaining.
   *
   * That is why after setting it the value is READ AGAIN and the actual
   * value reported back. Otherwise VS Code shows the wished-for value
   * while the old one stands in the image — the worst kind of debugger
   * display.
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
      this.fail(req, 1014, `${name} is not settable (not a frame local).`);
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
      this.fail(req, 1016, 'Empty value.');
      return;
    }
    try {
      // Assignment and return of the value read afterwards in ONE call:
      // two round trips could catch a restart that changes the level
      // between them.
      const form = `(progn (setq ${name} ${trimmed}) ${name})`;
      const raw = await this.swank.rex(
        this.frameEvalForm(form, frame), this.swank.packageName, level.thread, 8000
      );
      const shown = text(raw).trim();
      // A cross-check: read the frame again and update the entry, so that
      // the variables view and the return field say the same thing.
      entry.value = shown;
      this.respond(req, { value: shown, variablesReference: 0 });
      if (shown !== trimmed) {
        this.event('output', {
          category: 'console',
          output:
            `${name} = ${shown}` +
            (shown === '' ? ' (empty — the assignment probably did not take effect)\n' : '\n'),
        });
      }
    } catch (e) {
      // The most common case: the variable is not settable in the
      // compiled code. The message says what to do.
      this.fail(
        req, 1017,
        `${name} could not be set: ${e}\n` +
        'For locals optimised away, the only remedy is to recompile the ' +
        'function with (declaim (optimize (debug 3) (speed 0))).'
      );
    }
  }

  /**
   * Store a variable set. The reference is attached to the level, so that
   * it goes away when EXACTLY that level is left — previously the whole
   * table was cleared for every new debugger, including the sets of other
   * threads.
   */
  private store(level: DebugLevel, vars: any[]): number {
    const ref = this.nextVarRef++;
    this.variableSets.set(ref, vars);
    level.varRefs.push(ref);
    return ref;
  }

  // ------------------------------------------------------------------
  // Evaluation and restarts
  // ------------------------------------------------------------------

  private async evaluate(
    req: DapRequest, expression: string, frameId?: number, context?: string
  ): Promise<void> {
    if (expression.startsWith(',')) return this.consoleCommand(req, expression);

    // A bare digit with the debugger open = choose a restart, as in SLDB.
    // In Emacs 0/1/2 is a key binding; here it is an input line that
    // would otherwise evaluate the number as a Lisp expression and return
    // 0 verbatim — which looks as if nothing were happening.
    const bare = expression.trim();
    if (this.top && /^\d+$/.test(bare)) {
      const n = Number(bare);
      if (n < this.top.restarts.length) return this.invokeRestart(req, n);
      this.respond(req, {
        result:
          `; There is no restart ${n} (0–${this.top.restarts.length - 1}). ` +
          `To evaluate the number: ,eval ${n}`,
        variablesReference: 0,
      });
      return;
    }

    // The hint exactly once per debugger level, not on every input.
    if (this.top && frameId === undefined && !this.warnedAboutOpenDebugger) {
      this.warnedAboutOpenDebugger = true;
      this.event('output', {
        output:
          '; The Lisp debugger is open. This evaluation runs in a thread ' +
          'of its own, not in the halted one. For evaluation IN THE FRAME, ' +
          'select a frame in the call stack first.\n',
        category: 'console',
      });
    }
    return this.evaluateForms(req, expression, frameId, context);
  }

  private async evaluateForms(
    req: DapRequest, expression: string, frameId?: number, context?: string
  ): Promise<void> {
    // Hover takes a separate, guarded route — see evaluateHover.
    if (context === 'hover') return this.evaluateHover(req, expression);
    try {
      const state = this.top;
      if (state && frameId !== undefined) state.selectedFrame = frameId;
      // eval-and-grab-output is the only entry point with a defined
      // return value: (output value-as-string). interactive-eval answered
      // every expression here with an arity error, listener-eval did not
      // answer at all — both unexplained. Instead of going on guessing,
      // the form that was sent is now carried in every error message.
      // Send several forms individually: eval-and-grab-output AND
      // eval-string-in-frame each read only the first. Without this, all
      // further ones vanish silently.
      //
      // The frame path was exempt from this — on the grounds that in a
      // frame one evaluates single expressions. That went wrong, because
      // VS Code automatically selects frame 0 when halting and sends the
      // frameId along on EVERY input. So the exception branch always ran,
      // and `(+ 1 2) (+ 3 4)` yielded only 3.
      const forms = splitTopLevelForms(expression);
      const chunks: string[] = [];
      for (const raw of forms.length > 0 ? forms : [expression]) {
        const useFrame = state && frameId !== undefined;
        const one = useFrame
          ? this.frameEvalForm(raw, frameId!)
          : `(swank:eval-and-grab-output ${lispString(raw)})`;
        this.lastForm = one;
        // IMPORTANT: only an evaluation IN THE FRAME goes to the halted
        // thread. Everything else gets a fresh worker (thread designator
        // t).
        //
        // The thread in the debugger sits in Swank's SLDB loop; an
        // ordinary :emacs-rex sent there answers with an arity error and
        // opens a further debugger level. That is exactly how the chain
        // level 2, 3, 4 came about — and in the end the image hung,
        // because the levels piled up.
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
        // Make an empty result visible: otherwise "succeeded, but no
        // value" cannot be told apart from "no answer at all".
        result: rendered === '' ? '; no value' : rendered,
        variablesReference: 0,
      });
    } catch (e) {
      // An invoked restart aborts the running evaluation — Swank then
      // answers with (:abort …). That is the intended outcome and not a
      // disturbance.
      if (/:abort/i.test(String(e))) {
        this.respond(req, {
          result: '; Auswertung durch Restart abgebrochen',
          variablesReference: 0,
        });
        return;
      }
      // The form that was sent belongs in the message — without it, a
      // protocol problem leaves nothing but guesswork.
      this.fail(req, 1003, `${e}\n  gesendet: ${this.lastForm}`);
    }
  }

  // ------------------------------------------------------------------
  // Hover
  // ------------------------------------------------------------------

  /**
   * Hover evaluation. Never in the frame, never in the halted thread, and
   * the expression is READ ONLY INSIDE ignore-errors.
   *
   * This was the remaining route into the debugger: with
   * `(swank:eval-and-grab-output "(values (ignore-errors X))")` Swank
   * reads the whole string before any handler is in place. A reader error
   * in X — `#<`, an unclosed paren — therefore jumped into the debugger
   * despite ignore-errors, and moving the mouse over a backtrace piled up
   * levels by the second.
   *
   * With read-from-string INSIDE, the reading happens during the
   * evaluation, that is, under the protection of ignore-errors.
   *
   * (values ...) cuts off the second return value: on an error
   * ignore-errors returns nil AND the condition object, which ended up in
   * the tooltip as "nil, #<unbound-variable rpc …>".
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
      // Always a fresh worker (t): the halted thread sits in the SLDB
      // loop, and eval-string-in-frame runs with an active debugger hook,
      // where ignore-errors is of no use.
      const r = await this.swank.rex(one, this.swank.packageName, new Sym('t'), 4000);
      const p = asList(r);
      const shown =
        p.length >= 2
          ? [text(p[0]), text(p[1])].filter(x => x !== '').join('\n')
          : text(r);
      this.respond(req, {
        // Empty stays empty: otherwise a tooltip sticks to every word.
        result: shown,
        variablesReference: 0,
        presentationHint: { kind: 'property' },
      });
    } catch {
      // A failed hover is not an event the user wants to be told about.
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
        // An escape route for evaluating a number after all while the
        // debugger is open.
        return this.evaluateForms(req, arg, undefined, 'repl');
      case 'abort':
        return this.abortAll(req);
      default:
        this.respond(req, {
          result:
            'Commands: DIGIT (choose a restart) | ,restarts | ,restart N | ,abort\n' +
            '         ,eval AUSDRUCK | ,return AUSDRUCK | ,disassemble [N]',
          variablesReference: 0,
        });
    }
  }

  /**
   * Invoke a restart and wait for the answer. The prototype fired a raw
   * rex with the hard-wired ID 9000001 — two calls in a row would have
   * used the same ID.
   */
  private async invokeRestart(req: DapRequest, index: number): Promise<void> {
    const state = this.top;
    if (!state) {
      this.fail(req, 1006, 'Kein aktiver Lisp-Debugger.');
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= state.restarts.length) {
      this.fail(req, 1007, `There is no restart ${index}.`);
      return;
    }
    const chosen = state.restarts[index];
    this.event('output', {
      output: `Restart ${index}: [${chosen.name}] ${chosen.description}\n`,
      category: 'console',
    });
    try {
      // The answer only comes once the restart has run through — that can
      // take a while and is not an error.
      // Restarts are SLDB commands and belong to the halted thread —
      // unlike ordinary evaluations.
      void this.swank
        .rex(`(swank:invoke-nth-restart-for-emacs ${state.level} ${index})`,
             this.swank.packageName, state.thread, 0)
        .catch(e => {
          // A restart that unwinds the stack ends the running request
          // with (:abort …). That is the normal case and not a
          // disturbance — only anything else is worth reporting.
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
   * Is a step out of THIS level possible at all?
   *
   * The condition is in the restarts, which Swank has sent along anyway —
   * no round trip into the image is needed. swank:sldb-step does:
   *
   *   (cond ((find-restart 'continue) (activate-stepping frame)
   *                                   (invoke-restart 'continue))
   *         (t (error "Not currently single-stepping, …")))
   *
   * Without a CONTINUE restart the call therefore signals an error, and
   * because it runs in the halted thread that becomes a NEW debugger
   * level rather than a rejected request.
   *
   * A test for (fboundp 'swank:sldb-step) was the wrong question: the
   * function is there, it just refuses. That is exactly what the previous
   * version walked past, producing level 2 with "Not currently
   * single-stepping".
   */
  private canStep(level: DebugLevel): boolean {
    return level.restarts.some(r => r.name.toUpperCase() === 'CONTINUE');
  }

  private async step(req: DapRequest, operation: string): Promise<void> {
    const level = this.top;
    if (!level) {
      this.fail(req, 1008, 'Stepping is only possible in a halted Lisp debugger session.');
      return;
    }
    if (!this.canStep(level)) {
      // Decline and leave the session visibly halted — NO 'continued'. VS
      // Code shows the reason as a message.
      this.fail(
        req, 1012,
        'There is no stepping out of this condition: it offers no CONTINUE ' +
        'restart, without which SBCL cannot take up single-stepping. Carry ' +
        'on via the restarts in the debug view. Stepping also requires a ' +
        'high debug quality, for instance ' +
        '(declaim (optimize (debug 3) (speed 0) (safety 3))).'
      );
      return;
    }
    const frame = level.selectedFrame ?? 0;
    // As with restarts, do not wait for the RPC return value: sldb-step
    // resumes execution and often only answers at the next step stop or
    // when leaving the frame. The DAP request has to be free immediately.
    void this.swank
      .rex(`(${operation} ${frame})`, this.swank.packageName, level.thread, 0)
      .catch(e => {
        if (/:abort/i.test(String(e))) return; // the regular outcome
        this.event('output', {
          output:
            `Stepping failed: ${e}. The code has to be compiled with a high ` +
            'debug quality, e.g. (declaim (optimize (debug 3) (speed 0) (safety 3))).\n',
          category: 'stderr',
        });
        // Straighten the state out again: the 'continued' from below was
        // an advance payment on a step that did not take place. Without
        // this the interface stays on "running" while Lisp waits in SLDB —
        // and the next condition put a level on top of a state VS Code was
        // no longer displaying at all.
        this.resyncStopped();
      });
    this.respond(req);
    this.event('continued', { threadId: this.stoppedThreadId, allThreadsContinued: false });
  }

  /** Report the current debugger level as halted once more. */
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
   * Map DAP "Continue" onto a restart. The choice is not unambiguous —
   * CONTINUE if there is one, otherwise ABORT, otherwise the first. Which
   * one was taken is written to the console, so that it does not stay
   * guesswork.
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
   * Back to the topmost level. When the debugger piles up over several
   * levels (every failed eval adds one), this is the shortest way out.
   * SLIME calls this restart *ABORT.
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
   * Evaluation for the CLAMPS REPL terminal over THIS connection.
   *
   * The point: errors from the REPL should open the debugger. Over the
   * bridge that does not work — there eval-for-repl catches every
   * condition, and even without that the bridge could not pass a :debug
   * event on. If the evaluation runs over the debug socket instead, the
   * event arrives here and VS Code opens the debugger.
   *
   * Without a deadline: if the debugger appears, Swank only answers once
   * a restart has been chosen. That can take arbitrarily long and is not
   * an error.
   */
  private async replEval(req: DapRequest, code: string, pkg: string): Promise<void> {
    if (!code.trim()) {
      this.respond(req, { status: 'ok', output: '', package: pkg });
      return;
    }
    // Only one REPL evaluation at a time. If one is already running
    // (waiting in the debugger), decline this one rather than losing
    // track.
    if (this.inflightRepl && !this.inflightRepl.answered) {
      this.respond(req, {
        status: 'busy',
        output: '; The previous evaluation is still in the debugger. Choose a restart first.',
        package: pkg,
      });
      return;
    }

    const entry = { swankId: -1, req, pkg, answered: false };
    this.inflightRepl = entry;
    try {
      // The deadline stays set: if the debugger opens, it is cleared in
      // onDebug specifically for THIS request. If, on the other hand, an
      // answer fails to arrive without a debugger (the function is
      // missing in the image), the timeout takes effect and the REPL does
      // not hang mutely.
      const r = await this.swank.rex(
        `(clamps-bridge-rpc:eval-for-repl-debuggable ${lispString(code)} ${lispString(pkg)})`,
        pkg, new Sym('t'), 15000,
        id => { entry.swankId = id; }
      );
      // If a real answer arrived (no debugger), answer normally —
      // provided onDebug has not already resolved the request.
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
        // The debugger had already answered the request; the evaluation
        // then ran to completion normally after all (after [continue],
        // say). Push the result through as output.
        this.event('output', {
          output: `${text(parts[1])}\n`,
          category: 'stdout',
        });
      }
    } catch (e) {
      if (entry.answered) {
        // Already answered (debugger); an (:abort …) arriving afterwards
        // is the normal outcome of a restart.
        if (!/:abort/i.test(String(e))) {
          this.event('output', {
            output: `; REPL-Auswertung: ${e}\n`, category: 'stderr',
          });
        }
        return;
      }
      // A restart that aborts ends the evaluation with (:abort …).
      const msg = String(e);
      const aborted = /:abort/i.test(msg);
      const timedOut = /No answer from Swank/.test(msg);
      entry.answered = true;
      this.respond(req, {
        status: aborted ? 'aborted' : 'error',
        output: aborted
          ? '; durch Restart abgebrochen'
          : timedOut
            ? msg +
              '\n; Check whether the running image knows the function:\n' +
              ";   (fboundp 'clamps-bridge-rpc::eval-for-repl-debuggable)\n" +
              '; If NIL comes back, "CLAMPS: Restart" helps.'
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
      this.fail(req, 1009, 'No frame selected.');
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

  // terminateThreads deliberately NOT offered.
  //
  // swank:kill-nth-thread expects an INDEX into Swank's thread list,
  // whereas towards VS Code we carry the thread IDs from the :debug
  // message. Confusing the two means killing an arbitrary thread — if it
  // hits the control or reader thread the whole image is gone, without an
  // error being logged anywhere. And VS Code offers "Terminate Thread" in
  // the context menu of the call stack as soon as you announce the
  // capability. Killing threads does not belong in a debugger interface
  // anyway; that is what the restarts are for.

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
  // Handing over to the existing inspector
  // ------------------------------------------------------------------

  /**
   * Binds a value to a freshly created symbol in CL-USER and returns its
   * name. The existing inspector can be pointed at that, without a second
   * inspector model arising here — and object identity is preserved,
   * because the value is not recomputed, only named.
   */
  private async bind(expression: string, frameId?: number): Promise<{ expression: string; package: string }> {
    const token = `CLAMPS-DEBUG-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const bind = `(setf (symbol-value (intern ${lispString(token)} "COMMON-LISP-USER")) ${expression})`;
    const form =
      frameId !== undefined
        ? this.frameEvalForm(bind, frameId)
        : `(swank:eval-and-grab-output ${lispString(bind)})`;
    // Without a frame, into a fresh worker, for the same reason as with
    // evaluate: the halted thread does not take ordinary requests.
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
      this.fail(req, 1021, `The value could not be bound for the inspector: ${e}`);
    }
  }

  private async bindCondition(req: DapRequest): Promise<void> {
    try {
      // Swank keeps the active condition in SWANK::*SLDB-CONDITION*.
      // find-symbol rather than a direct reference, because the export
      // varies between Swank versions.
      const expr =
        `(let ((s (find-symbol "*SLDB-CONDITION*" "SWANK"))) ` +
        `(if (and s (boundp s)) (symbol-value s) ` +
        `(error "This Swank does not provide the active condition.")))`;
      this.respond(req, await this.bind(expr, this.top?.selectedFrame ?? 0));
    } catch (e) {
      this.fail(req, 1022, `Could not bind the condition: ${e}`);
    }
  }
}
