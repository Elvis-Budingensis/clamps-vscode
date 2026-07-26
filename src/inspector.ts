import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt, topLevelFormAt } from './macroexpand';
import { symbolAt } from './disassemble';

interface InspectPart {
  label: string;
  /** Position in der Teileliste des Objekts — damit wird navigiert. */
  index: number;
  /** Kurze Druckdarstellung des Wertes — spart einen Klick. */
  preview?: string;
  /** Nicht gebundene Slots lassen sich nicht betreten. */
  navigable?: boolean;
  /** Schreibbar? Zahlen, Pathnames und Funktionszellen sind es nicht. */
  settable?: boolean;
  /**
   * Hat der Teil selbst Teile? Nur dann lohnt der Aufklapp-Pfeil.
   *
   * Das Image entscheidet das, weil nur es den Wert kennt. Fehlt das
   * Feld (null/undefined), ist die Frage unbeantwortet und wir zeigen den
   * Pfeil wie bisher an allem Gebundenen.
   */
  expandable?: boolean | null;
}
interface InspectMeta {
  key: string;
  value: string;
}
interface InspectResult {
  /** ID des Objekts in der Tabelle des Images. */
  id: number;
  /** object, struct, list, vector, array, hash-table, string, symbol,
   *  function, number, character, pathname, package, atom, error. */
  kind?: string;
  type: string;
  print: string;
  parts: InspectPart[];
  meta?: InspectMeta[];
  package: string;
}

/** Ein Schritt in der Navigationshistorie. */
interface Crumb {
  id: number;
  label: string;
}

/**
 * Maskiert Text für HTML — Elementinhalt UND Attributwert.
 *
 * Die Anführungszeichen sind nicht optional: die Labels kommen aus
 * prin1-to-string, ein String-Schlüssel einer Hashtable ist also immer
 * `"key"` mit Anführungszeichen, und genau dieser Text landet in
 * data-label="…" und title="…". Ohne Maskierung bricht das Attribut bei
 * jeder Hashtable mit String-Schlüsseln auf — und weil das Webview
 * Skripte ausführen darf und über die set-Nachricht beliebiges Lisp
 * auswerten lässt, wäre ein Label wie `" onmouseover=…` mehr als ein
 * Darstellungsfehler.
 */
const esc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Der Inspector navigiert über Objekt-IDs, nicht über Ausdrücke.
 *
 * Die frühere Fassung setzte für jeden Klick einen Zugriffs-Ausdruck
 * zusammen ("(slot-value (progn <expr>) 'x)") und liess ihn neu
 * auswerten. Das hatte drei Fehler: bei Seiteneffekten entstand ein
 * NEUES Objekt statt in das vorhandene zu navigieren, die Ausdrücke
 * wuchsen mit jeder Ebene, und Werte ohne lesbare Druckdarstellung
 * (etwa CLOS-Instanzen als Hash-Schlüssel) brachen die Navigation ganz.
 *
 * Jetzt hält das Image eine Objekt-Tabelle; der Client kennt nur IDs.
 * Beim Schließen des Panels wird sie freigegeben, damit keine Objekte
 * am Garbage Collector vorbei festgehalten werden.
 */
export class ClampsInspector {
  private static panel: vscode.WebviewPanel | undefined;
  private static trail: Crumb[] = [];

  /**
   * Besuchsverlauf, unabhängig vom Breadcrumb.
   *
   * trail ist ein PFAD: er zeigt, wo im Objektbaum man steht, und beim
   * Zurückgehen wird abgeschnitten. Damit ist alles verloren, was man
   * seitwärts besucht hat — geht man von A in Teil 3 und wieder zurück,
   * führt kein Weg mehr zu Teil 3, obwohl man gerade dort war.
   *
   * history ist die Browser-Sicht: jede besuchte Ansicht in der
   * Reihenfolge des Besuchs, mit Vor und Zurück darüber. Der Index zeigt
   * auf die gerade gezeigte Stelle; ein neuer Sprung schneidet nur den
   * Teil VOR dem Index ab, wie bei einem Browser.
   */
  private static history: Crumb[] = [];
  private static historyIndex = -1;
  /** Verhindert, dass Vor/Zurück selbst wieder Historie schreibt. */
  private static navigatingHistory = false;
  private static rootExpr = '';
  private static pkg = 'COMMON-LISP-USER';
  private static getClient: () => LanguageClient | undefined;
  /** Aktuell dargestelltes Objekt; Grundlage fuer den rekursiven Baum. */
  private static currentResult: InspectResult | undefined;
  /** Bereits geladene Unterobjekte, adressiert durch ihren Pfad im Baum. */
  private static recursiveChildren = new Map<string, InspectResult>();
  private static recursiveExpanded = new Set<string>();
  private static recursiveErrors = new Map<string, string>();

