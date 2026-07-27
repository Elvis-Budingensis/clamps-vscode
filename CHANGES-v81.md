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

## v81.9 — Paredit: Atome waren keine Formen

Auf die Frage, wie man Paredit prüft, erst `structuralEditing.ts` gelesen.
Drei Fehler, davon einer, der die Hälfte der Befehle wirkungslos machte.

### 1. Der Scanner kannte nur Klammern

`formRanges` erfasste ausschliesslich Klammerausdrücke. In

    (mapcar #'car liste)

gibt es keinen einzigen — also taten `forwardSexp`, `backwardSexp`,
`slurpForward` und `barfForward` dort **nichts**. Genau in der Sorte Zeile,
in der man sie am häufigsten braucht.

Jetzt erfasst der Scanner Atome mit `list: false`. Reader-Makros bleiben
am Atom (`#'car` ist ein Stück, nicht zwei), und Strings sind ebenfalls
Atome — sonst hätte `slurp` über `"text"` hinweggegriffen.

`spliceSexp` benutzt dafür neu `containingList`: bei einem Atom hätte es
dessen erstes und letztes Zeichen gelöscht.

### 2. parentStart === 0 ist falsy

`selectParentSexp` prüfte `!r?.parentStart`. Die erste Form jeder Datei
beginnt bei Offset 0, also brach der Befehl dort ab — bei genau der Form,
in der man am meisten arbeitet. Jetzt `=== undefined`.

### 3. slurp griff über Ebenen hinweg

Die alte Zielsuche nahm die nächste Form, die nicht in der eigenen liegt —
auch eine aus der Elternform. Neu `slurpTarget`: nur Nachbarn mit
demselben `parentStart`. Bei `((a) )` gibt es kein Ziel, statt aus der
Klammer herauszugreifen.

`slurpTarget`, `barfTarget`, `containing` und `containingList` sind jetzt
exportiert — die Zielberechnung ist ohne Editor prüfbar, und genau darum
ging es.

### Neues Gate

`test/paredit.test.js`, in `npm test`. Prüft die berechneten Bereiche, nicht
„der Befehl existiert": Atome und Listen, Reader-Makros, Strings, Klammern
in String, Kommentar und `#\(`, Elternzuordnung inklusive Offset 0, die
kleinste umschliessende Form, slurp- und barf-Ziele, direkte Kinder gegen
Enkel, leere Form. Dazu fünf unbalancierte Eingaben (`(((`, `)))`,
`"unterminiert`, `#| offen`), die nicht werfen dürfen.

Gegenproben: Atome aus dem Scanner ⇒ 6 Fehler. `parentStart`-Zuordnung auf
falsy-Prüfung ⇒ 3 Fehler, darunter der Offset-0-Fall.

Beim Schreiben hatte ich selbst zwei Fehler drin — eine falsch abgezählte
Sortierreihenfolge, und der String-Fall, der einen echten Scanner-Fehler
aufdeckte statt meiner Erwartung.

### Was nicht geprüft ist

Die Befehle selbst brauchen einen Editor; getestet ist die
Zielberechnung, nicht das Anwenden der Edits. `wrapSexp` wickelt die
umschliessende Form ein, nicht den nächsten Ausdruck wie Emacs-Paredit —
das ist eine Design-Entscheidung, die ich so gelassen habe.
`barfForward` und `slurpForward` existieren nur vorwärts; die
Rückwärts-Varianten fehlen ganz.

## v81.10 — ein Gate gegen Gate-Lücken

Heute zweimal derselbe Fehler, beide Male zufällig gefunden:

- `lisp/test-inspect.lisp` — der gründlichste Test im Projekt, 80 Formen
  über 17 Typen, Slot-Setzen, Zirkularität, Teile-Cache — hing in **keiner**
  npm-Kette. Er lief nie.
- `test/lispstring.test.js` hatte eine Whitelist von 15 Dateinamen. v81
  brachte drei neue Module, die nicht darin standen, und
  `advancedTools.ts` baute prompt wieder einen Lisp-String mit
  `JSON.stringify`. Grün durchgelaufen, weil die Datei nie gelesen wurde.

Gemeinsame Ursache: eine gepflegte Liste, die beim nächsten neuen Code
verfällt. Ein Test, der nicht läuft, ist schlimmer als kein Test — er
erzeugt Vertrauen, das nicht gedeckt ist.

### `test/gatecoverage.test.js`

Läuft als erstes in `npm test`. Vier Prüfungen:

1. **Jede `test/*.test.js` kommt in der Gate-Kette vor.** Die npm-Skripte
   werden dafür rekursiv aufgelöst, damit `gates → lisp → sbcl --script …`
   miterfasst wird.
2. **Jede `lisp/test-*.lisp`** plus `loadcheck`, `framingtest`,
   `swankframing`.
3. **Kein Früh-Ausstieg mitten in einer Testdatei.** `test-inspect.lisp`
   enthält `(when (posix-getenv "TEST_EXIT") (exit :code 0))`; in den
   Gates ist die Variable nicht gesetzt, aber wer sie setzt, überspringt
   still den Rest und der Lauf endet mit Code 0. Ausstieg im letzten
   Fünftel gilt als Abschluss, weiter vorn als Falle.
4. **Keine Datei-Whitelists in Tests** — ein Array mit drei oder mehr
   `.ts`-Namen wird gemeldet. Wer `src/` prüfen will, liest `src/`.

### Gegenproben gegen die realen Fehler

- `test-inspect.lisp` aus der Kette entfernt (der tatsächliche
  v81.2-Zustand) ⇒ erkannt.
- Whitelist im lispstring-Wächter wiederhergestellt ⇒ erkannt.
- Früh-Ausstieg nach vorn verschoben ⇒ erkannt, mit Prozentangabe.

Das Gate hätte also beide heutigen Zufallsfunde von allein gemacht.

### Eigener Fehler beim Bauen

Die erste Fassung meldete alle 11 JS-Tests als nicht ausgeführt. Ursache:
`gates` endet mit `npm test`, nicht `npm run test`, und mein Regex kannte
nur die lange Form. Falscher Alarm statt Fund — behoben, die Kurzformen
werden jetzt mitaufgelöst.

Stand: 18 grüne Gate-Zeilen, 11 JS-Tests, 8 Lisp-Testläufe.

### Offen

Die Prüfung erfasst, **dass** ein Test läuft, nicht **wie viel** er
abdeckt. Ein Test, der nur `assert(true)` enthält, gilt als erfüllt.
Zeilenabdeckung würde das messen, ist aber ein eigenes Werkzeug.

Stickers bleiben ebenfalls offen: `stickerWrap` schreibt in die
Quelldatei, und `sticker-record-for-repl` alloziert — für `dsp!`-Körper
unbrauchbar, also für den Hauptzweck, für den ich Stickers empfohlen
hatte.

## v81.11 — expliziter Sticker-State für DSP-Hot-Paths

Die bisherige Funktion `sticker-record-for-repl` bleibt als bequemes
Control-/REPL-Instrument erhalten, ist aber ausdrücklich nicht realtime-sicher:
sie konsiert, registriert Inspector-Objekte und druckt Werte.

Für `dsp!`-Körper gibt es nun einen getrennten Pfad:

```lisp
(defparameter *meter-sticker*
  (clamps-bridge-rpc:make-sticker-state-for-repl 256))

(clamps-bridge-rpc:register-sticker-state-for-repl
 "meter" *meter-sticker*)

;; Im Hot-Path nur noch:
(clamps-bridge-rpc:sticker-state-record-for-repl *meter-sticker* sample)
```

Der State wird vor dem Start der Audiokette einmal angelegt. Der Schreibpfad
führt danach nur `svref`-Speicherung und Fixnum-Indexupdates aus. Hashzugriff,
Zeitabfrage, Listenbau, Inspector-Registrierung und `prin1-to-string` wurden in
den späteren Snapshot auf dem Kontrollthread verschoben.

Neu exportiert:

- `make-sticker-state-for-repl`
- `register-sticker-state-for-repl`
- `sticker-state-record-for-repl`

`sticker-clear-for-repl` leert registrierte Ringpuffer und entfernt anschließend
die Registrierung. `lisp/test-sticker-state.lisp` prüft Begrenzung,
Überschreiben und Reihenfolge des Ringpuffers. Der Test ist in `npm run lisp`
eingehängt.

Ehrliche Grenze: Im vorliegenden Build-Container war SBCL nicht installiert;
der neue Lisp-Test konnte dort daher nicht ausgeführt werden. `npm run check`
und die Gate-Coverage-Prüfung liefen grün. Der TypeScript-Build war wegen einer
unvollständig installierten lokalen `node_modules`-Struktur nicht aussagekräftig;
am TypeScript-Code wurde für diese Änderung nichts verändert.

## v81.12 — Pulse statt Sinus: die VUG-Falle, das Boxing und ein rotes Gate

### Der gemeldete Fehler

```lisp
(dsp! simple (freq amp)
  (with-samples ((in (sine freq amp 0)))
    (when (zerop *meter-counter*)                 ; <- hier
      (clamps-bridge-rpc:sticker-state-record-for-repl *meter-sticker* in))
    (setf *meter-counter* (if (= *meter-counter* 440) 0 (1+ *meter-counter*)))
    (out in in)))
```

Diese Fassung klingt als Puls, die Fassung ohne `when` als Sinus. Der
Unterschied ist nicht der Sticker, sondern das `when`.

Incudines VUG-Compiler emittiert den Update-Code einer VUG-Variablen an der
Stelle ihrer **ersten textuellen Referenz**, nicht an der Bindungsstelle. Die
erste Referenz auf `in` steht hier im `when`-Zweig. Damit wandert der
Oszillator-Update mit in den Zweig: `in` wird nur noch fortgeschrieben, wenn
`*meter-counter*` null ist, also einmal pro 441 Samples. Bei 44100 Hz sind das
100 Hz. `(out in in)` gibt dazwischen den gehaltenen Wert aus — eine
Sample-and-Hold-Treppe mit 100 Hz Grundperiode. Der 330-Hz-Sinus verschwindet
darin und übrig bleibt der Puls.

Es sind also 440 von 441 Samples verlorene Oszillator-Schritte; die Audiokette
selbst ist intakt, es gab keinen Xrun und keine GC-Pause.

### Zwei Auswege

Unmittelbar, ohne Änderung an der Extension:

```lisp
(with-samples ((in (sine freq amp 0)))
  (maybe-expand in)                ; Update hier erzwingen
  (when (zerop *meter-counter*) …)
  (out in in))
```

Ab dieser Revision besser, weil die Falle gar nicht erst aufgestellt wird: die
Dezimierung steckt im Sticker-State, der Aufruf im DSP-Körper bleibt
bedingungslos.

```lisp
(defparameter *meter-sticker*
  (clamps-bridge-rpc:make-sticker-sample-state-for-repl 256 441))

(clamps-bridge-rpc:register-sticker-state-for-repl "meter" *meter-sticker*)

(dsp! simple (freq amp)
  (with-samples ((in (sine freq amp 0)))
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl *meter-sticker* in)
    (out in in)))
```

Kein `when`, kein globaler Zähler, keine verschobene Referenz. Der State hält
jeden 441. Wert.

### Boxing im angeblich allokationsfreien Pfad

v81.11 schrieb den Wert per `svref` in einen `simple-vector`. Ein
`double-float` dorthin zu speichern heißt, ihn zu boxen — 16 Byte Allokation
pro Aufruf, im Realtime-Thread, genau das, was die Revision auszuschließen
behauptete. Symptomlos bei jedem 441. Sample, nicht symptomlos bei jedem.

`make-sticker-sample-state-for-repl` legt jetzt ein
`(simple-array double-float (*))` an; der Store ist unboxed. Der ungenutzte
Zweig wird mit Länge 0 alloziert, damit beide Slots monomorph bleiben und der
Hot-Path keine Typprüfung braucht.

Gemessen statt behauptet: `lisp/test-sticker-state.lisp` klammert 200000
Aufrufe in `sb-ext:get-bytes-consed` und schlägt oberhalb von 64 KB fehl.
Aktueller Stand: **0 Byte**. Gegengeprüft — mit der v81.11-Speicherung
zurückgebaut, schlägt der Test fehl.

### Das rote Gate

`npm run gates` war in v81.11 rot und ist es nicht aufgefallen, weil im
damaligen Container kein SBCL lag:

```
FEHLER: rpc.lisp ist nicht lesbar: can't read #. while *READ-EVAL* is NIL
  rpc.lisp: 0 Formen gelesen.
```

`(check-type capacity (integer 1 #.most-positive-fixnum))` war die einzige
`#.`-Stelle im ganzen Lisp-Baum. `loadcheck.lisp` liest mit abgeschaltetem
`*read-eval*` — absichtlich, damit das Prüfen nichts ausführt — und konnte
`rpc.lisp` deshalb ab v81.11 überhaupt nicht mehr lesen. Nicht nur der
Sticker-Code war ungeprüft, sondern die Datei komplett. Ersetzt durch
`(and fixnum (integer 1))`.

Das ist die teurere Lektion von beiden: ein Gate, das mangels Werkzeug nicht
läuft, meldet nicht „unbekannt", sondern gar nichts.

### Neu exportiert

- `make-sticker-sample-state-for-repl`
- `sticker-state-record-sample-for-repl`

`make-sticker-state-for-repl` nimmt zusätzlich `:element-type` (`t` oder
`double-float`) und `:decimation`. Bestehende Aufrufe bleiben gültig.
`sticker-state-record-for-repl` bleibt der allgemeine Pfad für beliebige
Werte und respektiert die Dezimierung ebenfalls; für `dsp!`-Körper ist der
Sample-Pfad zu nehmen.

### Gate-Stand

Diesmal vollständig gelaufen, mit SBCL 2.2.9 und installierten
`node_modules`: `python3 lisp/check.py` grün, 9 Lisp-Testläufe grün,
`tsc -p ./` ohne Fehler, 11 JS-Tests grün. Am TypeScript-Code wurde nichts
geändert.

## v81.13 — RMS statt Momentanwert

### Warum

v81.12 hat den Puls beseitigt, und die Aufzeichnung war danach korrekt — aber
als Pegelanzeige unbrauchbar. Die gespeicherten Werte eines 330-Hz-Sinus mit
Fenster 441 waren ausschließlich `{±0.19021, ±0.11756, ~0}`, also
`0.2 · sin(k · 108°)`. 441 Samples bei 44100 Hz sind 3,3 Perioden; pro
Aufzeichnung also 0,3 Zyklus Versatz, nach zehn Aufzeichnungen wieder am
Ausgangspunkt. Der Sample-Pfad tastet mit 100 Hz ab und liefert damit
rotierende Phasenpunkte, keine Amplitude. Bei 300 Hz — genau 3,0 Perioden pro
Fenster — stünde eine Konstante im Ring, bei 331 Hz eine langsam wandernde
Folge. Alle drei Fälle sind rechnerisch richtig und sagen über den Pegel
nichts.

Der Grund ist nicht die Dezimierung als solche, sondern dass sie 440 von 441
Samples wegwirft. Ein Aggregat über das Fenster wirft keines weg.

### Neu

```lisp
(clamps-bridge-rpc:sticker-state-record-rms-for-repl *meter-sticker* in)
```

Gleiche Signatur, gleicher Aufrufort, gleiche Bedingungslosigkeit wie der
Sample-Pfad — die VUG-Falle aus v81.12 bleibt also zu. Jeder Sample wird
quadriert und aufsummiert; am Fensterende wird `sqrt(mean(x²))` in den Ring
geschrieben und der Akkumulator zurückgesetzt.

Ein Verhaltensunterschied, der dokumentiert gehört: der Sample-Pfad speichert
auf dem **ersten** Aufruf eines Fensters, der RMS-Pfad auf dem **letzten**.
Der erste RMS-Wert erscheint nach `decimation` Aufrufen, nicht sofort.

Der Akkumulator liegt als `double-float`-Slot im State, ebenso der
vorberechnete Kehrwert `1/decimation` — damit braucht der Hot-Path weder eine
Division noch eine Fixnum-nach-Float-Wandlung. Messung wie in v81.12:
200000 Aufrufe, **0 Byte** konsiert.

### Genauigkeit

Bei nicht ganzzahligem Periodenverhältnis ist das Fenster angeschnitten und
der Fenster-RMS weicht um wenige Prozent vom Idealwert ab; bei 330 Hz und
Fenster 441 gemessene 0.1389 gegen ideale 0.1414, also 1,8 %, mit leichter
Schwankung von Fenster zu Fenster. Das ist Eigenschaft des Verfahrens und
kein Implementierungsfehler. Wer es exakt braucht, wählt ein Fenster, das ein
ganzzahliges Vielfaches der Periode ist, oder ein deutlich längeres.

Der Test hält beides fest: jeder RMS-Wert innerhalb von 5 % am Idealwert und
die Werte untereinander innerhalb von 5 % — und, als Gegenprobe am selben
Signal, der Sample-Pfad streut über mehr als die volle Amplitude. Wenn diese
Gegenprobe je fehlschlägt, trägt der Vergleich nicht mehr und der Test sagt
das, statt stillschweigend grün zu bleiben.

### Gate-Stand

`python3 lisp/check.py` grün (85 Funktionen, 36 Exporte), 9 Lisp-Testläufe
grün, `tsc -p ./` ohne Fehler, 11 JS-Tests grün. Am TypeScript-Code wurde
nichts geändert.

## v81.14 — Completion: Rangfolge, echter Parser, &key-Kontext

Von den sechs Punkten der SLY-Liste waren vier bereits gebaut. Diese
Revision schließt die restlichen zwei und repariert zwei Defekte, die die
vorhandenen Punkte teilweise wirkungslos machten. Der Stand steht ab jetzt
in `ROADMAP.md` mit Haken, damit nichts doppelt gebaut wird.

### Das Ranking kam nie an

`handle-completion` schickte `label`, `kind`, `detail`, `documentation` —
und kein `sortText`. Ohne dieses Feld sortiert VS Code die Liste mit seinem
eigenen Matcher neu. Die gesamte Rangfolge aus `completion.lisp` — Score,
Kopfpositions-Bias, lokale Namen — wurde also berechnet und dann verworfen.
Jetzt geht der Rang als fünfstellige Nummer mit.

Das ist derselbe Fehlertyp wie das rote Gate aus v81.12: die Arbeit war
getan, nur kam sie nirgends an, und nichts hat es gemeldet.

### Der Locals-Scanner war eine Heuristik

Die alte Fassung suchte nach `let`/`flet`/`defun` und nahm dann im
600-Zeichen-Fenster dahinter das erste Token nach *jeder* öffnenden
Klammer. Damit erwischte sie auch Aufrufköpfe im Rumpf — und diese
Fehltreffer bekamen Bias −100, den stärksten Bonus überhaupt. Ein zufällig
aufgeschnapptes `sine` stand also über dem echten Symbol.

Ersetzt durch `%completion-tokenize`: ein Formenparser ohne Reader, der
Strings, Zeilenkommentare und Zeichenliterale überspringt und
unabgeschlossene Formen als Normalfall behandelt. Er liefert zwei Dinge —
den Baum der geschlossenen Formen und die Kette der am Cursor noch offenen.
Letztere ist genau der Pfad der Formen, in denen der Cursor steht.

Daraus folgt dreierlei:

Namen aus diesem Pfad sind im Scope und ranken vorn (−100), Namen aus
benachbarten geschlossenen Formen deutlich schwächer (−20). Vorher war
beides gleich stark.

Operatorposition wird nicht mehr durch Rückwärtssuche nach der nächsten
Klammer geraten, sondern daran erkannt, dass die innerste offene Form außer
dem getippten Präfix noch nichts enthält.

Die Binder-Tabelle ist explizit und enthält jetzt auch `dsp!`,
`with-samples`, `define-vug` und `define-ugen`. In einem `dsp!`-Körper sind
`freq`, `amp` und die `with-samples`-Variablen die Namen, die man
tatsächlich tippt — bis v81.13 kannte der Scanner sie nicht.

Ein Detail, das beim Bauen zweimal Zeit gekostet hat: der Tokenizer trägt
Kinder erst beim Schließen in die Elternform ein, also fehlen genau die
offenen Formen, die den Cursor enthalten. Bei `(labels ((helper (acc) ac`
wäre die Bindungsliste leer. `%completion-attach-open` hängt deshalb jede
offene Form als letztes Kind ihrer Elternform an, bevor extrahiert wird.

### Keyword Completion mit Kontext

`:` lieferte bisher das gesamte `KEYWORD`-Paket — im laufenden CLAMPS-Image
sind das zehntausende Einträge. Jetzt wird die Lambda-Liste der
umschließenden Form ausgewertet und deren `&key`-Parameter mit Bias −200
vorangestellt, mit Herkunft im Detail (`&key von make-array`).

Dazu kommt `" "` als Trigger und die Freigabe des leeren Präfixes. Hinter
`(make-array 3 ` erscheinen damit die Keywords, ohne dass man `:` tippen
muss. Bei leerem Symbolteil liefert die Bridge **ausschließlich** diese
Keywords — sonst müsste hinter jedem Leerzeichen das halbe Image kommen und
der Trigger wäre unbrauchbar. Hat die umschließende Form keine
`&key`-Parameter, bleibt die Liste leer und die Ergänzungsbox erscheint gar
nicht erst.

Die Antwort auf ein leeres Präfix trägt immer `isIncomplete`, damit der
Client nach dem nächsten Zeichen neu fragt statt lokal auf dieser
absichtlich beschnittenen Teilmenge zu filtern.

### Fuzzy-Feinschliff

Treffer auf Wortanfängen — Position 0 oder direkt nach `-`, `*`, `%`, `+` —
zählen jetzt −8 pro Zeichen. `mvb` findet damit `multiple-value-bind` und
nicht irgendein Symbol, in dem m, v und b zufällig in dieser Reihenfolge
vorkommen. Der Test fordert Rang unter 5.

### Was bewusst offen bleibt

`let` gegen `let*` wird nicht unterschieden, und ein Name ist auch dann
schon sichtbar, wenn der Cursor noch in seiner eigenen Bindungsliste steht.
Das Kontextfenster der Bridge bleibt bei 120 Zeilen, längere `defun`-Körper
verlieren also ihre oberen Bindungen. Beides steht in `ROADMAP.md` unter
„Teilweise", mit der konkreten Lücke statt eines Hakens.

### Gate-Stand

`python3 lisp/check.py` grün (97 Funktionen, 36 Exporte), 9 Lisp-Testläufe
grün, `tsc -p ./` ohne Fehler, 11 JS-Tests grün. `lisp/test-completion.lisp`
ist um sechzehn Zusicherungen gewachsen: Tokenizer gegen Strings,
Kommentare und Zeichenliterale, offene Formenkette, Operatorposition,
Incudine-Binder, Scope-Vorrang, `&key`-Kontext, Stille ohne
`&key`-Parameter, Wortanfangs-Ranking. Am TypeScript-Code wurde nichts
geändert.

## v81.15 — Completion: Bindungsstelle und Kontextfenster

Die zwei Punkte, die in v81.14 unter „Teilweise" stehen geblieben sind.

### Sichtbarkeit an der Bindungsstelle

v81.14 hielt jeden Namen einer umschließenden Bindungsform für sichtbar,
auch wenn der Cursor noch in der Bindungsliste selbst stand. In

```lisp
(let ((alpha 1) (beta al
```

ist `alpha` bei `let` gerade **nicht** sichtbar — der Wert von `beta` wird
im äußeren Scope berechnet. Bei `let*` ist er es. `%completion-open-scope-names`
unterscheidet das jetzt: pro offener Form wird geprüft, ob der Cursor in der
Bindungs- bzw. Lambda-Liste steht, und wenn ja, ob der Binder sequenziell
ist.

Zu den sequenziellen Bindern zählen neben `let*`, `do*` und `prog*` auch
Incudines `with-samples` und `with`. Das ist keine Kosmetik: in

```lisp
(with-samples ((car1 (sine 330)) (mod (* car1 ca
```

muss `car1` angeboten werden, weil `with-samples` wie `let*` bindet.

Wo die Bindungsliste steht, hängt von der Form ab — bei `let` und `lambda`
an Argumentposition 1, bei `defun` und `dsp!` an 2, weil dort der Name davor
steht. `flet`, `labels` und `loop` bleiben ausgenommen: dort ist der Cursor
innerhalb der Bindungsliste bereits im Rumpf einer lokalen Funktion, deren
Parameter sichtbar sind.

### Kontextfenster bis zur Top-Level-Form

Die Bridge übertrug 120 Zeilen vor dem Cursor. Bei einem längeren `defun`
fielen dessen Parameter damit aus dem Kontext und wurden nicht mehr
vervollständigt — leise, ohne Hinweis, abhängig davon wie weit oben man
gerade tippt.

Jetzt reicht der Kontext bis zum Anfang der umschließenden Top-Level-Form,
erkannt an der öffnenden Klammer in Spalte 0, wie in Emacs. `*completion-context-max-lines*`
= 500 bleibt als Rückfalldeckel, damit in einer Datei ohne Klammer in
Spalte 0 nicht bei jedem Tastendruck alles durch die Bridge geht.

Nebeneffekt, der die Vorschläge zusätzlich schärft: der Kontext endet jetzt
am Anfang der aktuellen Top-Level-Form, statt in die vorige hineinzureichen.
Namen aus der Funktion darüber landen also nicht mehr in der Liste.

### Ein Testproblem und seine Lösung

`bridge-server.lisp` lässt sich im Gate-Container nicht laden — es braucht
usocket, bordeaux-threads und eine Swank-Verbindung. Bisher war die Datei
deshalb nur strukturell durch `loadcheck.lisp` abgedeckt, und
`completion-context` wäre ungetestet geblieben.

`lisp/test-bridge-context.lisp` holt sich stattdessen genau die vier
benötigten Top-Level-Formen aus dem ausgelieferten Quelltext — per
klammerzählendem Scan, Strings und Kommentare ausgenommen — und wertet nur
diese aus. Damit wird die echte Datei geprüft und nicht eine Kopie, die
auseinanderlaufen kann.

Eine Falle dabei, an der der Test zuerst hängen blieb und die für künftige
Erweiterungen zählt: `(search "(defun completion-context" text)` trifft
`completion-context-start-line` zuerst, weil die Funktion früher in der
Datei steht. Der Suchbegriff muss die Argumentliste mitnehmen.

### Gate-Stand

`python3 lisp/check.py` grün (98 Funktionen, 36 Exporte), 10 Lisp-Testläufe
grün, `tsc -p ./` ohne Fehler, 11 JS-Tests grün. `test-completion.lisp` um
sieben Zusicherungen zur Bindungsstelle gewachsen, `test-bridge-context.lisp`
neu mit acht. Am TypeScript-Code wurde nichts geändert.
