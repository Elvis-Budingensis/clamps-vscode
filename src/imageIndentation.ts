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
    // Auf Top-Level gibt es nichts einzurücken.
    if(!top) return [];

    const spaces=this.indentColumn(top,trimmed);
    const actual=current.text.length-trimmed.length;
    if(actual===spaces) return [];
    return [vscode.TextEdit.replace(new vscode.Range(new vscode.Position(line,0),new vscode.Position(line,actual)),' '.repeat(spaces))];
  }

  /**
   * Spalte für eine Fortsetzungszeile innerhalb der Form TOP.
   *
   * Hier lag der Fehler: die Regel wurde nachgeschlagen und dann
   * verworfen — `top.col + (rule === 0 ? 2 : 2)`, beide Zweige 2. Damit
   * hatte die gesamte rules-Map keine Wirkung, weder die Defaults noch
   * die per clamps/indentationRules aus dem laufenden Image geholten
   * Regeln. Jede Zeile landete auf top.col + 2, und ein Aufruf sah aus
   * wie ein Makro-Körper.
   *
   * Die Unterscheidung, auf die es in Lisp ankommt:
   *
   *   (defun foo (x)        Makro/Sonderform: Körper 2 ab der Klammer
   *     body)
   *
   *   (mapcar #'car         Funktionsaufruf: unter dem ERSTEN Argument
   *           rest)         ausrichten
   */
  private indentColumn(top:{col:number;op?:string},trimmed:string):number {
    // Schließende Klammer auf eigener Zeile gehört auf die Spalte der
    // Form, die sie schließt — nicht auf Körper minus 2, was beim
    // ausgerichteten Fall daneben lag.
    if(trimmed.startsWith(')')) return top.col;

    // Kein Operator: `(` am Zeilenende oder direkt eine Liste, etwa in
    // einer let-Bindungsliste. Ein Zeichen ab der Klammer.
    if(!top.op) return top.col+1;

    const rule=this.rules.get(top.op);
    // Makro oder Sonderform mit bekannter Regel: Körper zwei Zeichen ab
    // der öffnenden Klammer. Die Zahl aus der Regel beschreibt, wie
    // viele Argumente ausgezeichnet sind; das wertet diese Fassung
    // NICHT aus (siehe Kommentar unten).
    if(rule!==undefined) return top.col+2;

    // Funktionsaufruf: unter dem ersten Argument ausrichten.
    // '(' + Operatorname + ' '
    return top.col+1+top.op.length+1;
  }
}