  static async inspect(
    getClient: () => LanguageClient | undefined,
    expr: string,
    pkg: string
  ): Promise<void> {
    this.getClient = getClient;
    this.pkg = pkg;
    this.rootExpr = expr;
    this.trail = [];
    this.history = [];
    this.historyIndex = -1;
    this.resetRecursive();
    await this.ensurePanel();
    await this.request('clamps/inspect', { expr, package: pkg }, expr);
  }

  private static async ensurePanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'clampsInspector',
      'CLAMPS Inspector',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderError('Lade …');

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.trail = [];
      this.history = [];
      this.historyIndex = -1;
      this.resetRecursive();
      // Objekt-Tabelle im Image freigeben. Ohne das hielten wir alles
      // fest, was je angeschaut wurde — bei Audio-Buffern schnell teuer.
      void this.release();
    });

    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.command) {
        case 'navigate':
          await this.navigate(Number(msg.index), String(msg.label ?? '?'), Number(msg.parentId));
          break;
        case 'expand':
          await this.expandRecursive(
            String(msg.path ?? ''), Number(msg.parentId), Number(msg.index), String(msg.label ?? '?')
          );
          break;
        case 'collapse':
          this.recursiveExpanded.delete(String(msg.path ?? ''));
          this.rerenderCurrent();
          break;
        case 'back':
          await this.back();
          break;
        case 'forward':
          await this.forward();
          break;
        case 'history':
          await this.gotoHistory(Number(msg.index));
          break;
        case 'jump':
          await this.jump(Number(msg.depth));
          break;
        case 'refresh':
          await this.refresh();
          break;
        case 'set':
          await this.setPart(Number(msg.index), String(msg.value ?? ''));
          break;
      }
    });
  }

  private static get current(): Crumb | undefined {
    return this.trail[this.trail.length - 1];
  }

  private static async navigate(index: number, label: string, parentId?: number): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    await this.request(
      'clamps/inspectPart',
      { id: Number.isFinite(parentId) ? parentId : cur.id, index },
      label,
      'push'
    );
  }


  private static resetRecursive(): void {
    this.currentResult = undefined;
    this.recursiveChildren.clear();
    this.recursiveExpanded.clear();
    this.recursiveErrors.clear();
  }

  /** Laedt einen Teil als Unterbaum, ohne die aktuelle Inspector-Seite zu verlassen. */
  private static async expandRecursive(
    path: string, parentId: number, index: number, label: string
  ): Promise<void> {
    if (!path || !Number.isFinite(parentId) || !Number.isFinite(index)) return;
    this.recursiveExpanded.add(path);
    if (this.recursiveChildren.has(path)) {
      this.rerenderCurrent();
      return;
    }
    const client = this.getClient?.();
    if (!client || client.state !== State.Running) return;
    try {
      const child = await client.sendRequest<InspectResult>('clamps/inspectPart', { id: parentId, index });
      if (child.kind === 'error') throw new Error(child.print || `Teil ${label} konnte nicht gelesen werden.`);
      this.recursiveChildren.set(path, child);
      this.recursiveErrors.delete(path);
    } catch (error) {
      this.recursiveErrors.set(path, error instanceof Error ? error.message : String(error));
    }
    this.rerenderCurrent();
  }

  private static rerenderCurrent(): void {
    if (this.panel && this.currentResult) this.panel.webview.html = this.render(this.currentResult);
  }

  /**
   * Zurück im Verlauf. Bewegt sich NICHT im Pfad: wer von A nach Teil 3
   * und zurück will, erwartet Teil 3 danach noch erreichbar zu haben.
   */
  private static async back(): Promise<void> {
    if (this.historyIndex <= 0) return;
    await this.gotoHistory(this.historyIndex - 1);
  }

  private static async forward(): Promise<void> {
    if (this.historyIndex >= this.history.length - 1) return;
    await this.gotoHistory(this.historyIndex + 1);
  }

  /** Direkter Sprung an eine Stelle des Verlaufs. */
  private static async gotoHistory(index: number): Promise<void> {
    if (index < 0 || index >= this.history.length) return;
    const target = this.history[index];
    this.historyIndex = index;
    // Der Pfad wird auf den Zielort gesetzt, damit Teil-Sprünge von hier
    // aus wieder stimmen. Der Verlauf bleibt vollständig.
    this.trail = [{ id: target.id, label: target.label }];
    this.navigatingHistory = true;
    try {
      await this.request('clamps/inspectRefresh', { id: target.id }, target.label, 'replace');
    } finally {
      this.navigatingHistory = false;
    }
  }

  /** Eintrag in den Verlauf schreiben, sofern es nicht Vor/Zurück war. */
  private static recordHistory(id: number, label: string): void {
    if (this.navigatingHistory) return;
    const cur = this.history[this.historyIndex];
    // Dieselbe Ansicht nicht doppelt: Aktualisieren und Setzen eines
    // Teils landen sonst als Dutzend gleicher Einträge im Verlauf.
    if (cur && cur.id === id && cur.label === label) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({ id, label });
    // Nach oben begrenzen: der Verlauf hält IDs der Objekt-Tabelle im
    // Image fest, und die wird erst beim Schliessen freigegeben.
    const MAX = 50;
    if (this.history.length > MAX) this.history = this.history.slice(-MAX);
    this.historyIndex = this.history.length - 1;
  }

  /** Sprung im Breadcrumb auf eine frühere Ebene. */
  private static async jump(depth: number): Promise<void> {
    if (depth < 0 || depth >= this.trail.length - 1) return;
    this.trail = this.trail.slice(0, depth + 1);
    const target = this.current;
    if (!target) return;
    await this.request(
      'clamps/inspectRefresh',
      { id: target.id },
      target.label,
      'replace'
    );
  }

  private static async refresh(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    await this.request(
      'clamps/inspectRefresh',
      { id: cur.id },
      cur.label,
      'replace'
    );
  }

  /**
   * Setzt einen Teil des aktuellen Objekts. Das Image wertet die Eingabe
   * aus, man kann also "(list 1 2)" oder "*foo*" eintippen und nicht nur
   * Literale. Anschließend kommt das Objekt neu beschrieben zurück —
   * durch das Setzen können sich auch Kopfzeilen ändern.
   */
  private static async setPart(index: number, value: string): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    await this.request(
      'clamps/inspectSet',
      { id: cur.id, index, value, package: this.pkg },
      cur.label,
      'replace'
    );
  }

  private static async release(): Promise<void> {
    const client = this.getClient?.();
    if (!client || client.state !== State.Running) return;
    try {
      await client.sendRequest('clamps/inspectRelease', {});
    } catch {
      // Beim Herunterfahren normal — nicht der Rede wert.
    }
  }

  private static async request(
    method: string,
    params: object,
    label: string,
    mode: 'push' | 'replace' | 'root' = 'root'
  ): Promise<void> {
    if (!this.panel) return;
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.panel.webview.html = this.renderError(
        'CLAMPS ist nicht verbunden. Führe „CLAMPS: Start" aus.'
      );
      return;
    }

    try {
      const r = await client.sendRequest<InspectResult>(method, params);
      if (r.package) this.pkg = r.package;
      if (r.kind === 'error') {
        this.panel.webview.html = this.renderError(r.print || 'Unbekannter Fehler');
        return;
      }
      if (mode === 'root') this.trail = [{ id: r.id, label }];
      else if (mode === 'push') this.trail.push({ id: r.id, label });
      else if (this.current) this.current.id = r.id;
      this.recordHistory(r.id, label);
      this.currentResult = r;
      this.recursiveChildren.clear();
      this.recursiveExpanded.clear();
      this.recursiveErrors.clear();
      this.panel.webview.html = this.render(r);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.html = this.renderError(message);
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private static render(r: InspectResult): string {
    const kind = r.kind || 'atom';
    const parts = r.parts ?? [];
    const meta = r.meta ?? [];
    const body = this.renderBody(kind, parts, r.id, '', [r.id], 0);
    // Vor/Zurück richten sich nach dem VERLAUF, nicht nach dem Pfad.
    const canBack = this.historyIndex > 0;
    const canForward = this.historyIndex < this.history.length - 1;

    // Bei skalaren Typen ist die Meta-Tabelle die eigentliche Information,
    // die print-Zeile also redundant.
    const scalar = ['number', 'character', 'string', 'pathname', 'package'];
    const showPrint = !(scalar.includes(kind) && meta.length > 0);

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      ${this.css()}
    </style></head><body>
      <div class="bar">
        <button id="back" ${canBack ? '' : 'disabled'} title="Zurück im Verlauf">←</button>
        <button id="forward" ${canForward ? '' : 'disabled'} title="Vor im Verlauf">→</button>
        <button id="refresh" title="Objekt neu einlesen">↻</button>
        ${this.renderHistorySelect()}
        <span class="kind kind-${esc(kind)}">${esc(kind)}</span>
        <span class="type">${esc(r.type)}</span>
        <span class="oid" title="ID in der Objekt-Tabelle">#${r.id}</span>
      </div>
      ${this.renderTrail()}
      ${this.renderMeta(meta)}
      ${showPrint ? `<div class="print">${esc(r.print)}</div>` : ''}
      ${body}
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('back')?.addEventListener('click', () =>
          vscode.postMessage({ command: 'back' }));
        document.getElementById('forward')?.addEventListener('click', () =>
          vscode.postMessage({ command: 'forward' }));
        document.getElementById('histsel')?.addEventListener('change', e =>
          vscode.postMessage({ command: 'history', index: Number(e.target.value) }));
        document.getElementById('refresh')?.addEventListener('click', () =>
          vscode.postMessage({ command: 'refresh' }));
        for (const c of document.querySelectorAll('[data-depth]')) {
          c.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({ command: 'jump', depth: Number(c.dataset.depth) });
          });
        }
        for (const a of document.querySelectorAll('[data-index]')) {
          a.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({
              command: 'navigate',
              index: Number(a.dataset.index),
              parentId: Number(a.dataset.parentId),
              label: a.dataset.label
            });
          });
        }
        for (const b of document.querySelectorAll('[data-expand-path]')) {
          b.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({
              command: b.dataset.expanded === 'true' ? 'collapse' : 'expand',
              path: b.dataset.expandPath,
              parentId: Number(b.dataset.parentId),
              index: Number(b.dataset.index),
              label: b.dataset.label
            });
          });
        }
        // Inline-Editor: Doppelklick ersetzt die Zelle durch ein Feld,
        // Enter schickt ab, Escape verwirft. Der bisherige Text steht als
        // Vorgabe drin, weil die Druckdarstellung meist wieder lesbar ist.
        for (const cell of document.querySelectorAll('[data-set]')) {
          cell.addEventListener('dblclick', () => {
            if (cell.querySelector('input')) return;
            const original = cell.textContent;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'editor';
            input.value = original.trim();
            cell.textContent = '';
            cell.appendChild(input);
            input.focus();
            input.select();
            const cancel = () => { cell.textContent = original; };
            input.addEventListener('keydown', ev => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                vscode.postMessage({
                  command: 'set',
                  index: Number(cell.dataset.set),
                  value: input.value
                });
              } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancel();
              }
            });
            input.addEventListener('blur', cancel);
          });
        }

        // Ein Filter pro Ebene, und jeder betrifft nur die DIREKTEN Zeilen
        // seiner eigenen Liste. Vorher lief der oberste Filter über alle
        // [data-filter-row] im Dokument und blendete damit auch Zeilen in
        // aufgeklappten Unterobjekten aus.
        for (const input of document.querySelectorAll('[data-filter-input]')) {
          const scope = input.dataset.filterInput;
          const list = document.querySelector('[data-filter-list="' + scope + '"]');
          const count = document.querySelector('[data-filter-count="' + scope + '"]');
          if (!list) continue;
          input.addEventListener('input', () => {
            const q = input.value.toLowerCase();
            let shown = 0;
            for (const row of list.children) {
              const hit = row.textContent.toLowerCase().includes(q);
              row.style.display = hit ? '' : 'none';
              if (hit) shown++;
            }
            if (count) count.textContent = shown + ' sichtbar';
          });
        }
      </script>
    </body></html>`;
  }

  /**
   * Pfad vom Wurzelausdruck bis hierher, jede Ebene anklickbar.
   *
   * Zwei Kürzungen, weil die Leiste sonst unbenutzbar wird: lange
   * Labels (ein Wurzelausdruck kann eine ganze defparameter-Form sein)
   * werden gestutzt, und ab einer gewissen Tiefe fallen die mittleren
   * Ebenen zu einem "…" zusammen. Der vollständige Text steht jeweils
   * im title-Attribut.
   */
  /**
   * Verlauf als Auswahlliste. Neueste zuoberst, weil man häufiger ein
   * paar Schritte zurück will als an den Anfang.
   */
  private static renderHistorySelect(): string {
    if (this.history.length < 2) return '';
    const options = this.history
      .map((c, i) => ({ c, i }))
      .reverse()
      .map(({ c, i }) =>
        `<option value="${i}" ${i === this.historyIndex ? 'selected' : ''}>` +
        `${esc(c.label)} <#${c.id}></option>`)
      .join('');
    return `<select id="histsel" title="Verlauf (${this.history.length})">${options}</select>`;
  }

  private static renderTrail(): string {
    if (this.trail.length === 0) return '';

    const MAX_LABEL = 28;
    const HEAD = 1; // Wurzel immer zeigen
    const TAIL = 3; // die letzten Ebenen immer zeigen

    const shorten = (t: string): string =>
      t.length <= MAX_LABEL ? t : t.slice(0, MAX_LABEL - 1) + '…';

    const full = (i: number): string =>
      i === 0 ? this.rootExpr : this.trail[i].label;

    const crumb = (i: number): string => {
      const last = i === this.trail.length - 1;
      const text = esc(shorten(full(i)));
      const title = esc(full(i));
      return last
        ? `<span class="crumb here" title="${title}">${text}</span>`
        : `<a class="crumb" href="#" data-depth="${i}" title="${title}">${text}</a>`;
    };

    const n = this.trail.length;
    let items: string[];
    if (n <= HEAD + TAIL + 1) {
      items = this.trail.map((_, i) => crumb(i));
    } else {
      const hidden = n - HEAD - TAIL;
      items = [
        ...Array.from({ length: HEAD }, (_, i) => crumb(i)),
        `<span class="crumb ellipsis" title="${hidden} Ebenen ausgeblendet">…</span>`,
        ...Array.from({ length: TAIL }, (_, k) => crumb(n - TAIL + k)),
      ];
    }
    return `<div class="trail">${items.join('<span class="sep">›</span>')}</div>`;
  }

  /** Wählt das Layout anhand der Objekt-Kategorie. */
  private static renderBody(
    kind: string, parts: InspectPart[], parentId: number, prefix: string,
    ancestors: number[], depth: number
  ): string {
    if (parts.length === 0) {
      return ['list', 'vector', 'array'].includes(kind)
        ? '<div class="empty">Leere Sequenz.</div>'
        : '<div class="empty">Keine navigierbaren Teile.</div>';
    }
    const indexed = ['list', 'vector', 'array'].includes(kind);
    const rows = parts.map(p => this.renderRecursiveRow(p, parentId, prefix, ancestors, depth, indexed)).join('');
    // Jede Ebene bekommt einen eigenen Namensraum. Vorher trug jeder
    // Filter dieselbe id="filter": getElementById band nur den ersten,
    // alle Filterfelder in aufgeklappten Unterobjekten waren tote UI.
    const scope = prefix === '' ? 'root' : `s${prefix.replace(/\./g, '_')}`;
    return `${this.filterBar(parts.length, scope)}` +
      `<div class="recursive-list" data-filter-list="${scope}">${rows}</div>`;
  }

  private static renderRecursiveRow(
    p: InspectPart, parentId: number, prefix: string, ancestors: number[],
    depth: number, indexed: boolean
  ): string {
    const path = prefix ? `${prefix}.${p.index}` : String(p.index);
    const expanded = this.recursiveExpanded.has(path);
    const child = this.recursiveChildren.get(path);
    const error = this.recursiveErrors.get(path);
    // expandable == null heißt „Image sagt nichts dazu" — dann wie bisher
    // jeden gebundenen Teil anbieten.
    const canExpand =
      p.navigable !== false && p.expandable !== false && depth < 8;
    const toggle = canExpand
      ? `<button class="twisty" data-expand-path="${esc(path)}" data-expanded="${expanded}" ` +
        `data-parent-id="${parentId}" data-index="${p.index}" data-label="${esc(p.label)}" ` +
        `title="${expanded ? 'Unterobjekt einklappen' : 'Unterobjekt inline aufklappen'}">${expanded ? '▾' : '▸'}</button>`
      : '<span class="twisty spacer"></span>';
    const labelClass = indexed ? 'idx' : 'k';
    const label = this.link(p, labelClass, parentId);
    let nested = '';
    if (expanded) {
      if (error) nested = `<div class="recursive-error">${esc(error)}</div>`;
      else if (!child) nested = '<div class="recursive-loading">Lade …</div>';
      else if (ancestors.includes(child.id)) {
        nested = `<div class="recursive-cycle">↩ Zyklus zu Objekt #${child.id}</div>`;
      } else {
        nested = `<div class="recursive-child"><div class="recursive-head">` +
          `<span class="kind kind-${esc(child.kind || 'atom')}">${esc(child.kind || 'atom')}</span>` +
          `<span class="type">${esc(child.type)}</span><span class="oid">#${child.id}</span></div>` +
          `${child.print ? `<div class="recursive-print">${esc(child.print)}</div>` : ''}` +
          `${this.renderBody(child.kind || 'atom', child.parts || [], child.id, path, [...ancestors, child.id], depth + 1)}` +
          `</div>`;
      }
    }
    return `<div class="recursive-item">` +
      `<div class="recursive-row">${toggle}<span class="recursive-label">${label}</span>${this.valueCell(p)}</div>` +
      `${nested}</div>`;
  }

  private static renderMeta(meta: InspectMeta[]): string {
    if (meta.length === 0) return '';
    const cells = meta
      .map(
        m =>
          `<div class="meta-k">${esc(m.key)}</div>` +
          `<div class="meta-v">${esc(m.value)}</div>`
      )
      .join('');
    return `<div class="meta">${cells}</div>`;
  }

  /** Klickbares Label, sofern der Teil betretbar ist. */
  private static link(p: InspectPart, cls: string, parentId: number): string {
    const label = esc(p.label);
    if (p.navigable === false) {
      return `<span class="${cls} dead" title="nicht gebunden">${label}</span>`;
    }
    return `<a class="${cls}" href="#" data-index="${p.index}" data-parent-id="${parentId}" data-label="${label}">${label}</a>`;
  }

  /** Wertzelle; bei schreibbaren Teilen per Doppelklick editierbar. */
  private static valueCell(p: InspectPart): string {
    const v = esc(p.preview ?? '');
    if (!p.settable) return `<span class="v">${v}</span>`;
    return `<span class="v editable" data-set="${p.index}"
                  title="Doppelklick zum Ändern">${v}</span>`;
  }

  private static filterBar(count: number, scope: string): string {
    if (count < 12) return '';
    return `<div class="filterbar">
      <input class="filter" data-filter-input="${scope}" type="text" placeholder="filtern …">
      <span class="filter-count" data-filter-count="${scope}">${count} Einträge</span>
    </div>`;
  }

  private static css(): string {
    return `
      body { font-family: var(--vscode-editor-font-family, monospace);
             font-size: 13px; padding: 12px;
             color: var(--vscode-foreground); }
      .bar { display: flex; align-items: center; gap: 8px;
             margin-bottom: 8px; }
      button { font: inherit; padding: 2px 10px; cursor: pointer;
               background: var(--vscode-button-background);
               color: var(--vscode-button-foreground);
               border: none; border-radius: 3px; }
      button:disabled { opacity: 0.4; cursor: default; }

      .kind { font-size: 11px; text-transform: uppercase;
              letter-spacing: 0.5px; padding: 1px 7px; border-radius: 9px;
              background: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground); }
      .kind-hash-table { background: #7b5ea7; color: #fff; }
      .kind-object     { background: #2b6cb0; color: #fff; }
      .kind-struct     { background: #2c7a7b; color: #fff; }
      .kind-list       { background: #975a16; color: #fff; }
      .kind-vector     { background: #9c4221; color: #fff; }
      .kind-array      { background: #9c4221; color: #fff; }
      .kind-symbol     { background: #4a5568; color: #fff; }
      .kind-function   { background: #276749; color: #fff; }
      .kind-number     { background: #285e61; color: #fff; }
      .kind-string     { background: #744210; color: #fff; }
      .kind-error      { background: var(--vscode-errorForeground); color: #fff; }

      .type { color: var(--vscode-descriptionForeground); }
      .oid  { color: var(--vscode-descriptionForeground); opacity: 0.6;
              margin-left: auto; font-size: 11px; }

      .trail { margin-bottom: 10px; }
      .crumb { color: var(--vscode-textLink-foreground); text-decoration: none; }
      .crumb.here { color: var(--vscode-descriptionForeground); }
      .crumb.ellipsis { color: var(--vscode-descriptionForeground);
                        opacity: 0.7; cursor: default; }
      .trail { white-space: nowrap; overflow-x: auto; }
      .sep { opacity: 0.5; margin: 0 5px; }

      .meta { display: grid; grid-template-columns: max-content 1fr;
              gap: 2px 12px; margin-bottom: 12px;
              padding: 8px; border-radius: 4px;
              background: var(--vscode-textBlockQuote-background);
              border-left: 3px solid var(--vscode-textBlockQuote-border); }
      .meta-k { color: var(--vscode-descriptionForeground); }
      .meta-v { word-break: break-all; white-space: pre-wrap; }

      .print { white-space: pre-wrap; word-break: break-all;
               background: var(--vscode-textCodeBlock-background);
               padding: 8px; border-radius: 4px; margin-bottom: 12px; }

      .filterbar { display: flex; align-items: center; gap: 8px;
                   margin-bottom: 6px; }
      .filterbar input { font: inherit; flex: 1; padding: 3px 6px;
                         background: var(--vscode-input-background);
                         color: var(--vscode-input-foreground);
                         border: 1px solid var(--vscode-input-border, transparent);
                         border-radius: 3px; }
      .filter-count { color: var(--vscode-descriptionForeground);
                      font-size: 11px; white-space: nowrap; }

      .pairs { display: grid; grid-template-columns: max-content 1fr;
               gap: 0 14px; }
      .pairs .head { font-size: 11px; text-transform: uppercase;
                     color: var(--vscode-descriptionForeground);
                     border-bottom: 1px solid var(--vscode-panel-border);
                     padding-bottom: 3px; margin-bottom: 3px; }
      .pairs .row { display: contents; }
      .pairs .row > * {
        padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }

      .indexed .row { display: flex; gap: 10px; align-items: baseline;
                      padding: 3px 0;
                      border-bottom: 1px solid var(--vscode-panel-border); }
      .idx { min-width: 3.2em; text-align: right; flex: none;
             color: var(--vscode-textLink-foreground);
             text-decoration: none; }

      a { color: var(--vscode-textLink-foreground); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .dead { color: var(--vscode-descriptionForeground); opacity: 0.6; }
      .editable { cursor: text; }
      .editable:hover { outline: 1px dotted var(--vscode-panel-border);
                        outline-offset: 2px; }
      .editor { font: inherit; width: 100%; box-sizing: border-box;
                padding: 1px 4px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-focusBorder);
                border-radius: 2px; }
      .v { white-space: pre-wrap; word-break: break-all; }
      .empty { color: var(--vscode-descriptionForeground); }
      .recursive-list { display: flex; flex-direction: column; gap: 1px; }
      .recursive-item { border-bottom: 1px solid var(--vscode-panel-border); }
      .recursive-row { display: grid; grid-template-columns: 20px minmax(90px, max-content) 1fr;
                       align-items: baseline; gap: 8px; padding: 3px 0; }
      .twisty { width: 18px; min-width: 18px; padding: 0; background: transparent;
                color: var(--vscode-foreground); }
      .twisty.spacer { display: inline-block; }
      .recursive-label { min-width: 0; }
      .recursive-child { margin: 3px 0 7px 20px; padding: 7px 8px;
                         border-left: 2px solid var(--vscode-panel-border);
                         background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-focusBorder)); }
      .recursive-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
      .recursive-head .oid { margin-left: auto; }
      .recursive-print { white-space: pre-wrap; word-break: break-all; opacity: .8;
                         margin-bottom: 6px; font-size: 12px; }
      .recursive-error { color: var(--vscode-errorForeground); margin: 4px 0 6px 22px; }
      .recursive-loading, .recursive-cycle { color: var(--vscode-descriptionForeground);
                                             margin: 4px 0 6px 22px; font-style: italic; }

    `;
  }

  private static renderError(message: string): string {
    return `<!DOCTYPE html><html><body style="font-family:monospace;padding:12px;color:var(--vscode-errorForeground)">
      <b>Inspect-Fehler:</b><pre>${esc(message)}</pre></body></html>`;
  }
}

