// test/vscode-stub.js
//
// Hängt sich in den Modul-Loader und liefert Attrappen für 'vscode' und
// 'vscode-languageclient/node'. Damit lassen sich Module, die aus VS
// Code nur Kleinigkeiten brauchen (EventEmitter, Konfiguration), mit
// nacktem node testen.
//
// Muss VOR dem ersten require aus out/ geladen werden.

const Module = require('module');

class Emitter {
  constructor() { this.handlers = []; }
  get event() { return h => { this.handlers.push(h); return { dispose() {} }; }; }
  fire(x) { for (const h of this.handlers) h(x); }
  dispose() { this.handlers = []; }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const vscodeStub = {
  EventEmitter: Emitter,
  TreeItem,
  ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
    openTextDocument: async () => ({}),
  },
  window: {
    showInputBox: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showTextDocument: async () => ({}),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  debug: {},
};

const languageClientStub = {
  LanguageClient: class {},
  State: { Stopped: 1, Starting: 3, Running: 2 },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  if (request === 'vscode-languageclient/node') return languageClientStub;
  return origLoad.call(this, request, ...rest);
};

module.exports = { vscodeStub, languageClientStub, Emitter };
