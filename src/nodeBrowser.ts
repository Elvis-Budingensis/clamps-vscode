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
   * A hint from the image, for instance which Incudine accessors are
   * missing in this version. Kept separate from the error: the tree can
   * still be useful, just incomplete — and a flat tree without an
   * explanation looks like an empty setup.
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
      this.error = 'CLAMPS is not connected.';
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
        this.error = result.error ?? 'Incudine is not loaded.';
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
      item.tooltip = `Control of node ${entry.node.id}`;
      return item;
    }

    const n = entry.node;
    const hasChildren = this.nodes.some(x => x.parent === n.id) || n.controls.length > 0;
    // Root groups expanded: otherwise all you see after opening is
    // "group [0]" and you have to click before seeing anything at all.
    // Deeper levels stay closed so that large setups do not explode.
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

  /** Placeholder row for messages; id < 0 marks it as not clickable. */
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
      // No error, but no nodes either: that is the normal case with DSP
      // stopped and must not look like a defect.
      return [this.message('No nodes — is the realtime server running? (rt-start)')];
    }
    if (!entry) {
      const ids = new Set(this.nodes.map(n => n.id));
      const roots: Entry[] = this.nodes
        .filter(n => n.parent === null || !ids.has(n.parent))
        .map(node => ({ type: 'node' as const, node }));
      // Append the hint at the bottom so that missing accessors are
      // visible without obscuring the tree.
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
