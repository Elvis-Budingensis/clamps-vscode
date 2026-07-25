import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
interface CompilerNote { message:string; severity:string; line:number; character:number; endLine?:number; endCharacter?:number; }
interface CompilerResult { notes:CompilerNote[]; success:boolean; duration:number; error?:string; }
export class CompilerDiagnostics implements vscode.Disposable {
  private readonly collection=vscode.languages.createDiagnosticCollection('clamps');
  constructor(private readonly getClient:()=>LanguageClient|undefined){}
  dispose(){this.collection.dispose();}
  clear(uri:vscode.Uri){this.collection.delete(uri);}
  async update(document:vscode.TextDocument):Promise<void>{
    if(document.languageId!=='lisp'||document.uri.scheme!=='file')return;
    const client=this.getClient(); if(!client||client.state!==State.Running)return;
    try{
      const r=await client.sendRequest<CompilerResult>('clamps/compilerNotes',{uri:document.uri.toString(),file:document.uri.fsPath,text:document.getText()});
      const diagnostics=(r.notes??[]).map(n=>{
        const line=Math.max(0,Math.min(document.lineCount-1,n.line??0));
        const max=document.lineAt(line).text.length;
        const ch=Math.max(0,Math.min(max,n.character??0));
        const range=new vscode.Range(line,ch,Math.max(line,n.endLine??line),Math.max(ch,n.endCharacter??Math.min(max,ch+1)));
        const sev=String(n.severity).toLowerCase();
        const severity=sev.includes('error')?vscode.DiagnosticSeverity.Error:sev.includes('warning')?vscode.DiagnosticSeverity.Warning:sev.includes('note')?vscode.DiagnosticSeverity.Information:vscode.DiagnosticSeverity.Hint;
        const d=new vscode.Diagnostic(range,n.message,severity); d.source='CLAMPS / SBCL'; return d;
      });
      this.collection.set(document.uri,diagnostics);
    }catch(e){ this.collection.set(document.uri,[new vscode.Diagnostic(new vscode.Range(0,0,0,1),`Compiler-Diagnostics fehlgeschlagen: ${String(e)}`,vscode.DiagnosticSeverity.Information)]); }
  }
}
