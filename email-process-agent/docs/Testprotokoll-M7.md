# Testprotokoll M7: Fehlerfälle (Graph, Token, KI-Timeout, Textbaustein)

Stand 2026-10-14. Lokale n8n-Instanz 2.43.4, Data Tables, Mock-LLM (skriptgesteuert) und Mock-Graph.
Erzeugt von `tools/e2e-eingang.js` aus `test/daten/testmails.js`.

Das Mock-LLM liefert festgelegte Antworten, der Mock-Graph simuliert Postfach (Entwürfe, Versand, Gesendete Elemente) und Teams-Chats. Geprüft wird damit die Verarbeitungskette, **nicht** die Qualität des echten Modells und nicht das Verhalten der echten Microsoft-APIs. Die Gegenprobe erfolgt in der Cloud-Instanz.

| Nr. | Szenario | erwartet | tatsächlich | bestanden |
|---|---|---|---|---|
| G01 | Graph-API nicht erreichbar (503): Wiederholungen, dann Fehlerlog/Alarm; Mail bleibt unverarbeitet im Postfach, kein Vorgang | Fehlerlog: 503 NICHT_ERREICHBAR; Wiederholt (3 Versuche): 3; Kein Vorgang, kein Dedupe-Eintrag: 0/0; KI nicht aufgerufen: 0; Zweiter Versuch verarbeitet: bereit | Fehlerlog: 503 NICHT_ERREICHBAR; Wiederholt (3 Versuche): 3; Kein Vorgang, kein Dedupe-Eintrag: 0/0; KI nicht aufgerufen: 0; Zweiter Versuch verarbeitet: bereit | ja |
| G02 | Abgelaufenes Token beim Postfach (401): als AUTH_FEHLER gemeldet, kein Vorgang | Fehlerlog: 401 AUTH_FEHLER; Kein Vorgang: 0 | Fehlerlog: 401 AUTH_FEHLER; Kein Vorgang: 0 | ja |
| G03 | LLM-Timeout: 3 Versuche mit Zeitlimit, dann 504 ZEITUEBERSCHREITUNG, Vorgang gesichert (Eskaliert / Manuell) | Fehlerlog: 504 ZEITUEBERSCHREITUNG; KI-Versuche: 3; Vorgang gesichert: Eskaliert / Manuell | Fehlerlog: 504 ZEITUEBERSCHREITUNG; KI-Versuche: 3; Vorgang gesichert: Eskaliert / Manuell | ja |
| G04 | Fehlender Textbaustein in der Config: Konfigurationsfehler (424) mit Alarm, keine geratene Rückfrage, kein Entwurf | Fehlerlog: 424 KONFIGURATIONSFEHLER; Kein Entwurf: 30; Keine Freigabe: 0; Feld genannt: ja | Fehlerlog: 424 KONFIGURATIONSFEHLER; Kein Entwurf: 30; Keine Freigabe: 0; Feld genannt: ja | ja |
| Q01 | KI-Prüfstand (EPA-T1): Klassifizierung und Felder gegen Sollwerte, Ergebnisse gespeichert, keine Vorgänge/Mails | Klassifizierung: 2/2; Felder: Start_PLZ 1r, Ziel_PLZ 1m, Gewicht 1f, Telefon 1r, Abholdatum 1l; KI-Aufrufe (K/E): 2/1; Bericht: ja; Ergebnisse gespeichert: 2; Keine Vorgänge, keine Mails: 148/14 | Klassifizierung: 2/2; Felder: Start_PLZ 1r, Ziel_PLZ 1m, Gewicht 1f, Telefon 1r, Abholdatum 1l; KI-Aufrufe (K/E): 2/1; Bericht: ja; Ergebnisse gespeichert: 2; Keine Vorgänge, keine Mails: 148/14 | ja |

**Ergebnis:** 5 von 5 Szenarien bestanden.