/**
 * Öffnet den Inspector.
 *
 * Ohne Argumente wie bisher: Auswahl, Symbol am Cursor oder Top-Level-
 * Form aus dem aktiven Editor. Mit Argumenten direkt auf den übergebenen
 * Ausdruck — das braucht der Debugger, der einen Wert an ein Symbol
 * bindet und dessen Namen hereinreicht. Der Prototyp hat dafür ein
 * ungespeichertes Lisp-Dokument angelegt, den Text markiert und diesen
 * Befehl aufgerufen; das hinterliess Geistertabs.
 */
export async function inspectCommand(
  getClient: () => LanguageClient | undefined,
  expression?: string,
  packageName?: string
): Promise<void> {
  const client = getClient();
  if (!client || client.state !== State.Running) {
    vscode.window.showErrorMessage(
      'CLAMPS ist nicht verbunden. Führe „CLAMPS: Start" aus.'
    );
    return;
  }

  if (expression && expression.trim()) {
    await ClampsInspector.inspect(
      getClient,
      expression.trim(),
      packageName || 'COMMON-LISP-USER'
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CLAMPS: Kein aktiver Editor.');
    return;
  }

  // Bevorzugt die Auswahl; sonst das Symbol am Cursor; sonst die
  // Top-Level-Form.
  const selection = editor.document.getText(editor.selection).trim();
  const expr =
    selection.length > 0
      ? selection
      : symbolAt(editor.document, editor.selection.active) ??
        topLevelFormAt(editor.document, editor.selection.active);

  if (!expr) {
    vscode.window.showWarningMessage(
      'CLAMPS: Nichts zum Inspizieren am Cursor gefunden.'
    );
    return;
  }

  const pkg = packageAt(editor.document, editor.selection.active);
  await ClampsInspector.inspect(getClient, expr, pkg);
}
