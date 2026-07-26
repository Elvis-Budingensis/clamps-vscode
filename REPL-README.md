# CLAMPS Terminal-REPL

Die REPL ist als `vscode.Pseudoterminal` implementiert und wertet Code über
`clamps/eval` in derselben laufenden Swank-/SBCL-Session aus.

## Bedienung

- `CLAMPS: Open REPL`
- `Enter`: aktuellen Puffer auswerten
- `Ctrl+J`: Zeilenumbruch einfügen
- `Pfeil hoch/runter`: Verlauf
- `Pfeil links/rechts`: Cursor bewegen
- `Backspace`: Zeichen löschen
- `Ctrl+C`: aktuelle Eingabe verwerfen
- `Ctrl+L`: Terminal leeren
- `Cmd+Enter`/`Ctrl+Enter` im Lisp-Editor: Auswahl oder aktuelle Zeile auswerten

## Lifecycle-Fix

Start, Stop und Restart laufen über eine einzige Promise-Queue. Restart reiht
keinen zweiten Queue-Eintrag aus einem bereits laufenden Queue-Eintrag ein.
Außerdem wird ein LanguageClient im Zustand `Starting` erst nach Abschluss des
Startversuchs gestoppt. Damit wird der Fehler
`Client is not running and can't be stopped ... state is: starting` vermieden.

## Neue Image-Werkzeuge

- **Stepping:** VS Codes Step Into/Over/Out ruft `swank:sldb-step`,
  `swank:sldb-next` und `swank:sldb-out` auf. Der betreffende Lisp-Code
  muss mit hoher Debug-Qualitaet kompiliert sein, etwa mit
  `(declaim (optimize (debug 3) (speed 0) (safety 3)))`.
- **Compiler-Diagnostics:** Beim Speichern einer Lisp-Datei werden Swanks
  Compiler-Notes in VS Codes Problems-Ansicht uebernommen. Abschaltbar
  mit `clamps.compilerDiagnosticsOnSave`.
- **Image-Browser:** Die CLAMPS-Seitenleiste enthaelt nun Pakete, Klassen
  und Threads. Ein Klick uebergibt den Eintrag an den Objekt-Inspector.

## Inspector-Verlauf und rekursiver Inspector (v77)

Der Objekt-Inspector besitzt eine Browser-Historie mit Zurueck, Vorwaerts
und direkter Verlaufsauswahl. Navigierbare Teile haben zusaetzlich einen
Pfeil: Er klappt das Unterobjekt inline auf, ohne die aktuelle Ansicht zu
verlassen. Unterobjekte koennen bis zu acht Ebenen tief weiter aufgeklappt
werden. Selbstreferenzen und andere Zyklen werden erkannt und als Rueckverweis
auf die bereits sichtbare Objekt-ID angezeigt.

Ein Klick auf den Namen navigiert weiterhin klassisch in das Objekt; der
Pfeil ist ausschliesslich fuer die rekursive Baumansicht zuständig.

## Behobene Fehler in v76/v77 (v78)

Die drei Neuerungen aus v76/v77 waren in der ausgelieferten Fassung
wirkungslos oder falsch. Alle drei Fehler waren nur gegen ein laufendes
Image sichtbar, und genau das lief nicht: die Testsuite kannte weder
`xref` noch das rekursive Aufklappen, und `check.py` zaehlt Klammern und
Namen, keine Semantik.

- **XREF ausser Definitionen komplett tot.** `xref-for-repl` uebergab
  `resolve-symbol` den Paketnamen als String. `resolve-symbol` bindet
  `*package*` an dieses Argument, und SBCL deklariert `*package*` als Typ
  `PACKAGE` — der Typfehler wurde still zu `NIL` verschluckt.
  `swank:xref` wurde nie aufgerufen; Aufrufer, Aufgerufene, Referenzen,
  Bindungen, Setzer und Makroexpansionen meldeten stur „Symbol nicht
  gefunden". Jetzt geht ein Paket-Objekt hinein, wie an allen anderen
  sechs Aufrufstellen.
- **Sprungziel weiterhin am Dateianfang.** `%tool-entry` belegte `:line`
  mit 1, wenn das Backend keine Zeile liefert. Der Client bevorzugte die
  Zeile vor dem Offset, der korrekt daneben stehende Zeichen-Offset blieb
  ungenutzt — bei SBCL der Normalfall, weil Quellorte fast immer nur
  `(:position N)` enthalten. `:line` bleibt jetzt `NIL`, und der Client
  bevorzugt umgekehrt den Offset.
