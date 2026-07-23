// extension.ts
//
// Aktivierungspunkt der Extension. Ablauf beim Öffnen einer .lisp-Datei:
//   1. ClampsProcessManager sorgt dafür, dass bootstrap.lisp (SBCL +
//      CLAMPS + Swank) läuft oder startet es neu.
//   2. Sobald die Session "ready" ist, wird der LanguageClient gestartet,
//      der wiederum bridge-server.lisp als eigenen Prozess spawnt.
//   3. bridge-server.lisp verbindet sich selbst zum Swank-Port und
//      spricht LSP über stdio mit dem LanguageClient.

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
import { ClampsReplTerminal } from './replTerminal';
import { macroexpandCommand, topLevelFormAt, sexpBeforePoint, packageAt } from './macroexpand';
import { disassembleCommand, symbolAt } from './disassemble';
import { inspectCommand } from './inspector';
import { ClampsRtStatus } from './rtStatus';
import { ClampsDebugSession } from './debugSession';

let client: LanguageClient | undefined;
let processManager: ClampsProcessManager | undefined;
let outputChannel: vscode.OutputChannel;
let clientStartPromise: Promise<void> | undefined;
let lifecycleQueue: Promise<void> = Promise.resolve();
let rtStatus: ClampsRtStatus | undefined;

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
      'CLAMPS: Bitte zuerst einen Workspace-Ordner öffnen (Datei → Ordner öffnen).'
    );
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Beide Lisp-Skripte liegen in der Extension selbst, nicht im
  // Workspace des Users — context.asAbsolutePath zeigt in den
  // Installationsordner der Extension.
  const bootstrapPath = context.asAbsolutePath(path.join('lisp', 'bootstrap.lisp'));
  const bridgePath = context.asAbsolutePath(path.join('lisp', 'bridge-server.lisp'));

  processManager = new ClampsProcessManager(workspaceRoot, bootstrapPath);
  rtStatus = new ClampsRtStatus(() => client);
  context.subscriptions.push(rtStatus);

  // Debug-Adapter. Läuft "inline", also im selben Extension-Host-Prozess
  // — kein eigener Adapter-Prozess, und der Adapter kommt an
  // processManager heran, statt session.json ein zweites Mal zu lesen.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('clamps', {
      createDebugAdapterDescriptor() {
        const port = processManager?.getPort();
        if (!port) {
          vscode.window.showErrorMessage(
            'CLAMPS läuft nicht — erst „CLAMPS: Start" ausführen.'
          );
          return undefined;
        }
        return new vscode.DebugAdapterInlineImplementation(
          new ClampsDebugSession(port, workspaceRoot)
        );
      },
    }),
    // Attach ohne launch.json: die Konfiguration ist ohnehin leer, weil
    // Port und Wurzelverzeichnis aus dem Prozess-Manager kommen.
    vscode.debug.registerDebugConfigurationProvider('clamps', {
      provideDebugConfigurations() {
        return [{ type: 'clamps', request: 'attach', name: 'CLAMPS: Debugger anhängen' }];
      },
      resolveDebugConfiguration(_folder, config) {
        if (!config.type) {
          config.type = 'clamps';
          config.request = 'attach';
          config.name = 'CLAMPS: Debugger anhängen';
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
    vscode.commands.registerCommand('clamps.openRepl', () => ClampsReplTerminal.show(() => client)),
    vscode.commands.registerCommand('clamps.evalSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.document.getText(editor.selection) || editor.document.lineAt(editor.selection.active.line).text;
      await ClampsReplTerminal.evaluate(() => client, code);
    }),
    vscode.commands.registerCommand('clamps.evalFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await ClampsReplTerminal.evaluate(() => client, editor.document.getText());
    }),
    vscode.commands.registerCommand('clamps.evalLastExpression', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const form = sexpBeforePoint(editor.document, editor.selection.active);
      if (!form) {
        vscode.window.showWarningMessage(
          'CLAMPS: Keine S-Expression vor dem Cursor.'
        );
        return;
      }
      await ClampsReplTerminal.evaluate(() => client, form);
    }),
    vscode.commands.registerCommand('clamps.evalTopLevel', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const form = topLevelFormAt(editor.document, editor.selection.active);
      if (!form) {
        vscode.window.showWarningMessage(
          'CLAMPS: Keine Top-Level-Form am Cursor gefunden.'
        );
        return;
      }
      await ClampsReplTerminal.evaluate(() => client, form);
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
    // Optionale Argumente: der Debugger ruft diesen Befehl mit einem
    // bereits gebundenen Symbolnamen auf, statt über den aktiven Editor
    // zu gehen. Ohne Argumente bleibt das Verhalten unverändert.
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
        vscode.window.showWarningMessage('CLAMPS: Kein Symbol am Cursor.');
        return;
      }
      if (!client || client.state !== State.Running) {
        vscode.window.showErrorMessage('CLAMPS ist nicht verbunden.');
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
        vscode.window.showErrorMessage('CLAMPS ist nicht verbunden.');
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
        type: 'clamps', request: 'attach', name: 'CLAMPS: Debugger anhängen',
      })
    ),
    vscode.commands.registerCommand('clamps.debugRestarts', () => chooseRestart()),
    vscode.commands.registerCommand('clamps.debugAbortAll', async () => {
      const session = vscode.debug.activeDebugSession;
      if (!session || session.type !== 'clamps') {
        vscode.window.showErrorMessage('Keine aktive CLAMPS-Debug-Session.');
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
          'Dieser Wert hat keinen auswertbaren Lisp-Namen.'
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
    vscode.commands.registerCommand('clamps.openGui', () => openGui()),
    outputChannel
  );

  await enqueueLifecycle(() => startClamps(context, bridgePath));
}

async function openGui(): Promise<void> {
  // Der GUI-Webserver (Hunchentoot) läuft NICHT auf dem Swank-Port,
  // sondern auf dem port-Argument von clamps-start (Default 54619).
  // Konfigurierbar über clamps.guiPort, falls clamps-start mit anderem
  // Port aufgerufen wird.
  const guiPort = vscode.workspace
    .getConfiguration('clamps')
    .get<number>('guiPort', 54619);
  const url = `http://127.0.0.1:${guiPort}/ats-explorer`;

  const choice = await vscode.window.showInformationMessage(
    `CLAMPS-GUI: ${url}`,
    'Im Browser öffnen'
  );
  if (choice === 'Im Browser öffnen') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function startClamps(context: vscode.ExtensionContext, bridgePath: string) {
  if (!processManager) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CLAMPS startet …', cancellable: false },
    async () => {
      try {
        outputChannel.appendLine('Starte/prüfe Bootstrap-Prozess …');
        const session = await processManager!.ensureRunning();
        outputChannel.appendLine(`Session bereit auf Port ${session.port}.`);

        await startLanguageClient(bridgePath);
        rtStatus?.start();
        vscode.window.showInformationMessage(`CLAMPS läuft (Swank-Port ${session.port}).`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`FEHLER: ${message}`);
        outputChannel.show();
        vscode.window.showErrorMessage(`CLAMPS-Start fehlgeschlagen: ${message}`);
      }
    }
  );
}

async function startLanguageClient(bridgePath: string): Promise<void> {
  if (!processManager) return;

  // Läuft bereits ein Client, nicht erneut starten — sonst entstehen
  // parallele Bridge-Prozesse. Ein echter Neustart geht ausschließlich
  // über clamps.restart (stop + start).
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
    documentSelector: [{ scheme: 'file', language: 'lisp' }],
    outputChannel,
    // VS Codes eingebauter Auto-Restart würde bei jedem Server-Exit einen
    // NEUEN Bridge-Prozess spawnen, ohne den alten sauber abzuräumen —
    // dadurch stapelten sich mehrere Bridge-Server, von denen nur der
    // erste die Session als "ready" vorfand und die übrigen in den
    // 60s-Timeout liefen. Wir übernehmen den Lifecycle komplett selbst
    // über die start/stop/restart-Commands und unterbinden den
    // automatischen Neustart.
    errorHandler: {
      error: () => ({ action: ErrorAction.Continue }),
      closed: () => ({ action: CloseAction.DoNotRestart }),
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
  // Zuerst das Polling anhalten: sonst laufen Requests gegen einen
  // Client, der gerade abgebaut wird.
  rtStatus?.stop();
  await stopLanguageClient();
  await processManager?.stop();
  outputChannel.appendLine('CLAMPS gestoppt.');
}

export async function deactivate(): Promise<void> {
  rtStatus?.stop();
  // Bewusst NICHT den Bootstrap-Prozess (SBCL/Incudine) mitkillen —
  // der soll den Editor überleben. Nur der LanguageClient/Bridge-Prozess
  // wird beendet, den startet die nächste Session einfach neu.
  await stopLanguageClient();
}

/**
 * Reicht einen Debugger-Wert an den vorhandenen Inspector weiter. Die
 * Debug-Session bindet ihn an ein frisches Symbol und liefert dessen
 * Namen; hier wird nur noch clamps.inspect mit diesem Namen aufgerufen.
 */
async function inspectFromDebugger(request: string, args: any): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== 'clamps') {
    vscode.window.showErrorMessage('Keine aktive CLAMPS-Debug-Session.');
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
    vscode.window.showErrorMessage(`Inspektion fehlgeschlagen: ${String(error)}`);
  }
}

/** Restart-Auswahl als Schnellauswahl. */
async function chooseRestart(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== 'clamps') {
    vscode.window.showErrorMessage('Keine aktive CLAMPS-Debug-Session.');
    return;
  }
  const data = await session.customRequest('clamps/restarts', {});
  const restarts: any[] = data?.restarts ?? [];
  if (restarts.length === 0) {
    vscode.window.showInformationMessage('Zurzeit kein aktiver Lisp-Debugger.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    restarts.map(r => ({
      label: `${r.index}: [${r.name}]`,
      description: r.description,
      index: r.index,
    })),
    { placeHolder: 'Restart auswählen' }
  );
  if (picked) await session.customRequest('clamps/invokeRestart', { index: picked.index });
}
