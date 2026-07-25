import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface NodeControl {
  name: string;
  value: string;
}

interface IncudineNode {
  id: number;
  parent: number | null;
  name: string;
  kind: 'group' | 'dsp';
  paused: boolean;
  done: boolean;
  uptime: string;
  controls: NodeControl[];
}

interface NodeTreeResult {
  available: boolean;
  error?: string;
  nodes: IncudineNode[];
}

type Entry =
  | { type: 'node'; node: IncudineNode }
  | { type: 'control'; node: IncudineNode; control: NodeControl };

export class IncudineNodeProvider implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Entry | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private nodes: IncudineNode[] = [];
  private error = '';
  /**
   * Hinweis aus dem Image, etwa welche Incudine-Accessoren in dieser
   * Version fehlen. Getrennt vom Fehler geführt: der Baum kann trotzdem
   * brauchbar sein, nur unvollständig — und ein flacher Baum ohne
   * Erklärung sieht wie ein leeres Setup aus.
   */
  private notice = '';
  private loading = false;

  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  dispose(): void {
    this.changed.dispose();
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.nodes = [];
      this.error = 'CLAMPS ist nicht verbunden.';
      this.changed.fire();
      return;
    }
    this.loading = true;
    try {
      const result = await client.sendRequest<NodeTreeResult>('clamps/incudineNodes', {});
      this.nodes = Array.isArray(result.nodes) ? result.nodes : [];
      if (result.available) {
        this.error = '';
        this.notice = result.error ?? '';
      } else {
        this.error = result.error ?? 'Incudine ist nicht geladen.';
        this.notice = '';
      }
    } catch (e) {
      this.nodes = [];
      this.error = String(e);
      this.notice = '';
    } finally {
      this.loading = false;
      this.changed.fire();
    }
  }

  getTreeItem(entry: Entry): vscode.TreeItem {
    if (entry.type === 'control') {
      const item = new vscode.TreeItem(
        `${entry.control.name} = ${entry.control.value}`,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = 'incudineControl';
      item.iconPath = new vscode.ThemeIcon('symbol-field');
      item.tooltip = `Control von Node ${entry.node.id}`;
      return item;
    }

    const n = entry.node;
    const hasChildren = this.nodes.some(x => x.parent === n.id) || n.controls.length > 0;
    // Wurzelgruppen aufgeklappt: sonst sieht man nach dem Öffnen nur
    // "group [0]" und muss erst klicken, um überhaupt etwas zu sehen.
    // Tiefere Ebenen bleiben zu, damit grosse Setups nicht explodieren.
    const isRoot = n.parent === null;
    const state = hasChildren
      ? isRoot
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(
      `${n.name || (n.kind === 'group' ? 'group' : 'node')} [${n.id}]`,
      state
    );
    item.contextValue = 'incudineNode';
    item.description = [n.paused ? 'paused' : '', n.done ? 'done' : '', n.uptime ? n.uptime : '']
      .filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      n.kind === 'group' ? 'list-tree' : n.paused ? 'debug-pause' : 'pulse'
    );
    item.tooltip = `${n.kind === 'group' ? 'Gruppe' : 'DSP-Node'} ${n.id}\nParent: ${n.parent ?? '—'}${n.uptime ? `\nUptime: ${n.uptime}` : ''}`;
    item.command = {
      command: 'clamps.incudineInspectNode',
      title: 'Node inspizieren',
      arguments: [n.id],
    };
    return item;
  }

  /** Platzhalterzeile für Meldungen; id < 0 markiert sie als nicht klickbar. */
  private message(text: string): Entry {
    return {
      type: 'node',
      node: {
        id: -1, parent: null, name: text, kind: 'group', paused: false,
        done: false, uptime: '', controls: [],
      },
    };
  }

  getChildren(entry?: Entry): Entry[] {
    if (!entry && this.error && this.nodes.length === 0) {
      return [this.message(this.error)];
    }
    if (!entry && this.nodes.length === 0) {
      // Kein Fehler, aber auch keine Nodes: das ist der Normalfall bei
      // gestopptem DSP und darf nicht wie ein Defekt aussehen.
      return [this.message('Keine Nodes — läuft der Realtime-Server? (rt-start)')];
    }
    if (!entry) {
      const ids = new Set(this.nodes.map(n => n.id));
      const roots: Entry[] = this.nodes
        .filter(n => n.parent === null || !ids.has(n.parent))
        .map(node => ({ type: 'node' as const, node }));
      // Hinweis unten anhängen, damit man fehlende Accessoren sieht,
      // ohne dass sie den Baum verdecken.
      if (this.notice) roots.push(this.message(this.notice));
      return roots;
    }
    if (entry.type === 'control' || entry.node.id < 0) return [];
    const children: Entry[] = this.nodes
      .filter(n => n.parent === entry.node.id)
      .map(node => ({ type: 'node' as const, node }));
    children.push(...entry.node.controls.map(control => ({
      type: 'control' as const, node: entry.node, control,
    })));
    return children;
  }
}
