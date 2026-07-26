# CLAMPS VS Code v81 — additive tooling foundation

This change set is intentionally additive. Existing commands, debugger paths, textual REPL output, inspector APIs and bridge methods remain intact.

## Added

- Image-aware indentation provider with conservative Common Lisp/CLAMPS fallbacks.
- Stable REPL presentation IDs backed by the existing bounded inspector registry.
- `,inspect`, `,load`, `,compile`, `,test`, `,stickers`, and `,package` REPL commands.
- Paredit-style structural navigation and editing: select, parent, forward/backward, wrap, raise, splice, forward slurp/barf.
- ASDF load/compile/test commands with a whitelist on the Lisp side.
- Iterative macrostep view.
- Bounded sticker records with explicit instrumentation, snapshot and clear commands.

## Compatibility safeguards

- `clamps/eval` still returns `output` and `package`; `presentations` is optional and additive.
- Presentation and sticker objects share the existing bounded registry rather than adding an unbounded second object store.
- No existing command ID or request method was renamed.
- All new RPC methods have separate handlers.
- Existing TypeScript tests and static bridge checks pass.

## Runtime verification still required

The build environment used for this revision did not contain SBCL. Run `npm run gates` on the CLAMPS development machine before release so the Lisp load/framing tests execute against SBCL and the live image.

## Deliberately not claimed as complete

This revision establishes safe foundations, not full parity, for realtime-safe automatic code-walker stickers, hierarchical trace capture, statistical profiler UI, and simultaneous independent Lisp sessions. Those require live-image stress testing and should remain isolated follow-up revisions rather than being folded into the stable path without evidence.

## v81.2 — echte REPL-Presentations

- Presentation-Objekte besitzen nun eine eigene, begrenzte Registry.
- Das Schließen oder Freigeben des Inspectors löscht sichtbare REPL-Ergebnisse nicht mehr.
- Der Debugger-REPL-Pfad (`clamps/replEval`) liefert dieselben Presentation-Metadaten wie der Bridge-Pfad.
- Das Terminal zeigt die IDs auch bei angehängter Debug-Session an.
- Regressionstest: Presentation bleibt nach `inspect-release-for-repl` verfügbar und behält ihre stabile ID.

## v81.3 — Presentation-Etiketten, Stelligkeit, Gate-Lücke

### Zur gemeldeten "Doppelung"

Nachgestellt gegen ein echtes SBCL: `eval-for-repl` und
`eval-for-repl-debuggable` liefern pro Wert **genau eine** Presentation,
und der Terminal-Code schreibt jede Zeile einmal. Reproduzieren liess
sich das Bild aus dem Screenshot nur mit **zwei Formen in einer
Eingabe**:

    (eval-for-repl-debuggable "(defparameter *q* (make-hash-table)) *q*" ...)
    output:        "*Q*\n#<HASH-TABLE ...>"
    presentations: ((3 "*Q*" "symbol") (4 "#<HASH-TABLE ...>" "hash-table"))

Das erklärt Block 1 des Screenshots vollständig, wenn die Eingabe per
Ctrl+J zweizeilig war: Zeile 2 des Echos, dann beide Werte, dann beide
Presentation-Zeilen. Block 2 passt ebenso, wenn `*presentation-test*`
zweimal in einer Eingabe stand — dass beide dieselbe ID `#2` bekommen,
ist die stabile Identität, die genau so gewollt ist.

**Nicht bewiesen.** Was tatsächlich getippt wurde, weiss nur Daniel.
Falls die Eingabe einzeilig war, ist es doch ein Bug und die Ursache
liegt nicht in den geprüften Funktionen.

### Behoben

- **Typ-Etiketten kamen aus `type-of`** und waren dadurch exakte
  Typspezifizierer statt Namen: `2` → `(integer 0 4611686018427387903)`,
  `"abc"` → `(simple-array character (3))`, `#(1 2)` →
  `(simple-vector 2)`, `1` → `bit`. In der REPL stand dann
  `[#4 (integer 0 4611686018427387903)] ,inspect 4`. Neu:
  `%presentation-type-label` über `class-name`/`class-of`, mit `type-of`
  als Rückfall für anonyme Klassen. Ergibt `fixnum`,
  `simple-character-string`, `simple-vector`.
