# M4-Bericht: Antworten der Kunden verarbeiten (Phase D)

Stand 2026-10-14. n8n 2.43.4, Data Tables.

## Fertig
| Bereich | Ergebnis |
|---|---|
| EPA-03 Antwort verarbeiten | Wird von EPA-01 aufgerufen, sobald eine Mail eindeutig einem Vorgang zugeordnet ist. Hängt die Mail an, extrahiert die neuen Angaben (Kontext: offene Felder), führt sie mit den bekannten Daten zusammen, prüft die Pflichtfelder und setzt den Status. Bei Lücken startet über EPA-02 die nächste Rückfrage-Runde, danach folgt die Meldung an die Mitarbeiter. |
| Merge (`src/antwort.js`) | Regeln aus Bauplan 5.6: Gültige Werte werden **nie überschrieben**. Abweichende gültige Angaben werden als **Konflikt** vermerkt (nicht übernommen) und gemeldet. Neue gültige Werte füllen nur Lücken, ungültige lassen die Lücke mit aktualisiertem Grund offen. Gleiche Angaben (normalisiert) gelten als Bestätigung. Konflikte werden über Runden gesammelt, ohne Dopplungen. |
| Audit | Jede Übernahme und jeder Konflikt als `MERGE`-Eintrag (Feld, alt, neu, Quelle, Message-ID). Dazu die Statuswechsel mit Liste der übernommenen und offenen Felder. |
| Wann automatisch? | Bei „Warten auf Kunde“, „Freigabe ausstehend“ und „Bereit zur Bearbeitung“ (Nachtrag). In anderen Status (z. B. „Eskaliert / Manuell“, „In Prüfung“) wird die Mail nur angehängt und gemeldet, ohne KI-Auswertung. |
| Offene Freigabe | Antwortet der Kunde, bevor die Rückfrage freigegeben ist, wird die alte Freigabe auf „ersetzt“ gesetzt (alter Link → 409). Bei Bedarf entsteht eine neue Rückfrage nur zu den noch offenen Feldern. |
| Antwort ohne Angaben | Mails wie „melde mich morgen“ oder nur Platzhalter werden **nicht als Antwort gewertet**. Status und Freigabe bleiben, die Frist wird um `leerantwort_fristverlaengerung_stunden` verlängert (nie verkürzt), Audit und Meldung folgen. |
| Rundenlimit | Reicht auch eine weitere Antwort nicht, eskaliert EPA-02 bei erreichtem `max_runden` statt erneut zu fragen. |
| Datenminimierung | Die KI bekommt bei Antworten nur den neuen Mailtext (Zitat abgeschnitten) sowie die **Namen** der offenen und der bekannten Felder, keine bekannten Werte. Widersprüche erkennt der Code, nicht die KI. |

## Entscheidungen
1. **Erst auswerten, dann Status ändern:** Der Status wechselt erst nach der Extraktion auf „In Prüfung“. Eine Vertröstung lässt den Vorgang so unberührt, und die offene Freigabe bleibt gültig. Abweichung vom Masterprompt-Schritt 1 („Status auf In Prüfung“): gleiche Wirkung bei Antworten mit Daten, ohne unnötige Statuswechsel bei Antworten ohne Daten.
2. **„Keine Daten“ wird im Code erkannt**, nicht durch eine eigene KI-Klasse: Kein Feld enthält eine echte Angabe (nur leer oder Platzhalter). Das ist deterministisch und spart einen KI-Aufruf.
3. Ein Konflikt hält den Vorgang nicht auf: Ist sonst alles vollständig, geht er auf „Bereit zur Bearbeitung“. Der Widerspruch steht in der Meldung und am Vorgang (`konflikte`).

## Getestet
1. **137 Unit-Tests** grün (1 weiterer braucht eine Test-Postgres und wurde übersprungen), davon 11 neu für M4 (Merge-Tabelle vollständig, Konflikte über Runden, „keine Daten“, Frist, Matrix-Konformität, Meldung).
2. **End-to-End lokal:** M4 9/9 und Gesamtlauf **61/61** (M2 36/36, M3 16/16, M4 9/9), M1-Regression 14/14. Matrix in `docs/Testprotokoll-M4.md`. Die Fälle:
   - vollständige Antwort → Bereit
   - Teilantwort → Runde 2 mit neuer Freigabe und zweitem Versand
   - Widerspruch → Konflikt, alter Wert bleibt
   - Vertröstung → Status bleibt, Frist verlängert
   - Antwort während offener Freigabe → ersetzt, alter Link 409
   - Nachtrag nach Bereit
   - Rundenlimit → Eskalation
   - Antwort zu eskaliertem Vorgang → nur Meldung, keine KI
   - Zitat und bekannte Werte gehen nicht an die KI
3. Angepasste Altfälle: T15 (Antwort füllt Lücke → Bereit), T31 (eskalierter Vorgang → nur Meldung), F16 (Antwort nach Freigabe → Bereit).

### Durch die Tests aufgefallen
- Zwei Testfälle waren falsch aufgebaut, nicht der Workflow:
  - A06: Der „Nachtrag“ widersprach einem schon bekannten Wert und wurde korrekterweise als Konflikt behandelt.
  - A09: Der Prüfwert kam im System-Prompt vor.
  Beide Tests sind korrigiert. Das Verhalten ist so gewollt.

## Offen / zu verifizieren
- Klärung von Konflikten durch Mitarbeiter (Wert übernehmen oder verwerfen) ist noch manuell in der Data Table. Eine Teams-Aktion dafür wäre eine Erweiterung.
- Der Entwurf der ersetzten Rückfrage bleibt im Postfach (Ordner „Entwürfe“) liegen. Er wird nie gesendet (Freigabe „ersetzt“), sollte aber aufgeräumt werden. Das ist für den Löschjob in M6 vorgemerkt.
- Wie bei M2/M3 noch nicht gegen das echte OpenAI-Modell getestet.
