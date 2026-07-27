# Roadmap

Abhakliste, damit nichts doppelt gebaut wird. Erledigte Punkte tragen die
Revision, in der sie fertig wurden. Was hier unter „Offen" steht, ist nicht
angefangen — Halbfertiges steht unter „Teilweise" mit der konkreten Lücke.

## Completion auf SLY-Niveau

- [x] **Fuzzy Completion** — v81.10, verschärft in v81.14.
      Subsequenz-Match mit Lücken- und Startpositionsstrafe, dazu Bonus für
      Treffer auf Wortanfängen (`mvb` → `multiple-value-bind`).
- [x] **Package-aware Completion** — v81.10.
      `pkg:` liefert nur externe, `pkg::` alle Symbole. Das gültige Paket
      kommt aus der letzten `in-package`-Form vor der Cursorposition, nicht
      aus dem REPL-Paket.
- [x] **Argument Lists** — v81.10.
      Lambda-Liste als `detail`, erste Docstring-Zeile als `documentation`.
- [x] **Completion während des Tippens** — v81.10, erweitert in v81.14.
      LSP-`completionProvider`, Trigger `:` und `" "`, `isIncomplete` bei
      Abschneidung und bei leerem Präfix.
- [x] **Completion Ranking** — v81.14.
      Bis v81.13 rechnete die Lisp-Seite einen Score aus, den VS Code dann
      wegwarf, weil kein `sortText` mitkam. Jetzt wird der Rang als
      `sortText` übertragen.
- [x] **Keyword Completion** — v81.14.
      `&key`-Parameter der umschließenden Form stehen ganz oben, mit
      Herkunftsangabe im Detail. Vorher gab `:` das gesamte `KEYWORD`-Paket.

- [x] **Lexikalischer Scope exakt** — v81.14 (Scope gegen Nachbarschaft),
      v81.15 (Bindungsstelle). `let` bietet seine Namen in der eigenen
      Bindungsliste nicht an, `let*` und Incudines `with-samples` schon,
      und eine Lambda-Liste bindet ihre Namen erst im Rumpf.
- [x] **Kontextfenster** — v81.15.
      Der Kontext reicht bis zum Anfang der umschließenden Top-Level-Form
      (öffnende Klammer in Spalte 0) statt fester 120 Zeilen, mit 500
      Zeilen als Rückfalldeckel.

### Teilweise

- [ ] **Completion im REPL-Terminal.** Der LSP-Pfad greift nur in Dateien.

### Offen

- [ ] Completion für Slot-Namen nach `with-slots` und `make-instance`
- [ ] `#'`-Kontext auf fbound-Symbole einschränken
- [ ] Wert-Completion für bekannte Keywords (`:element-type` → Typnamen)
- [ ] `snippetSupport`: Funktion mit Parameterplatzhaltern einfügen

## Audio-Domäne — was SLY und SLIME nie hatten

Der eigentliche Differenzierungspunkt. Nichts davon ist fertig.

### Fundament vorhanden

- [ ] **Echtzeit-Pegel.** Der RT-sichere Sticker-Ring aus v81.11–v81.13
      liefert die Daten bereits allokationsfrei (`…-record-rms-for-repl`).
      Es fehlt: Pull-Takt vom Webview ohne REPL-Runde, und `sequence`
      auswerten, damit nur neue Einträge übertragen werden statt jedes Mal
      der ganze Ring.
- [ ] **Live Spectrogram.** Derselbe Ring, Fensterlänge über `capacity`
      statt `decimation`, FFT auf der Kontrollseite. Braucht denselben
      Pull-Takt, aber mit deutlich höherer Rate.
- [ ] **MIDI Monitor** — allgemeiner Sticker-Pfad mit `:element-type t`,
      da Ereignisse statt Samples.
- [ ] **OSC Monitor** — dito.

### Eigene Infrastruktur nötig

- [ ] **Incudine Node Graph.** Die Sidebar zeigt den Node-Tree bisher flach.
      Braucht Struktur, Gruppen und Live-Aktualisierung.
- [ ] **DSP-Graph live**
- [ ] **Grafischer Synth-Inspector**
- [ ] **Echtzeit-Parameterautomation**
- [ ] **Scheduler Timeline**
- [ ] **Audio Buffer Viewer**
- [ ] **VUG-Explorer**
- [ ] **ATS Browser**
- [ ] **Sample Browser**
