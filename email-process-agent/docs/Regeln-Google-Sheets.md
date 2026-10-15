# Kunden-Regeln in Google Sheets

Kunden pflegen ihre Regeln selbst in einem Google Sheet. Alle 15 Minuten prüft „EPA-09 Regeln aus Google Sheets“ das Sheet und übernimmt die Änderungen.

## Was der Kunde ändern kann

Der **Reiter „Allgemein“** hat eine Zeile je Einstellung und die Spalten Einstellung, Wert und Erklärung:

| Bereich | Einstellungen |
|---|---|
| Texte | Anrede, Sprache, Signatur, KI-Hinweis, je Fremdsprache Signatur und KI-Hinweis, z. B. „Signatur (en)“ |
| Fristen | Antwortfrist, Frist nur in Geschäftszeiten, maximale Rückfrage-Runden, Erinnerungen, Freigabe-Erinnerung, Gültigkeit der Freigabe-Links |
| Zeiten | Arbeitstage (z. B. „Mo, Di, Mi, Do, Fr“ oder „Mo-Fr“), Geschäftszeit von und bis, Bundesland für Feiertage, zusätzliche freie Tage (TT.MM.JJJJ) |
| Absender | „Absender immer prüfen“, „Absender ignorieren“ (Adressen oder @domain.de, durch Komma getrennt) |
| Postfach | Ordner für aussortierte Mails. Leer heißt: Die Mails bleiben im Posteingang. Mails werden nie gelöscht. |
| Outlook-Markierungen | Name der grünen Markierung „bereit“ und der roten Markierung „Rückfrage“. Leer heißt: keine Markierung. |
| Datenschutz | Aufbewahrung der Daten in Tagen |

Im **Reiter „Pflichtfelder“** steht je Feld eine Zeile mit diesen Spalten:
- Vorgangstyp, Feldname, Anzeigename, Typ (text, plz, datum, zahl, email, telefon, enum), Pflicht (ja/nein)
- Rückfrage-Text, Hinweis für die KI, Erlaubte Werte (nur bei Typ enum, durch Komma getrennt), Reihenfolge, Aktiv (ja/nein)
- je Fremdsprache „Rückfrage-Text (en)“

Neue Zeilen legen ein neues Feld an.

**Nicht im Sheet** (nur der Betreiber ändert das):
- Postfach, Teams-Kanal, Freigeber und Vertreter
- KI-Modell und Prompt-Versionen, Konfidenz-Schwelle
- Anhang-Grenzen, Zeitzone

Diese Einstellungen betreffen Sicherheit oder Technik. Wer das Sheet bearbeiten darf, soll sich nicht selbst als Freigeber eintragen können.

## Sicherheit beim Übernehmen

- **Erst prüfen, dann übernehmen:** Vor dem Übernehmen wird die komplette neue Config geprüft, mit derselben Prüfung wie beim Laden der Config (`src/configValidator.js`).
- **Ein Fehler stoppt alles:** Bei einem einzigen Fehler wird nichts übernommen, und der Agent arbeitet mit den bisherigen Regeln weiter. Die Fehler stehen im **Reiter „Status“**, verständlich formuliert, z. B. „Antwortfrist Kunde (Stunden): "zwei Tage" ist keine Zahl“.
- **Meldung an den Kanal:** Der Kanal wird informiert, wenn Regeln übernommen wurden oder ein **neuer** Fehler auftritt. Derselbe Fehler wird nur einmal gemeldet.
- **Nichts wird gelöscht:** Fehlt ein Pflichtfeld im Sheet, wird es nur deaktiviert.
- **Protokoll:** Jede Übernahme steht im Audit-Log (Typ SYSTEM, mit Liste der Änderungen).
- **Mail-Inhalte gehen nie ins Sheet:** Das Sheet enthält nur Regeln.

## Einrichten

1. Google-Sheets-Credential in n8n anlegen und in „EPA SW Regeln abgleichen“ und „EPA-10 Regel-Sheet anlegen“ zuweisen. Das macht der Deploy-Helfer.
2. „EPA-10 Regel-Sheet anlegen“ mit `{"kunde_id": "<kürzel>"}` aufrufen.
   - Das Sheet wird aus der aktuellen Config erzeugt, und die Sheet-ID landet in `config_sheet`.
   - Ein vorhandenes Sheet wird nie überschrieben.
3. Das Sheet in Google Drive für die Personen des Kunden freigeben, die Regeln ändern dürfen (Bearbeiten).
4. „EPA-09 Regeln aus Google Sheets“ veröffentlichen. Mit `{"kunde_id": "<kürzel>"}` als Aufruf gleicht er sofort ab.

Ein **vorhandenes Sheet** anbinden: Die Sheet-ID (der Teil der URL zwischen `/d/` und `/edit`) in `config_sheet` eintragen. Das Sheet braucht die Reiter „Allgemein“, „Pflichtfelder“ und „Status“ mit dem Aufbau aus EPA-10. Das Google-Konto des Credentials braucht Bearbeitungsrechte, damit der Status geschrieben werden kann.

## Grenzen

- **Übernahme dauert bis zu 15 Minuten:** Änderungen greifen erst nach dem nächsten Lauf, bei manuellem Aufruf sofort.
- **Gleichzeitiges Ändern im Sheet und in der Data Table:** Für die Einstellungen aus dem Sheet gewinnt das Sheet.
- **Excel:** Eine Excel-Datei in OneDrive oder SharePoint wäre über Microsoft Graph ähnlich möglich, ist aber nicht gebaut.
- **Postgres:** Nur die Data-Table-Variante gleicht ab. Die Postgres-Variante hat nur die Spalte `config_sheet` (Migration 005).
