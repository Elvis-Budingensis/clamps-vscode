import * as vscode from 'vscode';

export interface FormRange { start: number; end: number; parentStart?: number; parentEnd?: number; }

/** Scanner shared by Paredit-like commands. It deliberately never evaluates code. */
export function formRanges(text: string): FormRange[] {
  const stack: number[] = [];
  const out: FormRange[] = [];
  let string = false, block = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (string) {
      if (c === '\\') i++;
      else if (c === '"') string = false;
      continue;
    }
    if (block) {
      if (c === '#' && text[i + 1] === '|') { block++; i++; }
      else if (c === '|' && text[i + 1] === '#') { block--; i++; }
      continue;
    }
    if (c === ';') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    if (c === '#' && text[i + 1] === '|') { block++; i++; continue; }
    if (c === '#' && text[i + 1] === '\\') { i += 2; while (i + 1 < text.length && /[A-Za-z0-9_-]/.test(text[i + 1])) i++; continue; }
    if (c === '"') { string = true; continue; }
    if (c === '(') stack.push(i);
    else if (c === ')' && stack.length) {
      const start = stack.pop()!;
      out.push({ start, end: i + 1, parentStart: stack[stack.length - 1] });
    }
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const r of out) {
    const p = out.filter(x => x.start < r.start && x.end > r.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
    if (p) { r.parentStart = p.start; r.parentEnd = p.end; }
  }
  return out;
}

function active(): { editor: vscode.TextEditor; text: string; offset: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  return { editor, text: editor.document.getText(), offset: editor.document.offsetAt(editor.selection.active) };
}

function containing(ranges: FormRange[], offset: number): FormRange | undefined {
  return ranges.filter(r => r.start <= offset && r.end >= offset).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
}

export function registerStructuralEditing(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('clamps.selectSexp', () => {
    const a = active(); if (!a) return;
    const r = containing(formRanges(a.text), a.offset); if (!r) return;
    a.editor.selection = new vscode.Selection(a.editor.document.positionAt(r.start), a.editor.document.positionAt(r.end));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.selectParentSexp', () => {
    const a = active(); if (!a) return;
    const r = containing(formRanges(a.text), a.offset); if (!r?.parentStart || !r.parentEnd) return;
    a.editor.selection = new vscode.Selection(a.editor.document.positionAt(r.parentStart), a.editor.document.positionAt(r.parentEnd));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.forwardSexp', () => move(true)));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.backwardSexp', () => move(false)));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.wrapSexp', async () => {
    const a = active(); if (!a) return;
    const r = containing(formRanges(a.text), a.offset); if (!r) return;
    await a.editor.edit(e => { e.insert(a.editor.document.positionAt(r.start), '('); e.insert(a.editor.document.positionAt(r.end), ')'); });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.raiseSexp', async () => {
    const a = active(); if (!a) return;
    const r = containing(formRanges(a.text), a.offset); if (!r || r.parentStart === undefined || r.parentEnd === undefined) return;
    const value = a.text.slice(r.start, r.end);
    await a.editor.edit(e => e.replace(new vscode.Range(a.editor.document.positionAt(r.parentStart!), a.editor.document.positionAt(r.parentEnd!)), value));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.spliceSexp', async () => {
    const a = active(); if (!a) return;
    const r = containing(formRanges(a.text), a.offset); if (!r) return;
    await a.editor.edit(e => { e.delete(new vscode.Range(a.editor.document.positionAt(r.end - 1), a.editor.document.positionAt(r.end))); e.delete(new vscode.Range(a.editor.document.positionAt(r.start), a.editor.document.positionAt(r.start + 1))); });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.slurpForward', () => slurpBarf(true, true)));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.barfForward', () => slurpBarf(false, true)));
}

function move(forward: boolean): void {
  const a = active(); if (!a) return;
  const ranges = formRanges(a.text);
  const candidate = forward
    ? ranges.filter(r => r.start > a.offset).sort((x,y)=>x.start-y.start)[0]
    : ranges.filter(r => r.end < a.offset).sort((x,y)=>y.end-x.end)[0];
  if (candidate) a.editor.selection = new vscode.Selection(a.editor.document.positionAt(forward ? candidate.start : candidate.end), a.editor.document.positionAt(forward ? candidate.start : candidate.end));
}

async function slurpBarf(slurp: boolean, forward: boolean): Promise<void> {
  const a = active(); if (!a || !forward) return;
  const ranges = formRanges(a.text);
  const r = containing(ranges, a.offset); if (!r) return;
  if (slurp) {
    const next = ranges.filter(x => x.start >= r.end && !(x.start >= r.start && x.end <= r.end)).sort((x,y)=>x.start-y.start)[0];
    if (!next) return;
    await a.editor.edit(e => { e.delete(new vscode.Range(a.editor.document.positionAt(r.end - 1), a.editor.document.positionAt(r.end))); e.insert(a.editor.document.positionAt(next.end), ')'); });
  } else {
    const children = ranges.filter(x => x.start > r.start && x.end < r.end && x.parentStart === r.start).sort((x,y)=>x.start-y.start);
    const last = children[children.length - 1]; if (!last) return;
    await a.editor.edit(e => { e.delete(new vscode.Range(a.editor.document.positionAt(r.end - 1), a.editor.document.positionAt(r.end))); e.insert(a.editor.document.positionAt(last.start), ')'); });
  }
}
