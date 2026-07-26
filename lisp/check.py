"""Vollständigkeitsprüfung für rpc.lisp und bridge-server.lisp.

Entstanden, weil beim Einbauen des Teile-Caches ein Textschnitt neun
Funktionen mitgenommen hat: der Schnitt lief von inspect-part-for-repl
bis %offset->line-col, und nach dem Umbau der Objekt-Tabelle lag alles
dazwischen. Der Test hat es gefunden, aber erst nach dem Ausliefern.
"""
import glob, io, re, sys
from collections import Counter

def balance(path):
    s = io.open(path, encoding='utf-8').read()
    d = i = 0; n = len(s); line = 1
    while i < n:
        c = s[i]
        if c == '\n': line += 1; i += 1; continue
        if c == ';':
            while i < n and s[i] != '\n': i += 1
            continue
        if c == '#' and i+1 < n and s[i+1] == '\\': i += 3; continue
        if c == '#' and i+1 < n and s[i+1] == '|':
            depth = 1; i += 2
            while i < n and depth:
                if s.startswith('|#', i): depth -= 1; i += 2; continue
                if s.startswith('#|', i): depth += 1; i += 2; continue
                if s[i] == '\n': line += 1
                i += 1
            continue
        if c == '"':
            i += 1
            while i < n and s[i] != '"':
                if s[i] == '\n': line += 1
                if s[i] == '\\': i += 1
                i += 1
            i += 1; continue
        if c == '(': d += 1
        elif c == ')':
            d -= 1
            if d < 0: return f"zu viele ) in Zeile {line}"
        i += 1
    return None if d == 0 else f"{d} Klammern offen"

problems = []
# Die Liste war handgepflegt, und completion.lisp fehlte darin — sie ging
# mit zwei fehlenden Klammern raus, ohne dass hier etwas aufgefallen ist.
# Deshalb jetzt alle Lisp-Dateien im Verzeichnis.
for path in sorted(glob.glob('lisp/*.lisp')):
    b = balance(path)
    if b: problems.append(f"{path}: {b}")

s = io.open('lisp/rpc.lisp', encoding='utf-8').read()

# Doppelte Definitionen
dupes = {k: v for k, v in Counter(re.findall(r'^\(defun ([a-z%*+-]+)', s, re.M)).items() if v > 1}
if dupes: problems.append(f"rpc.lisp: doppelt definiert {dupes}")

# Jedes exportierte Symbol muss definiert sein
exported = re.findall(r'#:([a-z-]+)', s[s.index('(:export'):s.index('(in-package :clamps-bridge-rpc)')])
defined = set(re.findall(r'^\(defun ([a-z%*+-]+)', s, re.M))
for extra in ['lisp/completion.lisp', 'lisp/autodoc.lisp']:
    extra_source = io.open(extra, encoding='utf-8').read()
    defined.update(re.findall(r'^\(defun ([a-z%*+-]+)', extra_source, re.M))
missing = [e for e in exported if e not in defined]
if missing: problems.append(f"rpc.lisp: exportiert aber undefiniert: {missing}")

# Jede von der Bridge gerufene RPC-Funktion muss existieren
bs = io.open('lisp/bridge-server.lisp', encoding='utf-8').read()
called = set(re.findall(r'clamps-bridge-rpc:([a-z-]+)', bs))
uncalled = [c for c in called if c not in defined]
if uncalled: problems.append(f"bridge ruft undefinierte Funktionen: {uncalled}")

# Jede Dispatch-Klausel, die einen handle-* aufruft, braucht ihn auch.
# Inline behandelte Methoden (shutdown, exit) haben keinen und sind ok —
# deshalb wird der Name aus der Klausel gelesen statt aus dem Methodennamen
# geraten.
handlers = set(re.findall(r'^\(defun (handle-[a-z-]+)', bs, re.M))
methods = set(re.findall(r'string= method "([^"]+)"', bs))
for m, called_handler in re.findall(
        r'string= method "([^"]+)"\)\s*\((handle-[a-z-]+)', bs):
    if called_handler not in handlers:
        problems.append(f"Methode {m} ruft {called_handler}, das es nicht gibt")

# Umgekehrt: definierte Handler, die nirgends aufgerufen werden.
# Notifications (didOpen/didChange) und Infrastruktur (initialize,
# handle-request, handle-swank-message) laufen über andere Pfade und
# stehen deshalb auf der Ausnahmeliste.
INFRA = {'handle-initialize', 'handle-request', 'handle-swank-message',
         'handle-did-open', 'handle-did-change'}
