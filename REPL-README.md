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
