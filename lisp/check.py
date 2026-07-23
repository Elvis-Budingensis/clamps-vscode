"""Vollständigkeitsprüfung für rpc.lisp und bridge-server.lisp.

Entstanden, weil beim Einbauen des Teile-Caches ein Textschnitt neun
Funktionen mitgenommen hat: der Schnitt lief von inspect-part-for-repl
bis %offset->line-col, und nach dem Umbau der Objekt-Tabelle lag alles
dazwischen. Der Test hat es gefunden, aber erst nach dem Ausliefern.
"""
import io, re, sys
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
for path in ['lisp/rpc.lisp', 'lisp/bridge-server.lisp',
             'lisp/bootstrap.lisp', 'lisp/test-inspect.lisp']:
    b = balance(path)
    if b: problems.append(f"{path}: {b}")

s = io.open('lisp/rpc.lisp', encoding='utf-8').read()

# Doppelte Definitionen
dupes = {k: v for k, v in Counter(re.findall(r'^\(defun ([a-z%*+-]+)', s, re.M)).items() if v > 1}
if dupes: problems.append(f"rpc.lisp: doppelt definiert {dupes}")

# Jedes exportierte Symbol muss definiert sein
exported = re.findall(r'#:([a-z-]+)', s[s.index('(:export'):s.index('(in-package :clamps-bridge-rpc)')])
defined = set(re.findall(r'^\(defun ([a-z%*+-]+)', s, re.M))
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

if problems:
    print("PROBLEME:"); [print(" -", p) for p in problems]; sys.exit(1)
print(f"ok — {len(defined)} Funktionen, {len(exported)} Exporte, "
      f"{len(called)} Bridge-Aufrufe, {len(methods)} Methoden")