- **Zyklenerkennung konnte nie ausloesen.** `%inspect-register` vergab
  fuer dasselbe Objekt bei jedem Betreten eine neue ID. Der Client
  erkennt Zyklen daran, dass die ID eines Unterobjekts schon in der Kette
  der Vorfahren steht — das konnte so nicht zutreffen. Eine
  `eq`-Umkehrtabelle liefert nun stabile IDs; sie wird bei der
  FIFO-Raeumung und beim Freigeben mitgezogen.

Ausserdem:

- Labels werden auch in Attributen maskiert (`"` und `'`). String-Schluessel
  einer Hashtable kommen aus `prin1-to-string`, sind also immer
  `"key"` — das brach `data-label="…"` auf. Im Webview, das Skripte
  ausfuehren darf und ueber die set-Nachricht Lisp auswerten laesst, war
  das mehr als ein Darstellungsfehler.
- Der Aufklapp-Pfeil erscheint nur an Teilen, die selbst Teile haben. Das
  Image liefert dazu ein `expandable`-Feld; fehlt es (aelteres Image),
  bleibt das alte Verhalten.
- Jede Ebene hat ihren eigenen Filter. Vorher trug jeder dieselbe
  `id="filter"`, sodass nur das oberste Feld ueberhaupt reagierte und
  dabei auch Zeilen in aufgeklappten Unterobjekten ausblendete.
- Der Inspect-Rueckfallweg eines XREF-Treffers funktioniert. `swank:xref`
  liefert Namen als String, die alte `symbolp`-Probe war immer falsch.
- Ein fehlendes Swank-Paket ergibt die vorgesehene Meldung statt eines
  Paket-Typfehlers.
- Eine zweite XREF-Suche waehrend einer laufenden wird gemeldet statt
  kommentarlos verworfen.
- `resolve-symbol` interniert keine Symbole mehr. Ein Tippfehler legte
  bisher ueber `read-from-string` ein neues Symbol im Paket an und
  lieferte es zurueck, als waere es gefunden worden.
- `loadcheck.lisp` verwandelt `#:foo` nicht mehr in die Leseklausel
  `#-foo`. Der Fehler war latent, weil `#:` bisher nur in Dateien stand,
  die ohne Umschreiben lesbar sind.

Neue Gates: `sbcl --script lisp/test-xref.lisp` und
`node test/xref.test.js`, beide in `npm run gates` verdrahtet. Gegen den
Stand von v77 schlagen sie fehl.

## Mehrzeilige Eingaben an Swank (v79)

Mehrzeiliger Code kam im Image verstuemmelt an, sobald er ueber den
Debugger lief — und das ist der Normalfall, denn
`clamps.replUsesDebugger` steht auf `true`. Aus jedem Zeilenumbruch wurde
der Buchstabe `n`:

```text
(dsp! simple (freq amp)          ->  (dsp! simple (freq amp)
  (with-samples ((in (sine …))))      n (with-samples ((in (sine …)))
    (out in in)))                     n (out in in))
```

SBCL meldete daraufhin `undefined variable: n` bzw. `The variable n is
unbound` — an einem Symbol, das im Quelltext nirgends steht.

Ursache war `JSON.stringify` zum Bauen von Lisp-Stringliteralen. Der
Lisp-Reader kennt in Strings nur `\\` und `\"`; jedes andere `\x` liest er
als das nackte Zeichen `x`. `\n` wurde also zu `n`, `\t` zu `t`. Weil
Backslash und Anfuehrungszeichen in JSON und Lisp gleich maskiert werden,
fiel es bei einzeiligen Eingaben nie auf.

`lispString` in `swank.ts` machte es schon richtig, wurde aber nur an drei
Stellen benutzt. Jetzt geht jeder String, der als Lisp-Quelltext ueber den
Draht geht, darueber:

- REPL-Auswertung im Debugger (`eval-for-repl-debuggable`)
- Debug-Konsole und Hover (`eval-and-grab-output`, `eval-string-in-frame`)
- `return-from-frame`, das Binden von Werten fuer den Inspector
- `printSexpr` und damit `:emacs-rex` und `:emacs-return-string`

Ein echter Zeilenumbruch braucht keine Maskierung: er ist in einem
Lisp-Stringliteral gueltig, und der Swank-Rahmen zaehlt Bytes.

Betroffen war nur der Weg ueber den Debugger. Die Bruecke baute ihre
Formen schon immer mit `~S`, weshalb dieselbe Eingabe mit
`clamps.replUsesDebugger: false` funktionierte — das war auch der
Beweis fuer die Ursache.

Neues Gate: `node test/lispstring.test.js`. Es prueft die Maskierung und
sperrt `JSON.stringify` in Formen mit Lisp-Syntax statisch.
