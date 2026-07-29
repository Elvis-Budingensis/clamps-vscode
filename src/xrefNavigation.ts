import * as vscode from 'vscode';

interface Location {
  uri: vscode.Uri;
  position: vscode.Position;
}

class XrefNavigationHistory {
  private backStack: Location[] = [];
  private forwardStack: Location[] = [];
  private navigating = false;

  captureCurrent(): void {
    if (this.navigating) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const current = { uri: editor.document.uri, position: editor.selection.active };
    const previous = this.backStack[this.backStack.length - 1];
    if (!previous || previous.uri.toString() !== current.uri.toString()
        || !previous.position.isEqual(current.position)) {
      this.backStack.push(current);
      if (this.backStack.length > 200) this.backStack.shift();
    }
    this.forwardStack = [];
  }

  private async current(): Promise<Location | undefined> {
    const editor = vscode.window.activeTextEditor;
    return editor ? { uri: editor.document.uri, position: editor.selection.active } : undefined;
  }

  private async open(location: Location): Promise<void> {
    this.navigating = true;
    try {
      const doc = await vscode.workspace.openTextDocument(location.uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const position = doc.validatePosition(location.position);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } finally {
      this.navigating = false;
    }
  }

  async back(): Promise<void> {
    const target = this.backStack.pop();
    if (!target) {
      void vscode.window.showInformationMessage('CLAMPS XREF: no earlier jump location.');
      return;
    }
    const current = await this.current();
    if (current) this.forwardStack.push(current);
    await this.open(target);
  }

  async forward(): Promise<void> {
    const target = this.forwardStack.pop();
    if (!target) {
      void vscode.window.showInformationMessage('CLAMPS XREF: no later jump location.');
      return;
    }
    const current = await this.current();
    if (current) this.backStack.push(current);
    await this.open(target);
  }
}

export const xrefNavigationHistory = new XrefNavigationHistory();
