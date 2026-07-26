# v80 — Go-to-Definition, Completion und Signature Help wieder funktionsfähig

## Symptom

F12 sprang nicht, Completion erschien nicht, der Arglist-Echo
(`MAPCAR FUNCTION LIST &REST MORE-LISTS`) blieb aus. Die REPL lief normal
weiter. Keine Fehlermeldung, kein Eintrag im Output-Kanal.

## Ursache: die Swank-Rahmung zählte Zeichen statt Bytes

Der 6-stellige Hex-Header des Swank-Protokolls zählt **Bytes der
UTF-8-Kodierung** — genauso wie `Content-Length` in LSP. Auf der
LSP-Seite war dieser Fehler in v75 in beiden Richtungen behoben; der
ausführliche Kommentar in `read-lsp-message` beschreibt ihn. Auf der
**Swank-Seite stand er noch, ebenfalls in beiden Richtungen:**

```lisp
;; vorher
(usocket:socket-connect host port :element-type 'character)     ; Zeichenstrom
(write-string (format nil "~6,'0X" (length text)) ...)          ; ZEICHEN-Anzahl
(let ((buf (make-string len))) (read-sequence buf stream))      ; liest ZEICHEN
```

Bei reinem ASCII stimmen Bytes und Zeichen zufällig überein — deshalb
funktionierte die REPL, solange nur ASCII durchlief. Sobald ein Umlaut,
ein Gedankenstrich oder ein `°` in der Nutzlast steckte, las die
Gegenseite zu wenig, der Rest der Form wurde als Anfang der nächsten
Nachricht interpretiert, der Strom war verschoben, der nächste Header
unlesbar und `swank-reader-loop` beendete sich. **Ab diesem Moment feuerte
kein Callback aus `*pending-requests*` mehr** — Definition, Completion,
Signature Help und Hover antworteten nie mehr, ohne jede Meldung.

Genau diese vier tragen zuverlässig Nicht-ASCII:

- **Completion** schickt ein 120-Zeilen-Fenster der Datei als Kontext mit;
  CLAMPS-Quellen haben deutsche Kommentare.
- **Signature Help** und **Hover** bekommen deutsche Docstrings und
  Arglists aus dem Image zurück.

## Änderungen

### `lisp/bridge-server.lisp`

1. `connect-swank` verwendet `:element-type '(unsigned-byte 8)`.
2. `send-swank-text` kodiert UTF-8 selbst und schreibt die **Byte**-Länge.
3. `read-swank-message` liest Header und Rumpf als Bytes und dekodiert
   danach — analog zu `read-lsp-message`.
4. `handle-definition` verschluckt Einträge ohne Quelldatei nicht mehr.
   `find-definitions-for-repl` liefert für solche Fälle bewusst
   `(nil 0 0 label)` („damit der Client sie anzeigen kann"), der Client
   warf sie aber weg. Jetzt kommt eine `window/showMessage`-Warnung.
   Neue Helfer: `send-notification`, `show-message`.
5. Arity-Guards in `handle-completion` und `handle-signature-help`: eine
   unerwartet geformte Antwort ließ `destructuring-bind` fliegen, der
   Handler antwortete mit `-32603` statt mit einer leeren Liste.

### `src/extension.ts`, `package.json`

6. `documentSelector` des LanguageClient um `commonlisp` und
   `**/*.{lisp,lsp,cl,asd}` erweitert, `activationEvents` um
   `onLanguage:commonlisp` und `workspaceContains`. Inline Values waren
   schon für beide Sprach-IDs registriert, mit dem Kommentar „je nach
   Einstellung unterschiedlich zugeordnet" — beim LanguageClient stand
   nur `lisp`. Ist eine zweite Lisp-Extension installiert (Alive,
   commonlisp), bekommt der Client sonst kein `didOpen`, und das
   Symptombild ist identisch mit dem Rahmungsfehler.

### `lisp/swankframing.lisp` (neu)

Regressionsgate, eingehängt in `npm run lisp` hinter `framingtest.lisp`.
Prüft beide Richtungen gegen die echten Funktionen aus
`bridge-server.lisp` (nicht gegen Kopien), mit **zwei** Nachrichten
hintereinander: die erste kommt auch bei verschobenem Strom scheinbar
heil an, erst die zweite entlarvt den Fehler. Nutzlasten enthalten
`ÄÖÜ ß — °C` und eine deutsche Docstring.

## Wichtig zum Testen

`foo` im Screenshot war **in der REPL** definiert. Dafür gibt es keine
Quelldatei, F12 kann dort prinzipiell nicht springen — v80 sagt das jetzt
wenigstens, statt stumm zu bleiben. Für einen echten Test des Sprungs:
`mapcar`, `incudine:rt-start` oder ein Symbol aus einer per
`compile-file` geladenen Datei.

## Verifikation

- `npm run gates` vollständig grün (check.py, loadcheck, framingtest,
  swankframing, test-xref, test-completion, test-fallback, test-autodoc,
  `tsc -p ./`, sechs JS-Testdateien).
- Gegenprobe Schreibseite: `(length body)` → `(length text)`
  zurückgedreht ⇒ exit 1, `FEHLER Schreiben: Header zählt Bytes, nicht
  Zeichen`, keine Backtraces.
- Gegenprobe Leseseite: `len` Zeichen statt `len` Bytes ⇒ exit 1,
  `FEHLER Lesen: Strom nicht verschoben (kein :desync)`.
- Die LSP-Handler wurden zusätzlich mit simulierten
  `didOpen`/`definition`/`completion`/`signatureHelp`-Nachrichten gegen
  ein echtes SBCL geprüft; sie bauen die korrekten RPC-Formen
  (`call-context-before-point` liefert für `(mapcar #'car ` korrekt
  `("mapcar" 1)`).

## Nicht verifizierbar in dieser Umgebung

Der eigentliche Beweis fehlt noch: ein laufendes CLAMPS/Incudine-Image
mit Swank hängt hier nicht dran. Dass die Rahmung jetzt byte-korrekt ist,
ist bewiesen; dass damit **alle** drei Features im Editor erscheinen, muss
ein Lauf bei dir zeigen. Falls etwas weiterhin still bleibt, ist der
nächste Schritt `"clamps.trace.server": "verbose"` in den Settings — dann
steht im Output-Kanal „CLAMPS Language Server", ob VS Code die Anfragen
überhaupt schickt.