- **`eval-for-repl` war im Fehlerzweig dreistellig**, im Erfolgszweig
  vierstellig. Jeder Aufrufer musste das selbst abfangen. Jetzt beide
  vierstellig.
- **Meldung bei abgelaufener Presentation** nennt die Kapazität, statt
  nur „no longer available" zu sagen. Bei 200 Plätzen laufen IDs ab.

### Gate-Lücke geschlossen

`lisp/test-inspect.lisp` hing in **keiner** npm-Kette — auch der
Presentation-Regressionstest aus v81.2 lief also nie. Jetzt in
`npm run lisp` hinter `test-xref`.

Zwei neue Prüfungen darin: Etiketten gegen die Werte, bei denen `type-of`
daneben liegt (inklusive „enthält keine Klammern"), und gleiche
Stelligkeit beider `eval-for-repl`-Zweige.

Gegenprobe: `type-of` wieder eingesetzt ⇒ exit 1,
`FEHLER Etikett fuer 2: erwartet "fixnum", bekommen "(integer 0 …)"`.

### Nicht geprüft

`test-inspect.lisp` steht hinter einem `(when (posix-getenv "TEST_EXIT")
(exit 0))`. Ist die Variable gesetzt, werden beide Presentation-Tests
übersprungen. In den Gates ist sie nicht gesetzt; ob das anderswo so
bleibt, habe ich nicht verfolgt.

Ausserdem habe ich von v81 nur die Presentation-Pfade geprüft. Stickers,
Paredit, ASDF-Befehle, Macrostep und der Indentation-Provider sind
statisch durch die Gates gelaufen, aber nicht gegen ein Image getestet.

## v81.4 — Atom-Toplevel auswerten

Bestätigt aus den Screenshots: die Presentation-Etiketten kommen jetzt als
`[#4 symbol]` und `[#5 fixnum]` — die `type-of`-Reparatur greift. Und die
gemeldete Doppelung war keine: jede Auswertung liefert genau eine
Presentation, die zweizeilige Eingabe war die Erklärung.

### Behoben

In allen vier Screenshots stand dieselbe Warnung, unabhängig vom
eigentlichen Thema: **„CLAMPS: Keine Top-Level-Form am Cursor gefunden"**,
bei Cursor auf `*presentation-test*` in Zeile 32.

`topLevelFormAt` suchte ausschliesslich nach einer `(` auf Klammertiefe 0.
Ein nacktes Atom auf Top-Level — `*presentation-test*`, `6`, `t` in einer
eigenen Zeile — ist aber eine gültige Form. `evalTopLevel` meldete dort
nur die Warnung und tat nichts, während `evalLastExpression`
(`sexpBeforePoint`) dasselbe Atom seit immer korrekt auswertet. Zwei
Befehle, zwei Meinungen darüber, was eine Form ist.

Neu: `topLevelAtomAt` als Rückfall, wenn keine Klammerform am Cursor
liegt. Betrifft `clamps.evalTopLevel`, `clamps.macroexpand`,
`clamps.macroexpandAll` und den Inspector, die sich alle dieselbe
Funktion teilen.

Bewusst eng gehalten — ein Atom gilt nur als Form, wenn es
- auf Klammertiefe 0 steht (innerhalb einer Form gewinnt die Form),
- nicht in String oder Kommentar liegt,
- der Cursor darauf oder unmittelbar dahinter steht. Nach links wird nur
  über Leerzeichen und Tabs gerückt, **nicht** über Zeilenumbrüche: sonst
  würde am Anfang einer leeren Zeile das Atom der Zeile darüber
  ausgewertet, ohne dass man es sieht.

### Neues Gate

`test/toplevel.test.js`, eingehängt in `npm test`. 17 Fälle, Cursor im
Testtext mit `|` markiert. Vier prüfen unverändertes Klammerverhalten,
sieben den reparierten Atom-Fall, sechs was **nicht** auslösen darf
(leere Zeile, leere Datei, nur Leerzeichen, Kommentar, String, Atom
innerhalb einer Form).

Gegenprobe: den Rückfall wieder auf `undefined` gesetzt ⇒ exit 1, genau
die sieben Atom-Fälle schlagen fehl, die sechs Negativfälle bleiben grün.

### Nicht geprüft

In Bild 3 zeigt der Entwicklungs-Workspace `PROBLEMS 27` (0 Fehler, 27
Warnungen). `npm run gates` läuft grün durch, `tsc` meldet nichts — die 27
kommen also aus einer anderen Quelle als der Gate-Kette. Ich habe nicht
verfolgt, woher; falls es Absicht ist, ignorieren.

## v81.5 — die 27 Warnungen in package.json

Aufgeklärt, und die Zahl geht exakt auf.

Laut VS-Code-Doku gilt seit **1.74.0** dasselbe für drei Kategorien:
beigesteuerte **Befehle**, **Views** und **Sprachen** aktivieren die
Extension implizit, die zugehörigen `onCommand:`/`onView:`/`onLanguage:`
Einträge sind dann redundant. Der eingebaute package.json-Validator mahnt
jeden einzeln an:

    21 onCommand + 5 onView + 1 onLanguage:lisp = 27

`engines.vscode` steht auf `^1.85.0`, also weit hinter 1.74 — alle 27
konnten weg. Übrig bleiben vier, die NICHT implizit sind:

    workspaceContains:**/*.asd
    workspaceContains:**/*.lisp
    onLanguage:commonlisp
    onDebug

### Der Eintrag, der bleiben MUSS

`onLanguage:commonlisp` sieht aus wie die anderen 27, ist aber nicht
redundant: `commonlisp` wird **nicht von dieser Extension** beigesteuert,
sondern von einer zweiten Lisp-Extension. Die implizite Aktivierung
greift nur für eigene Beiträge. Wer hier pauschal alle `onLanguage:`
entfernt, macht den v80-Fix still rückgängig — und dann sind Definition,
Completion und Signature Help wieder tot, sobald `.lisp` der fremden ID
zugeordnet ist. Genau die Sorte Rückschritt, die niemandem auffällt.

### Neues Gate

`test/manifest.test.js`, als erstes in `npm test`. Prüft vier Dinge:

1. keine redundanten Aktivierungsereignisse — mit Versionsprüfung, damit
   das Gate bei einem `engines.vscode` unter 1.74 nicht falsch anschlägt;
2. `onLanguage:commonlisp` ist vorhanden, solange `commonlisp` nicht
   selbst beigesteuert wird;
3. keine Keybindings, Menü-Einträge oder Aktivierungsereignisse, die auf
   nicht deklarierte Befehls-IDs zeigen;
4. der `documentSelector` des LanguageClient enthält weiter `lisp` **und**
   `commonlisp`.

Drei Gegenproben, alle exit 1 mit der passenden Meldung: redundantes
`onCommand` wieder eingefügt; `onLanguage:commonlisp` entfernt;
`documentSelector` auf nur `lisp` zurückgedreht.

Punkt 1 war der eigentliche Befund, Punkte 2 und 4 sind der Grund, warum
ich das Gate überhaupt geschrieben habe: die Aufräumaktion selbst war der
riskante Teil.

### Einschränkung

Dass es genau diese 27 waren, ist aus der Doku und der Zählung
erschlossen, nicht aus der Problems-Liste abgelesen — die Namen der
einzelnen Warnungen habe ich nie gesehen. Wenn nach dem Neuladen des
Fensters nicht 0 übrig bleiben, war meine Zuordnung unvollständig.

## v81.6 — Einrückung: die Regeltabelle war wirkungslos

Bestätigt aus den Screenshots: 0 Fehler, 0 Warnungen — die 27 sind weg,
die Zuordnung war vollständig. Presentations laufen über vier Typen
(`package`, `symbol`, `hash-table`, `fixnum`), jeweils eine Zeile.

### Der Fehler

Auf die Frage, wie man den Indentation-Provider prüft, habe ich ihn erst
gelesen — und dort stand:

    spaces = top.col + (rule === 0 ? 2 : 2);

Beide Zweige `2`. Die Regel wurde nachgeschlagen und verworfen. Damit
hatte die komplette `rules`-Map keine Wirkung: weder die 19 Defaults noch
die per `clamps/indentationRules` aus dem laufenden Image geholten Regeln.
Jede Fortsetzungszeile landete auf `top.col + 2`. Der ganze
Image-Abgleich, inklusive `refresh()` und dem Befehl
`clamps.refreshIndentation`, war Dekoration.

Sichtbar wird das beim Funktionsaufruf, dessen Argumente sich in Lisp
unter dem ersten Argument ausrichten:

    (mapcar #'car        vorher:  (mapcar #'car
            rest)                   rest)