called_anywhere = set(re.findall(r'\((handle-[a-z-]+)[ )]', bs))
orphans = [h for h in handlers - INFRA if h not in called_anywhere]
if orphans: problems.append(f"Handler wird nie aufgerufen: {orphans}")

# TypeScript: jeder registrierte Befehl muss in package.json stehen und
# umgekehrt. Der Debugger hat gezeigt, wie leicht das auseinanderläuft.
import json
try:
    pkg = json.load(io.open('package.json', encoding='utf-8'))
    declared = {c['command'] for c in pkg.get('contributes', {}).get('commands', [])}
    src = ''.join(io.open(f, encoding='utf-8').read() for f in glob.glob('src/*.ts'))
    registered = set(re.findall(r"registerCommand\(\s*'([^']+)'", src))
    # Menü-Einträge dürfen auf Befehle zeigen, also beides gegeneinander
    only_declared = declared - registered
    only_registered = registered - declared
    if only_declared:
        problems.append(f"package.json nennt Befehle ohne Registrierung: {sorted(only_declared)}")
    if only_registered:
        problems.append(f"registriert, aber nicht in package.json: {sorted(only_registered)}")
    for m in pkg.get('contributes', {}).get('menus', {}).values():
        for entry in m:
            c = entry.get('command')
            if c and c not in declared:
                problems.append(f"Menüeintrag zeigt auf unbekannten Befehl: {c}")
except FileNotFoundError:
    pass

# Argumentzahl der Bridge gegen die Lambda-Liste prüfen.
#
# Der Anlass: handle-completion schickt IMMER drei Argumente, weil
# completion.lisp den Quelltext vor dem Cursor braucht. Die Basisfassung in
# rpc.lisp nahm aber nur zwei. Solange completion.lisp lud, fiel das nicht
# auf — und als sie es nicht tat, scheiterte jede Vervollständigung mit
# "invalid number of arguments: 3". Es kamen einfach keine Vorschläge, ohne
# Fehlermeldung im Editor. Der angebliche Rückfall auf die Basis-Completion
# war deshalb keiner.
def lambda_info(source, name):
    m = re.search(r'^\(defun ' + re.escape(name) + r'\s*\(([^)]*)\)', source, re.M)
    if not m:
        return None
    words = m.group(1).split()
    required = 0
    optional = 0
    rest = False
    section = 'required'
    for w in words:
        if w.startswith('&'):
            section = w.lower()
            if section in ('&rest', '&body', '&key'):
                rest = True
            continue
        if section == 'required':
            required += 1
        elif section == '&optional':
            optional += 1
    return required, optional, rest

rpc_sources = {'lisp/rpc.lisp': s}
for extra in ['lisp/completion.lisp', 'lisp/autodoc.lisp']:
    rpc_sources[extra] = io.open(extra, encoding='utf-8').read()

# (format nil "(clamps-bridge-rpc:foo ~S ~S)" ...) — Direktiven zählen.
for m in re.finditer(r'format nil "\(clamps-bridge-rpc:([a-z-]+)([^"]*)"', bs):
    fname, tail = m.group(1), m.group(2)
    # Argumente zählen, nicht nur Format-Direktiven: handle-references
    # übergibt die XREF-Art als LITERAL (\"references\"), nicht als ~S.
    body = tail.rstrip()
    if body.endswith(')'):
        body = body[:-1]
    nargs = len(re.findall(r'~[SAD]|\\"(?:[^"\\]|\\.)*\\"|[^\s]+', body))
    infos = [lambda_info(src, fname) for src in rpc_sources.values()]
    infos = [i for i in infos if i]
    if not infos:
        problems.append(f"bridge ruft {fname}, nirgends definiert")
        continue
    for info in infos:
        required, optional, rest = info
        if nargs < required or (not rest and nargs > required + optional):
            problems.append(
                f"bridge ruft {fname} mit {nargs} Argument(en), "
                f"Definition nimmt {required}"
                + (f"–{required + optional}" if optional else "")
                + (" und mehr" if rest else ""))

if problems:
    print("PROBLEME:"); [print(" -", p) for p in problems]; sys.exit(1)
print(f"ok — {len(defined)} Funktionen, {len(exported)} Exporte, "
      f"{len(called)} Bridge-Aufrufe, {len(methods)} Methoden, "
      f"{len(registered)} Befehle")
