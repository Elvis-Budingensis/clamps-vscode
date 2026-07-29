import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

export interface BrowserEntry {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  inspect?: string;
  children?: BrowserEntry[];
}
interface BrowserResult { available: boolean; error?: string; entries: BrowserEntry[]; }

/**
 * Turns an error from sendRequest into something readable in the tree.
 *
 * When the image dies, the LanguageClient answers with "Pending response
 * rejected since connection got disposed" — a message about its own
 * internals that appeared in three views at once and said nothing about
 * what to do. The reason for the crash is in the SBCL process log; the
 * pointer to it belongs here.
 *
 * A pure function, so that it can be checked without a running extension.
 */
export function describeBrowserError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/connection got disposed|connection is disposed|Pending response rejected/i.test(msg)) {
    return 'Connection to CLAMPS lost — the image has probably died. ' +
           'For the cause run "CLAMPS: Open Log", then "CLAMPS: Restart".';
  }
  if (/Client is not running|connection to server is (erroring|closed)/i.test(msg)) {
    return 'CLAMPS is not running. "CLAMPS: Start" — and after a failed start ' +
           'run "CLAMPS: Open Log".';
  }
  return msg;
}

export class LispBrowserProvider implements vscode.TreeDataProvider<BrowserEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<BrowserEntry | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private entries: BrowserEntry[] = [];
  private message = 'Not loaded yet.';
  private loading = false;
  constructor(private readonly method: string, private readonly getClient: () => LanguageClient | undefined) {}
  dispose(): void { this.changed.dispose(); }
  async refresh(): Promise<void> {
    if (this.loading) return;
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.entries=[]; this.message='CLAMPS is not connected.'; this.changed.fire(); return;
    }
    this.loading=true;
    try {
      const r=await client.sendRequest<BrowserResult>(this.method,{});
      this.entries=Array.isArray(r.entries)?r.entries:[];
      this.message=r.available ? (this.entries.length?'':'No entries.') : (r.error ?? 'Not available.');
    } catch(e) { this.entries=[]; this.message=describeBrowserError(e); }
    finally { this.loading=false; this.changed.fire(); }
  }
  getTreeItem(e: BrowserEntry): vscode.TreeItem {
    const item=new vscode.TreeItem(e.label,(e.children?.length??0)>0?vscode.TreeItemCollapsibleState.Collapsed:vscode.TreeItemCollapsibleState.None);
    item.description=e.description; item.tooltip=e.tooltip??[e.label,e.description].filter(Boolean).join(' — ');
    item.iconPath=new vscode.ThemeIcon(e.icon??'symbol-misc');
    if(e.inspect){ item.contextValue='clampsInspectable'; item.command={command:'clamps.inspectBrowserItem',title:'Inspizieren',arguments:[e.inspect]}; }
    return item;
  }
  getChildren(e?: BrowserEntry): BrowserEntry[] {
    if(e) return e.children??[];
    return this.entries.length?this.entries:[{label:this.message,icon:'info'}];
  }
}