### Behoben

`indentColumn` unterscheidet jetzt drei Fälle:

- **Makro/Sonderform mit bekannter Regel** → `top.col + 2`
- **Funktionsaufruf ohne Regel** → unter dem ersten Argument,
  `top.col + 1 + länge(operator) + 1`
- **kein Operator** (`(` am Zeilenende, Bindungsliste) → `top.col + 1`

Schließende Klammer auf eigener Zeile geht auf die Spalte der Form, die
sie schließt. Vorher war es „Körper minus 2", was im ausgerichteten Fall
daneben lag.

### Ausdrücklich NICHT umgesetzt

Die Zahl in der Regel (`['defun',2]`, `['when',1]`) bedeutet in SLIMEs
`common-lisp-indent-function`, wie viele Argumente **ausgezeichnet** sind
und dadurch tiefer eingerückt werden als der Körper. Diese Fassung wertet
die Zahl weiterhin nicht aus — sie unterscheidet nur „hat eine Regel" von
„hat keine". Für `defun`, `when`, `let` und den Alltag stimmt das
Ergebnis; bei Formen wie `do` oder `multiple-value-bind`, wo die
ausgezeichneten Argumente wirklich anders stehen, nicht.

Das ist bewusst so gelassen: die Argumentzählung braucht einen echten
Form-Scanner, und ein halber wäre schlechter als die jetzige, klar
begrenzte Regel. Wer das nachziehen will, findet den Ort in
`indentColumn`.

