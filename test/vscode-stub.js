// test/vscode-stub.js
//
// Hooks into the module loader and supplies stand-ins for 'vscode' and
// 'vscode-languageclient/node'. That makes it possible to test modules
// that need only small things from VS Code (EventEmitter, configuration)
// with bare node.
//
// Has to be loaded BEFORE the first require from out/.

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
  // Only as much as the jump-target arithmetic needs.
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  // Range and TextEdit are needed by the formatting providers.
  // Deliberately minimal: only what the indentation arithmetic produces
  // and reads.
  Range: class {
    constructor(start, end) { this.start = start; this.end = end; }
  },
  TextEdit: {
    replace: (range, newText) => ({ range, newText }),
  },
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
