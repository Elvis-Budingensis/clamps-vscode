import * as vscode from 'vscode';

export interface FormRange {
  start: number;
  end: number;
  parentStart?: number;
  parentEnd?: number;
  /**
   * Parenthesised expression (true) or atom (false).
   *
   * Atoms MUST be counted: in (mapcar #'car list) there is not a single
   * parenthesised subexpression, and without atoms forwardSexp,
   * backwardSexp, slurp and barf simply did nothing there. Conversely
   * spliceSexp may only act on lists — on an atom it would delete its
   * first and last character.
   */
  list: boolean;
}

/** Scanner shared by Paredit-like commands. It deliberately never evaluates code. */
export function formRanges(text: string): FormRange[] {
  const stack: number[] = [];
  const out: FormRange[] = [];
  let string = false, block = 0, stringStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (string) {
      if (c === '\\') i++;
      else if (c === '"') {
        // The string is an atom like any other: slurp and forwardSexp
        // must be able to step over it.
        string = false;
        out.push({ start: stringStart, end: i + 1, list: false });
      }
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
    if (c === '"') { string = true; stringStart = i; continue; }
    if (c === '(') { stack.push(i); continue; }
    if (c === ')') {
      if (stack.length) {
        const start = stack.pop()!;
        out.push({ start, end: i + 1, list: true });
      }
      continue;
    }
    // Atom: anything that is not a separator. Leading reader macros
    // (#', ', `, ,, ,@) belong to the atom, otherwise #'car falls apart
    // into two pieces and slurp drags half of it along.
    if (!/[\s()]/.test(c)) {
      const start = i;
      while (i < text.length && !/[\s()";]/.test(text[i])) i++;
      if (i > start) out.push({ start, end: i, list: false });
      i--;
    }
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const r of out) {
    const p = out
      .filter(x => x.list && x.start < r.start && x.end > r.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (p) { r.parentStart = p.start; r.parentEnd = p.end; }
  }
  return out;
}

function active(): { editor: vscode.TextEditor; text: string; offset: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  return { editor, text: editor.document.getText(), offset: editor.document.offsetAt(editor.selection.active) };
}

export function containing(ranges: FormRange[], offset: number): FormRange | undefined {
  return ranges.filter(r => r.start <= offset && r.end >= offset).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
}

/** The smallest PARENTHESISED FORM around OFFSET. For slurp, barf and splice. */
export function containingList(ranges: FormRange[], offset: number): FormRange | undefined {
  return ranges.filter(r => r.list && r.start <= offset && r.end >= offset)
    .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
}

/** Neighbouring form behind the paren of R — target of slurpForward. */
export function slurpTarget(ranges: FormRange[], r: FormRange): FormRange | undefined {
  return ranges
    .filter(x => x.start >= r.end && x.parentStart === r.parentStart)
    .sort((x, y) => x.start - y.start)[0];
}

/** Last direct child of R — target of barfForward. */
export function barfTarget(ranges: FormRange[], r: FormRange): FormRange | undefined {
  const children = ranges
    .filter(x => x.parentStart === r.start)
    .sort((x, y) => x.start - y.start);
  return children[children.length - 1];
}

export function registerStructuralEditing(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('clamps.selectSexp', () => {
    const a = active(); if (!a) return;
    const r = containing(formRanges(a.text), a.offset); if (!r) return;
    a.editor.selection = new vscode.Selection(a.editor.document.positionAt(r.start), a.editor.document.positionAt(r.end));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.selectParentSexp', () => {
    const a = active(); if (!a) return;
    // parentStart === 0 is falsy: the first form of every file starts at
    // offset 0, and !r.parentStart aborted there.
    const r = containing(formRanges(a.text), a.offset);
    if (!r || r.parentStart === undefined || r.parentEnd === undefined) return;
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
    // Lists only: on an atom, splice would delete the first and last
    // character of the name.
    const r = containingList(formRanges(a.text), a.offset); if (!r) return;
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
  const r = containingList(ranges, a.offset); if (!r) return;
  if (slurp) {
    const next = slurpTarget(ranges, r);
    if (!next) return;
    await a.editor.edit(e => { e.delete(new vscode.Range(a.editor.document.positionAt(r.end - 1), a.editor.document.positionAt(r.end))); e.insert(a.editor.document.positionAt(next.end), ')'); });
  } else {
    const last = barfTarget(ranges, r); if (!last) return;
    await a.editor.edit(e => { e.delete(new vscode.Range(a.editor.document.positionAt(r.end - 1), a.editor.document.positionAt(r.end))); e.insert(a.editor.document.positionAt(last.start), ')'); });
  }
}
