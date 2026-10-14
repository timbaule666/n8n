# Testprotokoll Testkanal: Telegram statt Teams (nur interne Tests, nicht für Kunden)

Stand 2026-10-14. Lokale n8n-Instanz 2.43.4, Data Tables, Mock-LLM (skriptgesteuert) und Mock-Graph.
Erzeugt von `tools/e2e-eingang.js` aus `test/daten/testmails.js`.

Das Mock-LLM liefert festgelegte Antworten, der Mock-Graph simuliert Postfach (Entwürfe, Versand, Gesendete Elemente) und Teams-Chats. Geprüft wird damit die Verarbeitungskette, **nicht** die Qualität des echten Modells und nicht das Verhalten der echten Microsoft-APIs. Die Gegenprobe erfolgt in der Cloud-Instanz.

| Nr. | Szenario | erwartet | tatsächlich | bestanden |
|---|---|---|---|---|
| K01 | Testkanal: Meldung über EPA-T2 an Telegram (HTML umgesetzt), kein Teams-Aufruf | gesendet: true; Telegram-Nachrichten: 1; Chat: 700100200; Format: HTML; Text: Vorgang <b>EPA-K01</b>

• Start: Köln

A &amp; B
Ende; Teams/Graph-Aufrufe: 0 | gesendet: true; Telegram-Nachrichten: 1; Chat: 700100200; Format: HTML; Text: Vorgang <b>EPA-K01</b>

• Start: Köln

A &amp; B
Ende; Teams/Graph-Aufrufe: 0 | ja |
| K02 | Testkanal: Telegram lehnt ab (400) -> nicht zugestellt, Fehlerlog, Verarbeitung bricht nicht ab | gesendet: false; Fehlerlog: Telegram-Nachricht senden/502; Meldung bereinigt, ohne Text: ja | gesendet: false; Fehlerlog: Telegram-Nachricht senden/502; Meldung bereinigt, ohne Text: ja | ja |
| K03 | Testkanal: Freigabe-Link per Telegram an die Chat-ID des Freigebers, kein Teams-Chat | gesendet: true; Chat: 700100201; Link: ja; Teams-Chats: 0; ohne Chat-ID: nicht zugestellt, protokolliert: false/ja | gesendet: true; Chat: 700100201; Link: ja; Teams-Chats: 0; ohne Chat-ID: nicht zugestellt, protokolliert: false/ja | ja |
| K04 | Testkanal Ende-zu-Ende: vollständige Anfrage -> Meldung „Bereit“ per Telegram; Anfrage mit Lücke -> Freigabe-Links per Telegram | Ergebnis vollständig: bereit; Meldung an Kanal-Chat: 700100200; Meldung nennt Vorgang: ja; Ergebnis mit Lücke: luecken; Freigabe-Links: 700100200,700100201; Links enthalten: ja; Teams-Chats: 0 | Ergebnis vollständig: bereit; Meldung an Kanal-Chat: 700100200; Meldung nennt Vorgang: ja; Ergebnis mit Lücke: luecken; Freigabe-Links: 700100200,700100201; Links enthalten: ja; Teams-Chats: 0 | ja |
| K05 | Testkanal: Fehler-Alarm von EPA-05 über Telegram (Systemstatus "alarmierung") | Alarm per Telegram: 1; Alarm-Chat: 700100200; Alarm ohne <br>: ja; Hinweis: Vorgang nicht gefunden: ja; keine Folgealarme: 1; Fehlerlog: alarmiert: ja | Alarm per Telegram: 1; Alarm-Chat: 700100200; Alarm ohne <br>: ja; Hinweis: Vorgang nicht gefunden: ja; keine Folgealarme: 1; Fehlerlog: alarmiert: ja | ja |
| K06 | Testkanal: Watchdog prüft Teams nicht, meldet Befund per Telegram | Befund KI: ja; kein Teams-Befund: ja; Meldung per Telegram: 700100200; Zustellung vermerkt: true; Postfach geprüft: ja | Befund KI: ja; kein Teams-Befund: ja; Meldung per Telegram: 700100200; Zustellung vermerkt: true; Postfach geprüft: ja | ja |

**Ergebnis:** 6 von 6 Szenarien bestanden.