### Neues Gate

`test/indentation.test.js`, in `npm test`. 13 Fälle: Makro-Körper,
verschachtelt, Funktionsaufruf mit langem und kurzem Operator,
schließende Klammer, Klammer in String und Kommentar, und zwei Fälle für
„Regel gesetzt ändert das Ergebnis" — der Beweis, dass die Tabelle
überhaupt wirkt.

`test/vscode-stub.js` musste um `Range` und `TextEdit` erweitert werden.

Gegenprobe: Rückkehr zu `return top.col+2` ⇒ exit 1, die vier
Aufruf-Fälle fallen.

Beim Schreiben des Tests hatte ich selbst zwei Fehler drin — ein Helfer,
der „kein Edit" als „kein Ergebnis" behandelte statt als „steht schon
richtig", und ein falsch abgezählter Erwartungswert (14, nicht 16). Beide
korrigiert, bevor das Gate eingehängt wurde.

## v81.7 — isolierter Start, formatOnType vorbelegt

### DeprecationWarnings: nicht aus diesem Projekt

`DEP0040` (punycode) und `DEP0169` (url.parse) in der Debug Console
stammen nicht von hier. Der Laufzeit-Abhängigkeitsbaum umfasst sechs
Pakete — `vscode-languageclient` mit `minimatch`, `semver`,
`vscode-languageserver-protocol`, `vscode-jsonrpc`,
`vscode-languageserver-types` — und keines importiert `url` oder
`punycode`; `punycode` ist nicht einmal installiert. Im eigenen Code gibt
es ebenfalls keinen Treffer.

Der Extension-Host ist ein gemeinsamer Prozess für alle Extensions im
Fenster, und `launch.json` setzte kein `--disable-extensions`. Die
Warnungen kommen also aus VS Code selbst oder aus einer der anderen
geladenen Extensions. Sie erscheinen nur im Entwicklungs-Debugger, nicht
bei Nutzern einer installierten Extension. Zu beheben ist hier nichts.

### Zweite Startkonfiguration

`.vscode/launch.json` hat eine zusätzliche Konfiguration **„CLAMPS
Extension starten (isoliert, ohne andere Extensions)"** mit
`--disable-extensions`. Die bestehende bleibt unverändert — sonst wäre
Copilot im Dev-Host weg, ohne dass das entschieden wurde.

