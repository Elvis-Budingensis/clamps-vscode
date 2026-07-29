import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface Rule { name: string; body: number; }
const defaults = new Map<string, number>([
  ['defun',2],['defmacro',2],['defmethod',2],['lambda',1],['let',1],['let*',1],
  ['labels',1],['flet',1],['macrolet',1],['handler-case',1],['unwind-protect',1],
  ['when',1],['unless',1],['dotimes',1],['dolist',1],['loop',0],['progn',0],
  ['defsynth',2],['define-vug',2],['defvug',2]
]);

export class ImageIndentationProvider implements vscode.OnTypeFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
  private rules = new Map(defaults);
  private refreshed = 0;
  constructor(private getClient: () => LanguageClient | undefined) {}
  async refresh(): Promise<void> {
    const c=this.getClient(); if(!c || c.state!==State.Running) return;
    try { const r=await c.sendRequest<{rules:Rule[]}>('clamps/indentationRules',{}); for(const x of r.rules??[]) this.rules.set(x.name.toLowerCase(),x.body); this.refreshed=Date.now(); } catch { /* fallback stays useful */ }
  }
  async provideOnTypeFormattingEdits(doc:vscode.TextDocument,pos:vscode.Position):Promise<vscode.TextEdit[]> { if(Date.now()-this.refreshed>30000) await this.refresh(); return this.lineEdit(doc,pos.line); }
  async provideDocumentRangeFormattingEdits(doc:vscode.TextDocument,range:vscode.Range):Promise<vscode.TextEdit[]> { if(Date.now()-this.refreshed>30000) await this.refresh(); const out:vscode.TextEdit[]=[]; for(let l=range.start.line;l<=range.end.line;l++) out.push(...this.lineEdit(doc,l)); return out; }
  private lineEdit(doc:vscode.TextDocument,line:number):vscode.TextEdit[] {
    if(line<0 || line>=doc.lineCount) return [];
    const current=doc.lineAt(line), trimmed=current.text.trimStart(); if(!trimmed) return [];
    const before=doc.getText(new vscode.Range(new vscode.Position(0,0),new vscode.Position(line,0)));
    const stack:{col:number;op?:string}[]=[]; let str=false;
    for(const rawLine of before.split('\n')) { for(let i=0;i<rawLine.length;i++){ const c=rawLine[i]; if(str){if(c==='\\')i++;else if(c==='"')str=false;continue;} if(c===';')break;if(c==='"'){str=true;continue;}if(c==='('){const m=rawLine.slice(i+1).match(/^([^\s()]+)/);stack.push({col:i,op:m?.[1]?.toLowerCase()});}else if(c===')')stack.pop();} }

    const top=stack[stack.length-1];
    // At top level there is nothing to indent.
    if(!top) return [];

    const spaces=this.indentColumn(top,trimmed);
    const actual=current.text.length-trimmed.length;
    if(actual===spaces) return [];
    return [vscode.TextEdit.replace(new vscode.Range(new vscode.Position(line,0),new vscode.Position(line,actual)),' '.repeat(spaces))];
  }

  /**
   * Column for a continuation line inside the form TOP.
   *
   * This is where the bug sat: the rule was looked up and then thrown
   * away — `top.col + (rule === 0 ? 2 : 2)`, both branches 2. That left
   * the entire rules map without effect, neither the defaults nor the
   * rules fetched from the running image via clamps/indentationRules.
   * Every line ended up at top.col + 2, and a call looked like a macro
   * body.
   *
   * The distinction that matters in Lisp:
   *
   *   (defun foo (x)        macro/special form: body 2 from the paren
   *     body)
   *
   *   (mapcar #'car         function call: align under the FIRST
   *           rest)         argument
   */
  private indentColumn(top:{col:number;op?:string},trimmed:string):number {
    // A closing paren on its own line belongs at the column of the form
    // it closes — not at body minus 2, which was off in the aligned
    // case.
    if(trimmed.startsWith(')')) return top.col;

    // No operator: `(` at end of line, or a list directly, as in a let
    // binding list. One character from the paren.
    if(!top.op) return top.col+1;

    const rule=this.rules.get(top.op);
    // Macro or special form with a known rule: body two characters from
    // the opening paren. The number in the rule describes how many
    // arguments are distinguished; this version does NOT evaluate that
    // (see the comment below).
    if(rule!==undefined) return top.col+2;

    // A function call: align under the first argument.
    // '(' + Operatorname + ' '
    return top.col+1+top.op.length+1;
  }
}
