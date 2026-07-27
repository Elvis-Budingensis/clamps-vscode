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

- [x] **Completion im REPL-Terminal** — v81.16.
      Tab vervollständigt, zweimal Tab listet. Eigener Bridge-Aufruf
      `clamps/replComplete`, aber dieselbe Quelle wie die Editor-Completion.

### Offen

- [ ] Completion für Slot-Namen nach `with-slots` und `make-instance`
- [ ] `#'`-Kontext auf fbound-Symbole einschränken
- [ ] Wert-Completion für bekannte Keywords (`:element-type` → Typnamen)
- [ ] `snippetSupport`: Funktion mit Parameterplatzhaltern einfügen

## Audio-Domäne — was SLY und SLIME nie hatten

Der eigentliche Differenzierungspunkt. Nichts davon ist fertig.

- [x] **Echtzeit-Pegel** — v81.18. Der erste Punkt, den SLIME und SLY nie
      hatten. `CLAMPS: Pegel anzeigen`, dBFS-Balken mit Peak-Hold pro
      registriertem Ring, verlorene Werte sichtbar.

### Fundament vorhanden

- [ ] **Live Spectrogram.** Derselbe Ring, Fensterlänge über `capacity`
      statt `decimation`, FFT auf der Kontrollseite. Abholtakt steht seit
      v81.18; offen ist die höhere Rate und die FFT.
- [ ] **MIDI Monitor** — allgemeiner Sticker-Pfad mit `:element-type t`,
      da Ereignisse statt Samples. Abholtakt steht seit v81.18, aber
      `clamps/stickerSamples` liefert bisher nur Zahlen; Ereignisse
      brauchen einen eigenen Rückgabeweg.
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