Der Nutzen geht über die Warnungen hinaus: eine zweite Lisp-Extension
(Alive, commonlisp) kann die Zuordnung von `.lisp` an sich ziehen, und
dann ist genau das v80-Symptombild da — REPL läuft, Editor-Features still
tot. Mit der isolierten Konfiguration ist das in einem Durchgang
ausgeschlossen.

### formatOnType vorbelegt

Beim Beschreiben der Testschritte fiel auf: der Einrückungs-Provider hängt
an `OnTypeFormatting`, und `editor.formatOnType` ist in VS Code
standardmäßig **aus**. Der Provider feuert also bei jedem Nutzer nie —
unabhängig von der Regel-Reparatur aus v81.6 — und nichts sieht dabei
kaputt aus.

Neu in `contributes`:

    "configurationDefaults": {
      "[lisp]":       { "editor.formatOnType": true },
      "[commonlisp]": { "editor.formatOnType": true }
    }

`configurationDefaults` ist der dafür vorgesehene Weg: es setzt eine
Voreinstellung, die der Nutzer weiterhin überschreiben kann.

Das Manifest-Gate prüft es als fünften Punkt. Gegenprobe: Block entfernt
⇒ exit 1, beide Sprachen gemeldet.

### Einschränkung

Ob die Warnungen mit `--disable-extensions` tatsächlich verschwinden, habe
ich nicht gesehen — das zeigt erst ein Lauf bei dir. Bleiben sie stehen,
ist es VS Code selbst, und dann ist auch das kein Handlungsbedarf.

## v81.8 — der v79-Wächter sah nicht hin

Auf die Frage „sind wir nahe an SLY" habe ich die neuen v81-Module gelesen
statt eine Zahl zu nennen. Dabei fiel das auf.

### Die Whitelist verfiel

Der statische Wächter aus v79 — „wer Lisp-Quelltext baut, benutzt
`lispString`" — hatte **15 Dateinamen fest eingetragen**. v81 fügte drei
Module hinzu (`advancedTools.ts`, `structuralEditing.ts`,
`imageIndentation.ts`), die nicht in der Liste standen. Und in
`advancedTools.ts:17` stand prompt wieder:

    `(clamps-bridge-rpc:sticker-record-for-repl ${JSON.stringify(key)} …)`

Genau das Muster, das v79 verboten hat. Der Wächter lief grün durch, weil
er die Datei nie gelesen hat.

Beweis: die drei Dateien in die Liste eingetragen ⇒ exit 1,
`advancedTools.ts:17`. Der Wächter funktionierte, er hat nur nicht
hingesehen.

Behoben in beide Richtungen:

- Der Wächter scannt jetzt **alle** `.ts` unter `src/` per `readdirSync`
  statt einer gepflegten Liste. Eine Whitelist verfällt genau dann, wenn
  man sie am dringendsten braucht: bei neuem Code.
- `advancedTools.ts` benutzt an beiden Stellen `lispString`.

### Wie schlimm war es wirklich

Latent, nicht akut. Der Sticker-Name wird mit
`${dateiname}:${zeile}` vorbelegt; für macOS-Pfade liefern
`JSON.stringify` und `lispString` dasselbe. Zum echten Fehler wird es
erst, wenn ein Pfad oder ein selbst getippter Name einen Backslash
enthält. Das ändert nichts daran, dass die Sperre wirkungslos war —
sie hätte die nächste, schlimmere Stelle genauso durchgelassen.

### Anmerkung zu Stickers

`clamps.stickerWrap` **schreibt in die Quelldatei**: die Auswahl wird
durch `(sticker-record-for-repl "key" <form>)` ersetzt. SLYs Stickers
verändern den Quelltext nicht — sie instrumentieren beim Compile und
lassen die Datei sauber.

Für Realtime-Code ist der Unterschied kein Geschmacksfrage:
`sticker-record-for-repl` macht `push`, `%inspect-register` und
`prin1-to-string`. In einem `dsp!`-Körper, der pro Audioblock läuft, ist
das Allokation und Ausgabe im Audio-Thread. Nicht benutzen. Für
Kontrollcode ausserhalb der Audiokette ist es brauchbar.

Das ist eine Einschätzung aus dem Lesen des Codes, nicht aus einem
Messlauf.
