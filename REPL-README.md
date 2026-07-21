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
