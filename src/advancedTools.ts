import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt, sexpBeforePoint } from './macroexpand';

export function registerAdvancedTools(context:vscode.ExtensionContext,getClient:()=>LanguageClient|undefined):void {
  const ready=()=>{const c=getClient(); if(!c||c.state!==State.Running){void vscode.window.showErrorMessage('CLAMPS ist nicht verbunden.');return;}return c;};
  const asdf = async (op: 'load'|'compile'|'test') => {
    const c=ready(); if(!c)return; const system=await vscode.window.showInputBox({prompt:`ASDF-System ${op}`,placeHolder:'clamps'}); if(!system)return;
    const r=await c.sendRequest<{ok:boolean;message:string}>('clamps/asdfOperation',{operation:op,system}); (r.ok?vscode.window.showInformationMessage:vscode.window.showErrorMessage)(r.message);
  };
  context.subscriptions.push(vscode.commands.registerCommand('clamps.asdf.load',()=>asdf('load')));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.asdf.compile',()=>asdf('compile')));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.asdf.test',()=>asdf('test')));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.inspectPresentation',async(id?:number)=>{if(typeof id==='number') await vscode.commands.executeCommand('clamps.inspect',`(clamps-bridge-rpc:presentation-value ${id})`,'COMMON-LISP-USER');}));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.stickerWrap',async()=>{
    const e=vscode.window.activeTextEditor;if(!e)return; const form=sexpBeforePoint(e.document,e.selection.active);if(!form)return; const key=await vscode.window.showInputBox({prompt:'Sticker-Name',value:`${e.document.fileName}:${e.selection.active.line+1}`});if(!key)return;
    const range=e.selection.isEmpty?undefined:e.selection; if(range) await e.edit(b=>b.replace(range,`(clamps-bridge-rpc:sticker-record-for-repl ${JSON.stringify(key)} ${e.document.getText(range)})`)); else await vscode.env.clipboard.writeText(`(clamps-bridge-rpc:sticker-record-for-repl ${JSON.stringify(key)} ${form})`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.stickersShow',async()=>{const c=ready();if(!c)return;const r=await c.sendRequest<any>('clamps/stickers',{});const doc=await vscode.workspace.openTextDocument({language:'markdown',content:'# CLAMPS Stickers\n\n'+(r.entries??[]).map((x:any)=>`## ${x.key}\n`+(x.records??[]).map((y:any)=>`- [${y.id}] ${y.preview}`).join('\n')).join('\n\n')});await vscode.window.showTextDocument(doc,{preview:true});}));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.stickersClear',async()=>{const c=ready();if(c)await c.sendRequest('clamps/stickersClear',{});}));
  context.subscriptions.push(vscode.commands.registerCommand('clamps.macrostep',async()=>{
    const c=ready(),e=vscode.window.activeTextEditor;if(!c||!e)return;let code: string | undefined = sexpBeforePoint(e.document,e.selection.active);if(!code)return;const pkg=packageAt(e.document,e.selection.active);const steps: string[]=[code];for(let i=0;i<20;i++){const r: { output: string } = await c.sendRequest<{output:string}>('clamps/macroexpand',{code,package:pkg,full:false});const n: string=(r.output??'').trim();if(!n||n===code)break;steps.push(n);code=n;}const d=await vscode.workspace.openTextDocument({language:'lisp',content:steps.map((x,i)=>`; Step ${i}\n${x}`).join('\n\n')});await vscode.window.showTextDocument(d,{preview:false});
  }));
}
