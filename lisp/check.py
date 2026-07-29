"""A completeness check for rpc.lisp and bridge-server.lisp.

It came about because, while the parts cache was being built in, a text
cut took nine functions with it: the cut ran from inspect-part-for-repl to
%offset->line-col, and after the object table was reworked everything in
between lay there. The test found it, but only after shipping.
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
            if d < 0: return f"too many ) on line {line}"
        i += 1
    return None if d == 0 else f"{d} paren(s) left open"

problems = []
# The list was maintained by hand, and completion.lisp was missing from it
# — it went out with two missing parens without anything being noticed
# here. Hence all the Lisp files in the directory now.
for path in sorted(glob.glob('lisp/*.lisp')):
    b = balance(path)
    if b: problems.append(f"{path}: {b}")

s = io.open('lisp/rpc.lisp', encoding='utf-8').read()

# Duplicate definitions
dupes = {k: v for k, v in Counter(re.findall(r'^\(defun ([a-z%*+-]+)', s, re.M)).items() if v > 1}
if dupes: problems.append(f"rpc.lisp: defined twice: {dupes}")

# Every exported symbol has to be defined
exported = re.findall(r'#:([a-z-]+)', s[s.index('(:export'):s.index('(in-package :clamps-bridge-rpc)')])
defined = set(re.findall(r'^\(defun ([a-z%*+-]+)', s, re.M))
for extra in ['lisp/completion.lisp', 'lisp/autodoc.lisp']:
    extra_source = io.open(extra, encoding='utf-8').read()
    defined.update(re.findall(r'^\(defun ([a-z%*+-]+)', extra_source, re.M))
missing = [e for e in exported if e not in defined]
if missing: problems.append(f"rpc.lisp: exported but undefined: {missing}")

# Every RPC function called by the bridge has to exist
bs = io.open('lisp/bridge-server.lisp', encoding='utf-8').read()
called = set(re.findall(r'clamps-bridge-rpc:([a-z-]+)', bs))
uncalled = [c for c in called if c not in defined]
if uncalled: problems.append(f"the bridge calls undefined functions: {uncalled}")

# Every dispatch clause that calls a handle-* needs it to exist. Methods
# handled inline (shutdown, exit) have none and are fine — which is why the
# name is read from the clause rather than guessed from the method name.
handlers = set(re.findall(r'^\(defun (handle-[a-z-]+)', bs, re.M))
methods = set(re.findall(r'string= method "([^"]+)"', bs))
for m, called_handler in re.findall(
        r'string= method "([^"]+)"\)\s*\((handle-[a-z-]+)', bs):
    if called_handler not in handlers:
        problems.append(f"method {m} calls {called_handler}, which does not exist")

# The other way round: handlers that are defined but called nowhere.
# Notifications (didOpen/didChange) and infrastructure (initialize,
# handle-request, handle-swank-message) run over other paths and are
# therefore on the exception list.
INFRA = {'handle-initialize', 'handle-request', 'handle-swank-message',
         'handle-did-open', 'handle-did-change'}
called_anywhere = set(re.findall(r'\((handle-[a-z-]+)[ )]', bs))
orphans = [h for h in handlers - INFRA if h not in called_anywhere]
if orphans: problems.append(f"handler is never called: {orphans}")

# TypeScript: every registered command has to be in package.json and vice
# versa. The debugger showed how easily the two drift apart.
import json
try:
    pkg = json.load(io.open('package.json', encoding='utf-8'))
    declared = {c['command'] for c in pkg.get('contributes', {}).get('commands', [])}
    src = ''.join(io.open(f, encoding='utf-8').read() for f in glob.glob('src/*.ts'))
    registered = set(re.findall(r"registerCommand\(\s*'([^']+)'", src))
    # Menu entries may point at commands, so check both against each other
    only_declared = declared - registered
    only_registered = registered - declared
    if only_declared:
        problems.append(f"package.json names commands without a registration: {sorted(only_declared)}")
    if only_registered:
        problems.append(f"registered, but not in package.json: {sorted(only_registered)}")
    for m in pkg.get('contributes', {}).get('menus', {}).values():
        for entry in m:
            c = entry.get('command')
            if c and c not in declared:
                problems.append(f"menu entry points at an unknown command: {c}")
except FileNotFoundError:
    pass

# Check the bridge's argument count against the lambda list.
#
# The occasion: handle-completion ALWAYS sends three arguments, because
# completion.lisp needs the source before the cursor. But the base version
# in rpc.lisp took only two. As long as completion.lisp loaded, that went
# unnoticed — and when it did not, every completion failed with "invalid
# number of arguments: 3". Simply no suggestions arrived, without an error
# message in the editor. The supposed fallback to the base completion was
# therefore no fallback at all.
def lambda_list(source, name):
    """The lambda list of NAME, with parens counted rather than stopping
    at the first ).

    This used to read ([^)]*), so the list ended at the first default
    value: (key &optional (limit 4096)) became
    "key &optional (limit 4096", that is, two required and two optional
    arguments instead of two and one. The number happened to be large
    enough to let the real call through — so the test was not checking,
    merely not getting in the way.
    """
    m = re.search(r'^\(defun ' + re.escape(name) + r'\s*\(', source, re.M)
    if not m:
        return None
    i = m.end()
    depth = 1
    start = i
    while i < len(source) and depth:
        if source[i] == '(':
            depth += 1
        elif source[i] == ')':
            depth -= 1
            if depth == 0:
                return source[start:i]
        i += 1
    return None

def lambda_info(source, name):
    raw = lambda_list(source, name)
    if raw is None:
        return None
    # Flatten default values: (limit 4096) becomes limit, that is, ONE
    # optional argument rather than two words.
    flat = ''
    depth = 0
    group = ''
    for ch in raw:
        if ch == '(':
            depth += 1
            if depth == 1:
                group = ''
                continue
        if ch == ')':
            depth -= 1
            if depth == 0:
                flat += ' ' + (group.split() or [''])[0] + ' '
                continue
        if depth >= 1:
            group += ch
        else:
            flat += ch
    words = flat.split()
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

# (format nil "(clamps-bridge-rpc:foo ~S ~S)" ...) — count the directives.
for m in re.finditer(r'format nil "\(clamps-bridge-rpc:([a-z-]+)([^"]*)"', bs):
    fname, tail = m.group(1), m.group(2)
    # Count arguments, not just format directives: handle-references
    # passes the XREF kind as a LITERAL (\"references\"), not as ~S.
    body = tail.rstrip()
    if body.endswith(')'):
        body = body[:-1]
    nargs = len(re.findall(r'~[SAD]|\\"(?:[^"\\]|\\.)*\\"|[^\s]+', body))
    infos = [lambda_info(src, fname) for src in rpc_sources.values()]
    infos = [i for i in infos if i]
    if not infos:
        problems.append(f"the bridge calls {fname}, defined nowhere")
        continue
    for info in infos:
        required, optional, rest = info
        if nargs < required or (not rest and nargs > required + optional):
            problems.append(
                f"the bridge calls {fname} with {nargs} argument(s), "
                f"the definition takes {required}"
                + (f"–{required + optional}" if optional else "")
                + (" and more" if rest else ""))

if problems:
    print("PROBLEMS:"); [print(" -", p) for p in problems]; sys.exit(1)
print(f"ok — {len(defined)} functions, {len(exported)} exports, "
      f"{len(called)} bridge calls, {len(methods)} methods, "
      f"{len(registered)} commands")
