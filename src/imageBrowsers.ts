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
 * Übersetzt einen Fehler aus sendRequest in etwas, das im Baum lesbar ist.
 *
 * Stirbt das Image, antwortet der LanguageClient mit "Pending response
 * rejected since connection got disposed" — eine Meldung über sein
 * eigenes Innenleben, die in drei Ansichten gleichzeitig stand und
 * nichts darüber sagte, was zu tun ist. Der Absturzgrund steht im
 * Protokoll des SBCL-Prozesses; hierhin gehört der Hinweis darauf.
 *
 * Reine Funktion, damit sie ohne laufende Extension geprüft werden kann.
 */
export function describeBrowserError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/connection got disposed|connection is disposed|Pending response rejected/i.test(msg)) {
    return 'Verbindung zu CLAMPS abgebrochen — vermutlich ist das Image gestorben. ' +
           'Ursache: „CLAMPS: Protokoll öffnen“. Danach „CLAMPS: Restart“.';
  }
  if (/Client is not running|connection to server is (erroring|closed)/i.test(msg)) {
    return 'CLAMPS läuft nicht. „CLAMPS: Start“ — und bei einem Fehlstart ' +
           '„CLAMPS: Protokoll öffnen“.';
  }
  return msg;
}

export class LispBrowserProvider implements vscode.TreeDataProvider<BrowserEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<BrowserEntry | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private entries: BrowserEntry[] = [];
  private message = 'Noch nicht geladen.';
  private loading = false;
  constructor(private readonly method: string, private readonly getClient: () => LanguageClient | undefined) {}
  dispose(): void { this.changed.dispose(); }
  async refresh(): Promise<void> {
    if (this.loading) return;
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.entries=[]; this.message='CLAMPS ist nicht verbunden.'; this.changed.fire(); return;
    }
    this.loading=true;
    try {
      const r=await client.sendRequest<BrowserResult>(this.method,{});
      this.entries=Array.isArray(r.entries)?r.entries:[];
      this.message=r.available ? (this.entries.length?'':'Keine Einträge.') : (r.error ?? 'Nicht verfügbar.');
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
