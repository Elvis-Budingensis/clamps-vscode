// extension.ts
//
// Activation point of the extension. Sequence when a .lisp file is
// opened:
//   1. ClampsProcessManager makes sure that bootstrap.lisp (SBCL +
//      CLAMPS + Swank) is running, or restarts it.
//   2. As soon as the session is "ready" the LanguageClient is started,
//      which in turn spawns bridge-server.lisp as its own process.
//   3. bridge-server.lisp connects to the Swank port itself and speaks
//      LSP over stdio with the LanguageClient.

import * as vscode from 'vscode';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  CloseAction,
  ErrorAction,
} from 'vscode-languageclient/node';
import { ClampsProcessManager } from './processManager';
import { ClampsReplTerminal, readState } from './replTerminal';
import { StickerPoller } from './stickerPoll';
import { MeterView } from './meterView';
import { FreqScopeView, SpectrumFrame } from './freqScope';
import { SpectrogramView, SpectrogramFrames } from './spectrogramView';
import { BufferView, BufferOutline } from './bufferView';
import { AtsView, AtsOutline } from './atsView';
import { SampleBrowserView, SampleListing } from './sampleBrowser';
import { MidiMonitorView, MidiBatch } from './midiMonitor';
import { OscMonitorView, OscBatch } from './oscMonitor';
import { macroexpandCommand, topLevelFormAt, sexpBeforePoint, packageAt } from './macroexpand';
import { disassembleCommand, symbolAt } from './disassemble';
import { inspectCommand } from './inspector';
import { ClampsRtStatus } from './rtStatus';
import { ClampsDebugSession } from './debugSession';
import { IncudineNodeProvider } from './nodeBrowser';
import { LispBrowserProvider } from './imageBrowsers';
import { ClampsInlineValuesProvider } from './inlineValues';
import { CompilerDiagnostics } from './compilerDiagnostics';
import { xrefCommand, aproposCommand, breakOnSignalsCommand } from './slimeTools';
import { XrefBrowserProvider, XrefEntry, openXrefEntry } from './xrefBrowser';
import { xrefNavigationHistory } from './xrefNavigation';
import { ImageIndentationProvider } from './imageIndentation';
import { registerStructuralEditing } from './structuralEditing';
import { registerAdvancedTools } from './advancedTools';

let client: LanguageClient | undefined;
let processManager: ClampsProcessManager | undefined;
let outputChannel: vscode.OutputChannel;
let clientStartPromise: Promise<void> | undefined;
let lifecycleQueue: Promise<void> = Promise.resolve();
let rtStatus: ClampsRtStatus | undefined;

/**
 * Fetch cycle for sticker rings. The audio thread pushes nothing of its
 * own accord — it may neither send nor block — so the client fetches. It
 * runs only while a display is watching.
 */
const stickerPoller = new StickerPoller(async (key, since, limit) => {
  if (!client || client.state !== State.Running) return undefined;
  return client.sendRequest<{ sequence: number; dropped: number; values: number[] }>(
    'clamps/stickerSamples', { key, since, limit }
  );
});
let incudineNodes: IncudineNodeProvider | undefined;
let packageBrowser: LispBrowserProvider | undefined;
let classBrowser: LispBrowserProvider | undefined;
let threadBrowser: LispBrowserProvider | undefined;
let traceBrowser: LispBrowserProvider | undefined;
let xrefBrowser: XrefBrowserProvider | undefined;
let compilerDiagnostics: CompilerDiagnostics | undefined;

function enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
  const queued = lifecycleQueue.then(operation, operation);
  lifecycleQueue = queued.catch(() => undefined);
  return queued;
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('CLAMPS');

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage(
      'CLAMPS: Please open a workspace folder first (File → Open Folder).'
    );
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Both Lisp scripts live in the extension itself, not in the user's
  // workspace — context.asAbsolutePath points into the installation
  // folder of the extension.
  const bootstrapPath = context.asAbsolutePath(path.join('lisp', 'bootstrap.lisp'));
  const bridgePath = context.asAbsolutePath(path.join('lisp', 'bridge-server.lisp'));

  processManager = new ClampsProcessManager(workspaceRoot, bootstrapPath);
  rtStatus = new ClampsRtStatus(() => client);
  incudineNodes = new IncudineNodeProvider(() => client);
  packageBrowser = new LispBrowserProvider('clamps/packages', () => client);
  classBrowser = new LispBrowserProvider('clamps/classes', () => client);
  threadBrowser = new LispBrowserProvider('clamps/threads', () => client);
  traceBrowser = new LispBrowserProvider('clamps/traced', () => client);
  xrefBrowser = new XrefBrowserProvider(() => client);
  compilerDiagnostics = new CompilerDiagnostics(() => client);
  const imageIndentation = new ImageIndentationProvider(() => client);
  registerStructuralEditing(context);
  registerAdvancedTools(context, () => client);
  context.subscriptions.push(rtStatus, incudineNodes, packageBrowser, classBrowser, threadBrowser, traceBrowser, xrefBrowser, compilerDiagnostics);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('clamps.incudineNodes', incudineNodes),
    vscode.window.registerTreeDataProvider('clamps.xrefView', xrefBrowser),
    vscode.window.registerTreeDataProvider('clamps.packages', packageBrowser),
    vscode.window.registerTreeDataProvider('clamps.classes', classBrowser),
    vscode.window.registerTreeDataProvider('clamps.threads', threadBrowser),
    vscode.window.registerTreeDataProvider('clamps.traced', traceBrowser),
    // Inline values: values of the frame locals in the editor while Lisp
    // is halted. Registered for both language IDs, because .lisp and .cl
    // are assigned differently depending on the settings.
    vscode.languages.registerInlineValuesProvider(
      [{ language: 'commonlisp' }, { language: 'lisp' }],
      new ClampsInlineValuesProvider()
    ),
    vscode.languages.registerOnTypeFormattingEditProvider([{ language: 'commonlisp' }, { language: 'lisp' }], imageIndentation, '\n'),
    vscode.languages.registerDocumentRangeFormattingEditProvider([{ language: 'commonlisp' }, { language: 'lisp' }], imageIndentation),
    vscode.commands.registerCommand('clamps.refreshIndentation', () => imageIndentation.refresh()),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (vscode.workspace.getConfiguration('clamps').get<boolean>('compilerDiagnosticsOnSave', true)) {
        void compilerDiagnostics?.update(doc);
      }
    })
  );

  // Debug adapter. Runs "inline", that is, in the same extension host
  // process — no adapter process of its own, and the adapter can reach
  // processManager instead of reading session.json a second time.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('clamps', {
      createDebugAdapterDescriptor() {
        const port = processManager?.getPort();
        if (!port) {
          vscode.window.showErrorMessage(
            'CLAMPS is not running — run "CLAMPS: Start" first.'
          );
          return undefined;
        }
        return new vscode.DebugAdapterInlineImplementation(
          new ClampsDebugSession(port, workspaceRoot)
        );
      },
    }),
    // Attach without launch.json: the configuration is empty anyway,
    // because port and root directory come from the process manager.
    vscode.debug.registerDebugConfigurationProvider('clamps', {
      provideDebugConfigurations() {
        return [{
          type: 'clamps', request: 'attach', name: 'CLAMPS: Attach Debugger',
          internalConsoleOptions: 'neverOpen',
        }];
      },
      resolveDebugConfiguration(_folder, config) {
        if (!config.type) {
          config.type = 'clamps';
          config.request = 'attach';
          config.name = 'CLAMPS: Attach Debugger';
        }
        // Also for a configuration inherited from launch.json: the debug
        // console should not push the REPL out of the panel. An explicit
        // setting by the user is left alone.
        if (config.internalConsoleOptions === undefined) {
          config.internalConsoleOptions = 'neverOpen';
        }
        return config;
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clamps.start', () =>
      enqueueLifecycle(() => startClamps(context, bridgePath))
    ),
    vscode.commands.registerCommand('clamps.stop', () =>
      enqueueLifecycle(() => stopClamps())
    ),
    vscode.commands.registerCommand('clamps.restart', () =>
      enqueueLifecycle(async () => {
        await stopClamps();
        await startClamps(context, bridgePath);
      })
    ),
    vscode.commands.registerCommand('clamps.openLog', async () => {
      // The only place where a crash of the image is documented. Ldb
      // messages, "fatal error encountered", heap exhausted and errors
      // while loading CLAMPS all go over the SBCL process's stderr and
      // end up here.
      const file = processManager?.logFile;
      if (!file) {
        void vscode.window.showWarningMessage('CLAMPS: No workspace, no log.');
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        void vscode.window.showInformationMessage(
          `CLAMPS: No log at ${file} yet. It appears at the next start.`
        );
      }
    }),
    vscode.commands.registerCommand('clamps.openRepl', () => ClampsReplTerminal.show(() => client)),
    vscode.commands.registerCommand('clamps.meterShow', () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      MeterView.show(stickerPoller, async () => {
        const c = client;
        if (!c || c.state !== State.Running) return [];
        const r = await c.sendRequest<{ entries?: { key: string; elementType: string }[] }>(
          'clamps/stickerKeys', {}
        );
        // Unboxed rings only: a sticker with :element-type t contains
        // arbitrary values from which no level can be computed.
        return (r.entries ?? [])
          .filter(e => e.elementType === 'double-float')
          .map(e => e.key);
      });
      // The cycle runs only while somebody is watching.
      stickerPoller.start(
        vscode.workspace.getConfiguration('clamps').get<number>('meterIntervalMs', 100)
      );
    }),
    vscode.commands.registerCommand('clamps.freqScopeShow', () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      const configuration = vscode.workspace.getConfiguration('clamps');
      FreqScopeView.show(
        async params => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<SpectrumFrame>('clamps/stickerSpectrum', params);
        },
        async () => {
          const c = client;
          if (!c || c.state !== State.Running) return [];
          const r = await c.sendRequest<{
            entries?: { key: string; capacity: number; decimation: number; elementType: string }[];
          }>('clamps/stickerKeys', {});
          return r.entries ?? [];
        },
        configuration.get<number>('freqScopeIntervalMs', 50),
        configuration.get<number>('freqScopeFftSize', 2048)
      );
    }),
    vscode.commands.registerCommand('clamps.spectrogramShow', () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      const configuration = vscode.workspace.getConfiguration('clamps');
      SpectrogramView.show(
        async params => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<SpectrogramFrames>('clamps/stickerSpectrogram', params);
        },
        async () => {
          const c = client;
          if (!c || c.state !== State.Running) return [];
          const r = await c.sendRequest<{
            entries?: { key: string; capacity: number; decimation: number; elementType: string }[];
          }>('clamps/stickerKeys', {});
          return r.entries ?? [];
        },
        configuration.get<number>('spectrogramIntervalMs', 60),
        configuration.get<number>('freqScopeFftSize', 2048)
      );
    }),
    vscode.commands.registerCommand('clamps.bufferShow', async () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      // The selection, the symbol at the cursor, or an explicit question —
      // the same order as the inspector, so that "look at this" works the
      // same way everywhere.
      const editor = vscode.window.activeTextEditor;
      let expr = '';
      if (editor && !editor.selection.isEmpty) {
        expr = editor.document.getText(editor.selection).trim();
      } else if (editor) {
        const range = editor.document.getWordRangeAtPosition(
          editor.selection.active, /[^\s()'"`,;]+/);
        if (range) expr = editor.document.getText(range);
      }
      if (!expr) {
        expr = (await vscode.window.showInputBox({
          prompt: 'Buffer to display',
          placeHolder: '*my-buffer*',
        }))?.trim() ?? '';
      }
      if (!expr) return;
      const pkg = editor ? packageAt(editor.document, editor.selection.active)
                         : 'COMMON-LISP-USER';
      BufferView.show(
        async params => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<BufferOutline>('clamps/bufferOutline', params);
        },
        expr, pkg
      );
    }),
    vscode.commands.registerCommand('clamps.atsShow', async (given?: string) => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      // A path, not an expression: an ATS analysis is a file, and asking
      // for a Lisp form here would mean the user has to have loaded it
      // first in order to look at it.
      let path = given;
      if (!path) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Show ATS analysis',
          filters: { 'ATS analysis': ['ats'], 'All files': ['*'] },
        });
        path = picked?.[0]?.fsPath;
      }
      if (!path) return;
      AtsView.show(
        async params => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<AtsOutline>('clamps/atsOutline', params);
        },
        async (action, file) => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<{ ok: boolean; message: string }>(
            action === 'play' ? 'clamps/atsPlay' : 'clamps/atsStop',
            action === 'play' ? { path: file, amplitude: 1.0 } : {}
          );
        },
        path
      );
    }),
    vscode.commands.registerCommand('clamps.samplesShow', async () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Browse samples',
      });
      const directory = picked?.[0]?.fsPath;
      if (!directory) return;
      SampleBrowserView.show(
        async params => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<SampleListing>('clamps/sampleBrowse', params);
        },
        (entry) => {
          // The table answers "which file", the waveform "what is in it".
          // Handing the path straight over is what makes having both worth
          // it; asking the user to open a second dialogue would not.
          BufferView.show(
            async params => {
              const c = client;
              if (!c || c.state !== State.Running) return undefined;
              return c.sendRequest<BufferOutline>('clamps/bufferOutline', params);
            },
            `(incudine:buffer-load "${entry.path.replace(/["\\]/g, '\\$&')}")`,
            'COMMON-LISP-USER'
          );
        },
        directory
      );
    }),
    vscode.commands.registerCommand('clamps.midiShow', () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      const configuration = vscode.workspace.getConfiguration('clamps');
      MidiMonitorView.show(
        async since => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<MidiBatch>('clamps/midiEvents', { since, limit: 512 });
        },
        async action => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<{ ok: boolean; message: string }>(
            'clamps/midiMonitor', { action, capacity: 2048 });
        },
        configuration.get<number>('midiIntervalMs', 60)
      );
    }),
    vscode.commands.registerCommand('clamps.oscShow', () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not running. Run "CLAMPS: Start".');
        return;
      }
      const configuration = vscode.workspace.getConfiguration('clamps');
      OscMonitorView.show(
        async since => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<OscBatch>('clamps/oscEvents', { since, limit: 256 });
        },
        async (action, port) => {
          const c = client;
          if (!c || c.state !== State.Running) return undefined;
          return c.sendRequest<{ ok: boolean; message: string }>(
            'clamps/oscMonitor', { action, port, capacity: 1024 });
        },
        configuration.get<number>('oscIntervalMs', 80),
        configuration.get<number>('oscPort', 32126)
      );
    }),
    vscode.commands.registerCommand('clamps.evalSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.document.getText(editor.selection) || editor.document.lineAt(editor.selection.active.line).text;
      await evaluateChecked(() => client, code);
    }),
    vscode.commands.registerCommand('clamps.evalFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await evaluateChecked(() => client, editor.document.getText());
    }),
    vscode.commands.registerCommand('clamps.evalLastExpression', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const form = sexpBeforePoint(editor.document, editor.selection.active);
      if (!form) {
        vscode.window.showWarningMessage(
          'CLAMPS: No s-expression before the cursor.'
        );
        return;
      }
      await evaluateChecked(() => client, form);
    }),
    vscode.commands.registerCommand('clamps.evalTopLevel', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const form = topLevelFormAt(editor.document, editor.selection.active);
      if (!form) {
        vscode.window.showWarningMessage(
          'CLAMPS: No top-level form found at the cursor.'
        );
        return;
      }
      await evaluateChecked(() => client, form);
    }),
    vscode.commands.registerCommand('clamps.macroexpand', () =>
      macroexpandCommand(() => client, false, outputChannel)
    ),
    vscode.commands.registerCommand('clamps.macroexpandAll', () =>
      macroexpandCommand(() => client, true, outputChannel)
    ),
    vscode.commands.registerCommand('clamps.disassemble', () =>
      disassembleCommand(() => client, outputChannel)
    ),
    // Optional arguments: the debugger calls this command with an
    // already bound symbol name instead of going through the active
    // editor. Without arguments the behaviour is unchanged.
    vscode.commands.registerCommand(
      'clamps.inspect',
      (expression?: string, packageName?: string) =>
        inspectCommand(() => client, expression, packageName)
    ),
    vscode.commands.registerCommand('clamps.toggleTrace', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const symbol = symbolAt(editor.document, editor.selection.active);
      if (!symbol) {
        vscode.window.showWarningMessage('CLAMPS: No symbol at the cursor.');
        return;
      }
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not connected.');
        return;
      }
      const pkg = packageAt(editor.document, editor.selection.active);
      const result = await client.sendRequest<{ output: string; traced: boolean }>(
        'clamps/toggleTrace',
        { symbol, package: pkg }
      );
      vscode.window.setStatusBarMessage(`CLAMPS: ${result.output}`, 5000);
    }),
    vscode.commands.registerCommand('clamps.untraceAll', async () => {
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS is not connected.');
        return;
      }
      const result = await client.sendRequest<{ output: string }>(
        'clamps/untraceAll',
        {}
      );
      vscode.window.setStatusBarMessage(`CLAMPS: ${result.output}`, 5000);
    }),
    vscode.commands.registerCommand('clamps.debugAttach', () =>
      vscode.debug.startDebugging(undefined, {
        type: 'clamps', request: 'attach', name: 'CLAMPS: Attach Debugger',
        internalConsoleOptions: 'neverOpen',
      })
    ),
    vscode.commands.registerCommand('clamps.debugRestarts', () => chooseRestart()),
    vscode.commands.registerCommand('clamps.debugAbortAll', async () => {
      const session = vscode.debug.activeDebugSession;
      if (!session || session.type !== 'clamps') {
        vscode.window.showErrorMessage('No active CLAMPS debug session.');
        return;
      }
      await session.customRequest('clamps/abortAll', {});
    }),
    vscode.commands.registerCommand('clamps.debugInspectCondition', () =>
      inspectFromDebugger('clamps/bindCondition', {})
    ),
    vscode.commands.registerCommand('clamps.debugInspectVariable', (arg?: any) => {
      const expression =
        arg?.variable?.evaluateName ?? arg?.evaluateName ?? arg?.variable?.name ?? arg?.name;
      if (typeof expression !== 'string' || !expression) {
        vscode.window.showWarningMessage(
          'This value has no evaluable Lisp name.'
        );
        return;
      }
      return inspectFromDebugger('clamps/bindForInspector', {
        expression,
        frameId: arg?.variable?.frameId ?? arg?.frameId,
      });
    }),
    vscode.commands.registerCommand('clamps.rtStatusDetails', () =>
      rtStatus?.showDetails()
    ),
    vscode.commands.registerCommand('clamps.incudineRefresh', () =>
      incudineNodes?.refresh()
    ),
    vscode.commands.registerCommand('clamps.packagesRefresh', () => packageBrowser?.refresh()),
    vscode.commands.registerCommand('clamps.classesRefresh', () => classBrowser?.refresh()),
    vscode.commands.registerCommand('clamps.threadsRefresh', () => threadBrowser?.refresh()),
    vscode.commands.registerCommand('clamps.tracedRefresh', () => traceBrowser?.refresh()),
    vscode.commands.registerCommand('clamps.untraceOne', async (item?: { label?: string }) => {
      const label = item?.label;
      if (!label) return;
      const current = client;
      if (!current || current.state !== State.Running) {
        void vscode.window.showErrorMessage('CLAMPS is not connected.');
        return;
      }
      try {
        const r = await current.sendRequest<{ ok: boolean; message: string }>(
          'clamps/untraceOne', { label });
        if (r.ok) outputChannel.appendLine(r.message);
        else void vscode.window.showWarningMessage(r.message);
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not untrace ${label}: ${e}`);
      }
      await traceBrowser?.refresh();
    }),
    vscode.commands.registerCommand('clamps.inspectBrowserItem', (expression?: string) => {
      if (expression) return vscode.commands.executeCommand('clamps.inspect', expression, 'COMMON-LISP-USER');
    }),
    vscode.commands.registerCommand('clamps.compileDiagnostics', () => {
      const doc=vscode.window.activeTextEditor?.document;
      if(doc) return compilerDiagnostics?.update(doc);
    }),
    // Evaluating in the REPL may have changed the node tree (dsp!,
    // rt-start, node-free). Instead of polling — which creates needless
    // load while audio is running — pull once after every REPL
    // evaluation, with a small delay so that the node already exists.
    vscode.commands.registerCommand('clamps.closeParens', () => closeParens()),
    vscode.commands.registerCommand('clamps.checkBalance', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const problem = balanceProblem(editor.document.getText());
      vscode.window.showInformationMessage(
        problem ?? 'Parens and strings are balanced.'
      );
    }),
    vscode.commands.registerCommand('clamps.incudineRefreshSoon', () => {
      setTimeout(() => void incudineNodes?.refresh(), 300);
    }),
    vscode.commands.registerCommand('clamps.incudineInspectNode', async (id?: number) => {
      if (typeof id !== 'number' || id < 0) return;
      await vscode.commands.executeCommand(
        'clamps.inspect',
        `(incudine:node ${id})`,
        'COMMON-LISP-USER'
      );
    }),
    vscode.commands.registerCommand('clamps.xref', () => xrefCommand(() => client, xrefBrowser)),
    vscode.commands.registerCommand('clamps.xrefDefinitions', () => xrefCommand(() => client, undefined, 'definitions')),
    vscode.commands.registerCommand('clamps.xrefCallers', () => xrefCommand(() => client, undefined, 'callers')),
    vscode.commands.registerCommand('clamps.xrefCallees', () => xrefCommand(() => client, undefined, 'callees')),
    vscode.commands.registerCommand('clamps.xrefReferences', () => xrefCommand(() => client, undefined, 'references')),
    vscode.commands.registerCommand('clamps.xrefBindings', () => xrefCommand(() => client, undefined, 'bindings')),
    vscode.commands.registerCommand('clamps.xrefSetters', () => xrefCommand(() => client, undefined, 'setters')),
    vscode.commands.registerCommand('clamps.xrefMacroexpands', () => xrefCommand(() => client, undefined, 'macroexpands')),
    vscode.commands.registerCommand('clamps.xrefRefresh', () => xrefBrowser?.refresh()),
    vscode.commands.registerCommand('clamps.xrefOpen', (entry: XrefEntry) => openXrefEntry(entry)),
    vscode.commands.registerCommand('clamps.xrefBack', () => xrefNavigationHistory.back()),
    vscode.commands.registerCommand('clamps.xrefForward', () => xrefNavigationHistory.forward()),
    vscode.commands.registerCommand('clamps.apropos', () => aproposCommand(() => client)),
    vscode.commands.registerCommand('clamps.breakOnSignals', () => breakOnSignalsCommand(() => client)),
    vscode.commands.registerCommand('clamps.openGui', () => openGui()),
    outputChannel
  );

  await enqueueLifecycle(() => startClamps(context, bridgePath));
  void incudineNodes?.refresh();
  void packageBrowser?.refresh();
  void classBrowser?.refresh();
  void threadBrowser?.refresh();
}

async function openGui(): Promise<void> {
  // The GUI web server (Hunchentoot) does NOT run on the Swank port but
  // on the port argument of clamps-start (default 54619). Configurable
  // via clamps.guiPort in case clamps-start is called with another port.
  const guiPort = vscode.workspace
    .getConfiguration('clamps')
    .get<number>('guiPort', 54619);
  const url = `http://127.0.0.1:${guiPort}/ats-explorer`;

  const choice = await vscode.window.showInformationMessage(
    `CLAMPS-GUI: ${url}`,
    'Open in browser'
  );
  if (choice === 'Open in browser') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function startClamps(context: vscode.ExtensionContext, bridgePath: string) {
  if (!processManager) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Starting CLAMPS …', cancellable: false },
    async () => {
      try {
        outputChannel.appendLine('Starting/checking the bootstrap process …');
        const session = await processManager!.ensureRunning();
        // Whether reused or freshly started — that is the difference
        // between the current code being loaded and testing against an
        // image from the day before yesterday.
        if (processManager!.lastStartNote) {
          outputChannel.appendLine(processManager!.lastStartNote);
        }
        outputChannel.appendLine(`Session ready on port ${session.port}.`);

        await startLanguageClient(bridgePath);
        rtStatus?.start();
        vscode.window.showInformationMessage(`CLAMPS is running (Swank port ${session.port}).`);

        // Open the REPL right away: it is the place where the work
        // happens, and having to fetch it from the command palette first
        // is a needless intermediate step.
        const openRepl =
          vscode.workspace.getConfiguration('clamps').get<boolean>('openReplOnStart', true);
        if (openRepl) {
          ClampsReplTerminal.show(() => client);
        }

        // Attach the debugger automatically unless switched off. That
        // way the Lisp debugger is there immediately, without having to
        // hook it in by hand every time — as close to Sly's behaviour as
        // VS Code's DAP model allows (a debug session must always exist
        // deliberately there; a debugger that springs up with no session
        // at all is not foreseen in VS Code).
        if (vscode.workspace.getConfiguration('clamps').get<boolean>('autoAttachDebugger', true)) {
          // A small delay so that the bridge builds its connection
          // first and the two Swank connections do not get in each
          // other's way.
          setTimeout(async () => {
            if (!vscode.debug.activeDebugSession) {
              await vscode.debug.startDebugging(undefined, {
                type: 'clamps', request: 'attach',
                name: 'CLAMPS: Attach Debugger',
                // Without this, VS Code opens the debug console when a
                // debug session starts and thereby pushes the REPL out of
                // the panel. After every start you landed on a console you
                // do not need and had to click "Terminal" first.
                internalConsoleOptions: 'neverOpen',
              });
            }
            // Additionally bring the REPL back to the front: attaching
            // activates the debug view, and "neverOpen" only prevents the
            // console from unfolding, not the switch of the panel.
            if (openRepl) {
              ClampsReplTerminal.show(() => client);
            }
          }, 800);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`ERROR: ${message}`);
        outputChannel.show();
        vscode.window.showErrorMessage(`Starting CLAMPS failed: ${message}`);
      }
    }
  );
}

async function startLanguageClient(bridgePath: string): Promise<void> {
  if (!processManager) return;

  // If a client is already running, do not start another one — otherwise
  // parallel bridge processes appear. A real restart goes exclusively
  // through clamps.restart (stop + start).
  if (client && client.state === State.Running) {
    return;
  }

  await stopLanguageClient();

  const sessionDir = path.dirname(processManager.getSessionFilePath());

  const serverOptions: ServerOptions = {
    command: 'sbcl',
    args: ['--script', bridgePath],
    options: {
      env: { ...process.env, CLAMPS_SESSION_DIR: sessionDir },
    },
  };

  const clientOptions: LanguageClientOptions = {
    // Both language IDs AND a file pattern. If a second Lisp extension
    // is installed (Alive, commonlisp), .lisp may be assigned to the ID
    // "commonlisp". The client then received no didOpen, and
    // definition/completion/signature help/hover were dead while the
    // REPL (which runs over commands) kept working.
    documentSelector: [
      { scheme: 'file', language: 'lisp' },
      { scheme: 'file', language: 'commonlisp' },
      { scheme: 'file', pattern: '**/*.{lisp,lsp,cl,asd}' },
    ],
    outputChannel,
    // VS Code's built-in auto-restart would spawn a NEW bridge process
    // on every server exit without tidying up the old one — which made
    // several bridge servers pile up, of which only the first found the
    // session as "ready" while the rest ran into the 60 s timeout. We
    // take over the life cycle entirely ourselves via the
    // start/stop/restart commands and suppress the automatic restart.
    errorHandler: {
      error: () => ({ action: ErrorAction.Continue }),
      closed: () => {
        // No automatic restart: that goes through clamps.restart. But
        // the client's standard message ("Server will not be restarted")
        // does not reveal what happened and what helps — and it happens
        // regularly, because the bridge ends as soon as the Lisp image is
        // gone.
        void vscode.window
          .showWarningMessage(
            'The CLAMPS bridge has ended — usually because the Lisp image is ' +
              'no longer running. Completion, go-to-definition, inspector and ' +
              'DSP display are therefore inactive.',
            'Restart CLAMPS'
          )
          .then(choice => {
            if (choice) void vscode.commands.executeCommand('clamps.restart');
          });
        return { action: CloseAction.DoNotRestart };
      },
    },
  };

  const nextClient = new LanguageClient(
    'clamps',
    'CLAMPS Language Server',
    serverOptions,
    clientOptions
  );

  client = nextClient;
  clientStartPromise = nextClient.start();

  try {
    await clientStartPromise;
  } catch (error) {
    if (client === nextClient) {
      client = undefined;
    }
    throw error;
  } finally {
    if (client === nextClient) {
      clientStartPromise = undefined;
    }
  }
}

async function stopLanguageClient(): Promise<void> {
  const currentClient = client;
  const currentStart = clientStartPromise;

  if (!currentClient) return;

  // A LanguageClient cannot be stopped while it is still in `Starting`.
  // Wait until startup has either completed or failed before stopping it.
  if (currentClient.state === State.Starting && currentStart) {
    try {
      await currentStart;
    } catch {
      // A failed start normally leaves the client stopped already.
    }
  }

  if (currentClient.state !== State.Stopped) {
    await currentClient.stop();
  }

  if (client === currentClient) {
    client = undefined;
    clientStartPromise = undefined;
  }
}

async function stopClamps(): Promise<void> {
  // Stop the polling first: otherwise requests run against a client that
  // is being torn down.
  rtStatus?.stop();
  stickerPoller.stop();
  await stopLanguageClient();
  await processManager?.stop();
  outputChannel.appendLine('CLAMPS stopped.');
}

export async function deactivate(): Promise<void> {
  rtStatus?.stop();
  stickerPoller.dispose();
  // Deliberately do NOT kill the bootstrap process (SBCL/Incudine) along
  // with it — that one is meant to survive the editor. Only the
  // LanguageClient/bridge process is ended; the next session simply
  // starts it again.
  await stopLanguageClient();
}

/**
 * Passes a debugger value on to the existing inspector. The debug session
 * binds it to a fresh symbol and returns its name; here all that remains
 * is to call clamps.inspect with that name.
 */
async function inspectFromDebugger(request: string, args: any): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== 'clamps') {
    vscode.window.showErrorMessage('No active CLAMPS debug session.');
    return;
  }
  try {
    const prepared = await session.customRequest(request, args);
    if (!prepared?.expression) return;
    await vscode.commands.executeCommand(
      'clamps.inspect',
      prepared.expression,
      prepared.package
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Inspection failed: ${String(error)}`);
  }
}

/** Restart selection as a quick pick. */
async function chooseRestart(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== 'clamps') {
    vscode.window.showErrorMessage('No active CLAMPS debug session.');
    return;
  }
  const data = await session.customRequest('clamps/restarts', {});
  const restarts: any[] = data?.restarts ?? [];
  if (restarts.length === 0) {
    vscode.window.showInformationMessage('No active Lisp debugger at the moment.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    restarts.map(r => ({
      label: `${r.index}: [${r.name}]`,
      description: r.description,
      index: r.index,
    })),
    { placeHolder: 'Choose a restart' }
  );
  if (picked) await session.customRequest('clamps/invokeRestart', { index: picked.index });
}

/**
 * Describes a paren or string problem, or undefined when everything is
 * balanced.
 *
 * Why check before evaluating: unbalanced code otherwise arrives in the
 * image, where the reader runs off the end of the file. With a bridge
 * waiting for an answer, that can take the connection with it — exactly
 * the sort of failure that is hard to attribute, because the cause is in
 * the editor and the effect in the process.
 */
function balanceProblem(text: string): string | undefined {
  const st = readState(text);
  if (st.inString) return 'A string is not closed (missing ").';
  if (st.inBlockComment) return 'A block comment is not closed (missing |#).';
  if (st.tooManyClosers) return 'There are more closing than opening parens.';
  if (st.depth > 0) {
    return `${st.depth} paren${st.depth === 1 ? '' : 's'} left unclosed.`;
  }
  return undefined;
}

/**
 * Inserts as many closing parens at the cursor as are open — modelled on
 * Paredit's sly-close-all-parens. It counts from the start of the file to
 * the cursor, which presupposes that the text before it is balanced; with
 * unbalanced preceding text this is reported instead of closing wrongly
 * in silence.
 */
/**
 * Evaluates CODE, but checks the parens beforehand. On a problem it asks
 * instead of sending blindly: unbalanced code makes the reader in the
 * image run off the end of the file, and that has already taken the
 * bridge down once.
 */
async function evaluateChecked(
  getClient: () => LanguageClient | undefined,
  code: string
): Promise<void> {
  const problem = balanceProblem(code);
  if (problem) {
    const choice = await vscode.window.showWarningMessage(
      `CLAMPS: ${problem} Trotzdem auswerten?`,
      { modal: true },
      'Trotzdem auswerten'
    );
    if (choice !== 'Trotzdem auswerten') return;
  }
  await ClampsReplTerminal.evaluate(getClient, code);
}

async function closeParens(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const upToCursor = editor.document.getText(
    new vscode.Range(new vscode.Position(0, 0), editor.selection.active)
  );
  const st = readState(upToCursor);
  if (st.inString) {
    vscode.window.showWarningMessage(
      'The cursor is inside a string; parens are not closed there.'
    );
    return;
  }
  if (st.tooManyClosers) {
    vscode.window.showWarningMessage(
      'Before the cursor there are more closing than opening parens.'
    );
    return;
  }
  if (st.depth <= 0) {
    vscode.window.showInformationMessage('No open parens.');
    return;
  }
  const closers = ')'.repeat(st.depth);
  await editor.edit(b => b.insert(editor.selection.active, closers));
}
