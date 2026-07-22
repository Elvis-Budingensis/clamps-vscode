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
import { macroexpandCommand, topLevelFormAt, sexpBeforePoint } from './macroexpand';
import { disassembleCommand } from './disassemble';
import { inspectCommand } from './inspector';

let client: LanguageClient | undefined;
let processManager: ClampsProcessManager | undefined;
let outputChannel: vscode.OutputChannel;
let clientStartPromise: Promise<void> | undefined;
let lifecycleQueue: Promise<void> = Promise.resolve();

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
    vscode.commands.registerCommand('clamps.inspect', () =>
      inspectCommand(() => client)
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
  await stopLanguageClient();
  await processManager?.stop();
  outputChannel.appendLine('CLAMPS gestoppt.');
}

export async function deactivate(): Promise<void> {
  // Bewusst NICHT den Bootstrap-Prozess (SBCL/Incudine) mitkillen —
  // der soll den Editor überleben. Nur der LanguageClient/Bridge-Prozess
  // wird beendet, den startet die nächste Session einfach neu.
  await stopLanguageClient();
}
