'use strict';
// Erzeugt den Inhalt des Google Sheets "EPA Kunden-Einrichtung (Vorlage)" (alle Einstellungen, Bereichs-Schalter,
// Pflichtfelder, Checkliste) als Body für die Google Sheets API: config/vorlagen/kunden-einrichtung-sheet.json
// ({ body: spreadsheets.create, requests: spreadsheets.batchUpdate }). Aufruf: node tools/kunden-einrichtung-sheet.js
const path = require('path');
const R = path.join(__dirname, '..') + '/';
const cs = require(R + 'src/configSheet.js');
const cv = require(R + 'src/configValidator.js');
const bsp = require(R + 'config/datatables/beispiel-transport.json');
const a = { ...bsp.epa_config_allgemein[0] };
// Live-Stand (epa-m365) für Vorgangsarten und englische Texte
a.vorgangsarten = JSON.stringify({"transport":{"name":"Angebotsanfrage","beschreibung":"Kunde möchte einen Preis oder ein Angebot für einen Transport (Abholung, Ziel, Ware, Termin)."},"bestellung":{"name":"Bestellung","beschreibung":"Kunde bestellt oder beauftragt verbindlich Ware oder eine Leistung, z. B. mit Menge, Liefertermin, Lieferadresse oder Bestellnummer."},"termin":{"name":"Terminanfrage","beschreibung":"Kunde möchte eine Besprechung, Besichtigung oder Beratung vereinbaren, verschieben oder anfragen. Anlieferungen, Abholungen und Lieferfenster sind keine Terminanfragen."},"reklamation":{"name":"Reklamation","beschreibung":"Kunde bemängelt eine bereits erhaltene Lieferung oder Leistung: Ware beschädigt, defekt, falsch, unvollständig oder verspätet. Keine Stornierung und keine neue Bestellung."}});
const UE = {"en":{"signatur":"Kind regards\nYour dispatch team\n<Company>","ki_hinweistext":"This message was prepared with AI assistance and reviewed and approved by a member of staff.","textbausteine":{"Start_PLZ":"Please let us know the postcode of the pickup location.","Start_Ort":"Please let us know the pickup location (town/city).","Ziel_PLZ":"Please let us know the postcode of the delivery location.","Ziel_Ort":"Please let us know the delivery location (town/city).","Abholdatum":"Please let us know the requested pickup date.","Gewicht_kg":"Please let us know the approximate total weight of the shipment in kilograms.","Packstuecke":"Please let us know the number of packages.","Ladungsart":"Please briefly describe the type of goods.","Ansprechpartner":"Please name a contact person for any questions.","Telefon":"Please provide a phone number for any questions.","Bestellgegenstand":"Please let us know which goods or services you would like to order.","Menge":"Please let us know the quantity you need.","Bestellnummer":"Please let us know your order number, if available.","Liefertermin":"Please let us know the requested delivery date.","Liefer_PLZ":"Please let us know the postcode of the delivery address.","Liefer_Ort":"Please let us know the town/city of the delivery address.","Terminanlass":"Please let us know what the appointment is about.","Wunschtermin":"Please let us know your preferred date.","Uhrzeit":"Please let us know a suitable time.","Terminort":"Please let us know where the appointment should take place.","Reklamationsgrund":"Please briefly describe what exactly is wrong (e.g. damaged, wrong goods, missing quantity, late).","Betroffene_Ware":"Please let us know which goods or services are affected and the quantity.","Lieferdatum":"Please let us know when the delivery or service took place.","Referenznummer":"Please let us know the delivery note, order or job number, if available."}}};
a.uebersetzungen = JSON.stringify(UE);
const pf = bsp.epa_config_pflichtfelder;
const arten = JSON.parse(a.vorgangsarten);
const J = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || '{}'); } catch { return {}; } };

const T = []; // tabs
const IPS = { red: 0.16, green: 0.45, blue: 0.85 }, KUNDE = { red: 0.2, green: 0.62, blue: 0.35 }, INFO = { red: 0.45, green: 0.45, blue: 0.5 };
function tab(id, title, rows, farbe, breiten, opts = {}) { T.push({ id, title, rows, farbe, breiten, ...opts }); }

tab(0, 'Anleitung', [
 ['Email Process Agent – Einrichtung eines Kunden', ''],
 ['Stand', '16.11.2026 · Intelligent Process Solutions'],
 ['', ''],
 ['Wofür', 'Alle Einstellungen, Schalter und Regeln, die für einen neuen Kunden festgelegt werden. Vorbelegt mit den bewährten Werten des Testkunden (Transport); <spitze Klammern> sind Platzhalter.'],
 ['Blaue Reiter', 'Füllt IPS aus (Technik, Freischaltung, Sicherheit). Der Kunde sieht sie nicht im Regel-Sheet.'],
 ['Grüne Reiter', 'Klärt IPS mit dem Kunden im Workshop. Nach dem Start pflegt der Kunde diese Regeln selbst im Regel-Sheet (EPA-10/EPA-09).'],
 ['', ''],
 ['Reihenfolge', '1. Gebuchte Bereiche festlegen → 2. Allgemein mit dem Kunden klären → 3. Pflichtfelder der gebuchten Bereiche durchgehen → 4. Kunde & Technik ausfüllen → 5. Checkliste abarbeiten'],
 ['Übertrag in den Agenten', 'Die Werte werden in die n8n Data Tables epa_config_allgemein (eine Zeile) und epa_config_pflichtfelder (eine Zeile je Feld) übertragen. Spaltennamen stehen jeweils in der Spalte „Spalte in n8n“. Dieses Sheet selbst wird vom Agenten nicht gelesen.'],
 ['Wichtig', 'Nur Bereiche mit „Ja“ werden erkannt. Regeln nicht gebuchter Bereiche dürfen ausgefüllt bleiben (werden erst beim Einschalten streng geprüft). Ein eingeschalteter Bereich mit unvollständigen Regeln macht die Config ungültig (Alarm E-401).'],
 ['Keine Geheimnisse', 'Keine Passwörter, Tokens oder Schlüssel in dieses Sheet. Zugänge werden nur als n8n-Credentials hinterlegt.'],
], INFO, [220, 900]);

tab(1, '1 Gebuchte Bereiche', [
 ['Bereich', 'Gebucht', 'Was der Agent in diesem Bereich tut', 'Spalte in n8n'],
 ['Angebotsanfragen', 'Ja', 'Erkennt Anfragen nach Preis/Angebot, liest Abhol- und Zielort, Datum, Gewicht, Ladung und Kontakt aus, prüft PLZ/Ort, fragt Fehlendes nach.', 'bereich_angebot'],
 ['Bestellungen', 'Ja', 'Erkennt verbindliche Bestellungen, liest Ware, Menge, Liefertermin, Lieferadresse und Kontakt aus. Stornierungen gehen nach „Bitte ansehen“.', 'bereich_bestellung'],
 ['Terminanfragen', 'Ja', 'Erkennt Terminwünsche, prüft den Outlook-Kalender des Postfachs und schlägt freie Zeiten vor. Eingetragen wird erst nach Klick.', 'bereich_termin'],
 ['Reklamationen', 'Ja', 'Erkennt Beanstandungen, liest Grund, Ware, Lieferdatum und Kontakt aus. Rückfragen versprechen nie Ersatz, Gutschrift oder Erstattung.', 'bereich_reklamation'],
 ['', '', '', ''],
 ['Hinweis', '', 'Schalter setzt nur IPS (Data Table). Der Kunde sieht die Bereiche im Regel-Sheet unter „Status“ nur zur Info. Später dazubuchen = auf Ja setzen.', ''],
], IPS, [200, 100, 700, 180], { dropdown: [{ col: 1, r0: 1, r1: 5, werte: ['Ja', 'Nein'] }] });

const allg = cs.sheetInhalt(a, pf).Allgemein;
const SPALTE = Object.fromEntries(cs.EINSTELLUNGEN.map((e) => [e[1], e[0]]));
tab(2, '2 Allgemein (Kunde)', [['Einstellung', 'Wert', 'Erklärung', 'Spalte in n8n'], ...allg.slice(1).map((r) => [r[0], r[1], r[2], SPALTE[r[0]] || (r[0].startsWith('Signatur (') || r[0].startsWith('KI-Hinweis (') ? 'uebersetzungen' : '')])], KUNDE, [260, 320, 520, 200]);

const BER = (t) => (cv.bereichVonTyp(t) || {}).name || t;
const pfz = [['Bereich', 'Vorgangstyp', 'Feldname', 'Anzeigename', 'Typ', 'Pflicht', 'Rückfrage-Text (wortgleich an den Kunden)', 'Rückfrage-Text (en)', 'Hinweis für die KI', 'Erlaubte Werte', 'Prüfregel (JSON)', 'Reihenfolge', 'Gruppe', 'Kurzname', 'Aktiv']];
for (const z of pf) {
 const regel = J(z.validierungsregel);
 pfz.push([BER(z.vorgangstyp), z.vorgangstyp, z.feldname, z.anzeigename, z.typ, z.pflicht ? 'Ja' : 'Nein', z.resolution_textbaustein, UE.en.textbausteine[z.feldname] || '', z.extraktions_hinweis || '', Array.isArray(regel.werte) ? regel.werte.join(', ') : '', Object.keys(regel).length ? JSON.stringify(regel) : '', z.reihenfolge, z.gruppe || '', z.kurzname || '', z.aktiv === false ? 'Nein' : 'Ja']);
}
tab(3, '3 Pflichtfelder (Kunde)', pfz, KUNDE, [140, 110, 150, 200, 80, 70, 380, 320, 320, 160, 220, 90, 120, 140, 70], { dropdown: [{ col: 4, r0: 1, r1: pfz.length - 1, werte: cv.FELDTYPEN }, { col: 5, r0: 1, r1: pfz.length - 1, werte: ['Ja', 'Nein'] }, { col: 14, r0: 1, r1: pfz.length - 1, werte: ['Ja', 'Nein'] }, { col: 0, r0: 1, r1: pfz.length - 1, werte: cv.BEREICHE.map((b) => b.name) }] });

tab(4, '4 Vorgangsarten (KI)', [['Vorgangstyp', 'Bereich', 'Name in Meldungen', 'Beschreibung für die KI (entscheidet die Erkennung)', 'Spalte in n8n'], ...Object.entries(arten).map(([k, v]) => [k, BER(k), v.name, v.beschreibung, 'vorgangsarten'])], IPS, [120, 160, 180, 700, 140]);

const kal = J(bsp.epa_config_allgemein[0].kalender);
tab(5, '5 Kalender (Termine)', [['Einstellung', 'Wert', 'Erklärung'],
 ['Kalenderprüfung', 'Ja', 'Nur wirksam, wenn der Bereich Terminanfragen gebucht ist. Geprüft wird nur der Kalender des Postfachs.'],
 ['Feld Datum', kal.datum_feld, 'Feldname aus den Pflichtfeldern (Typ datum)'],
 ['Feld Uhrzeit', kal.uhrzeit_feld, 'optional'], ['Feld Titel', kal.titel_feld, 'optional, wird Titel des Kalendereintrags'], ['Feld Ort', kal.ort_feld, 'optional'],
 ['Dauer (Minuten)', String(kal.dauer_minuten), '15–480'], ['Vorschlag gültig (Stunden)', String(kal.gueltig_stunden), 'So lange kann der Termin per Klick eingetragen werden'],
 ['', '', ''], ['Spalte in n8n', 'kalender', 'JSON, z. B. {"aktiv": true, "vorgangstyp": "termin", "datum_feld": "Wunschtermin", …}'],
], IPS, [220, 200, 650], { dropdown: [{ col: 1, r0: 1, r1: 1, werte: ['Ja', 'Nein'] }] });

const llm = J(a.llm_profil);
tab(6, '6 Kunde & Technik (IPS)', [['Einstellung', 'Wert', 'Erklärung', 'Spalte in n8n'],
 ['Kunden-Kürzel', '<kunden-kuerzel, z. B. mueller-logistik>', 'Eindeutig, klein, ohne Leerzeichen. Verbindet alle Tabellen.', 'kunde_id'],
 ['Kunde aktiv', 'Nein', 'Erst nach erfolgreichem Test auf Ja.', 'aktiv'],
 ['Überwachtes Postfach', '<anfragen@kunde.de>', 'Shared Mailbox empfohlen.', 'postfach'],
 ['Postfach-Workflow', '<ID der EPA-00-Kopie>', 'Kopie der Postfach-Vorlage, Microsoft-Credentials des Kunden darin.', 'postfach_workflow_id'],
 ['Freigeber', '<freigeber@kunde.de>', 'Microsoft-365-Konten, die Rückfragen freigeben dürfen (mehrere mit Komma).', 'freigeber'],
 ['Vertreter', '', 'Optional, dürfen ebenfalls freigeben.', 'vertreter'],
 ['Teams-Team-ID', '<GUID aus dem Team-Link>', 'Danach „EPA SW Teams einrichten“ ausführen: legt die 6 Kanäle an und trägt sie ein.', 'benachrichtigung.team_id / kanaele'],
 ['Meldungen über', 'teams', 'Bei Kunden immer teams (telegram_test nur intern).', 'benachrichtigung.kanal'],
 ['Zeitzone', a.zeitzone, '', 'zeitzone'],
 ['KI-Sicherheit (Konfidenz)', String(a.konfidenz_schwelle), 'Darunter gilt die Erkennung als unsicher → „Bitte ansehen“.', 'konfidenz_schwelle'],
 ['Prompt-Versionen', '{"klassifizierung":"v5","extraktion":"v2","entwurf":"v1"}', 'Aktueller Stand des Testkunden.', 'prompt_versionen'],
 ['KI-Modell', (llm.klassifizierung || {}).modell || '', 'Für alle drei Aufgaben (Erkennung, Auslesen, Entwurf).', 'llm_profil'],
 ['Zuordnung Antworten', a.zuordnung_schwellen, 'Schwellen, ab wann eine Antwort einem Vorgang zugeordnet wird.', 'zuordnung_schwellen'],
 ['Anhänge', 'max. 10 MB je Anhang, 25 MB je Mail; PDF, Bilder, Word', '', 'anhang_limits'],
 ['Leere Antwort: Frist verlängern (Stunden)', String(a.leerantwort_fristverlaengerung_stunden), '', 'leerantwort_fristverlaengerung_stunden'],
 ['Stille-Alarm (Geschäftsstunden)', '24', 'Hinweis, wenn so lange keine Mail kam (0 = aus).', 'stille_alarm_stunden'],
 ['Outlook-Markierungen', 'AI Geprüft (grün), AI Rückfragen (rot), AI Wartet (gelb)', 'Kann der Kunde im Regel-Sheet ändern.', 'outlook_kategorien'],
 ['Regel-Sheet des Kunden', '<wird von EPA-10 eingetragen>', 'Google-Sheet-ID; der Kunde pflegt dort die grünen Reiter.', 'config_sheet'],
 ['Gebuchte Bereiche', 'siehe Reiter „1 Gebuchte Bereiche“', '', 'bereich_angebot … bereich_reklamation'],
 ['Zugänge (nur als n8n-Credentials)', 'Outlook + Teams des Dienstkontos, OpenAI, Google Sheets', 'Niemals hier eintragen.', '–'],
], IPS, [280, 380, 520, 260], { dropdown: [{ col: 1, r0: 2, r1: 2, werte: ['Ja', 'Nein'] }] });

const ck = [['Erledigt', 'Schritt', 'Details'],
 ...[
 ['Workshop: gebuchte Bereiche und Regeln geklärt', 'Reiter 1–3'],
 ['AVV / Datenschutzunterlagen unterschrieben', 'Datenschutz-und-KI-Checkliste'],
 ['Dienstkonto + Shared Mailbox beim Kunden eingerichtet', 'Vollzugriff nur auf das Postfach'],
 ['Team angelegt, Team-ID eingetragen', 'Reiter 6'],
 ['Config-Zeile in epa_config_allgemein angelegt (aktiv = Nein)', 'inkl. Bereichs-Schalter'],
 ['Pflichtfelder in epa_config_pflichtfelder übertragen', 'eine Zeile je Feld'],
 ['Postfach-Workflow kopiert, Credentials zugewiesen, ID eingetragen', 'aus der aktuellen Postfach-Kopie, nicht aus der veralteten Cloud-Vorlage'],
 ['„EPA SW Teams einrichten“ ausgeführt (6 Kanäle)', ''],
 ['„EPA SW Config laden“ ohne Fehler', 'nach jeder Änderung der Schalter wiederholen'],
 ['Zustelltest (EPA-11) bestanden', ''],
 ['Testmails je gebuchtem Bereich: vollständig, mit Lücken, Antwort', 'nur Testdaten'],
 ['Regel-Sheet angelegt (EPA-10) und für den Kunden freigegeben', 'optional'],
 ['Kunde aktiv = Ja, Postfach-Kopie veröffentlicht', 'Scharf schalten'],
 ['Erste Tagesübersicht (EPA-13) gezeigt', ''],
 ].map(([s, d]) => ['FALSE', s, d])];
tab(7, 'Checkliste', ck, INFO, [90, 520, 520], { checkbox: { col: 0, r0: 1, r1: ck.length - 1 } });

// ---- Google Sheets API
const zelle = (v, i, ri) => { const s = String(v ?? ''); if (s === 'TRUE' || s === 'FALSE') return { userEnteredValue: { boolValue: s === 'TRUE' } }; return { userEnteredValue: { stringValue: s } }; };
const body = { properties: { title: 'EPA Kunden-Einrichtung (Vorlage)', locale: 'de_DE' }, sheets: T.map((t, idx) => ({ properties: { sheetId: t.id, index: idx, title: t.title, tabColor: t.farbe, gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: t.rows.map((r) => ({ values: r.map(zelle) })) }] })) };
const req = [];
for (const t of T) {
 const n = t.rows[0].length;
 req.push({ repeatCell: { range: { sheetId: t.id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n }, cell: { userEnteredFormat: { backgroundColor: t.farbe, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)' } });
 req.push({ repeatCell: { range: { sheetId: t.id, startRowIndex: 1, endRowIndex: t.rows.length, startColumnIndex: 0, endColumnIndex: n }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' } });
 t.breiten.forEach((px, i) => req.push({ updateDimensionProperties: { range: { sheetId: t.id, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } }));
 for (const d of t.dropdown || []) req.push({ setDataValidation: { range: { sheetId: t.id, startRowIndex: d.r0, endRowIndex: d.r1 + 1, startColumnIndex: d.col, endColumnIndex: d.col + 1 }, rule: { condition: { type: 'ONE_OF_LIST', values: d.werte.map((w) => ({ userEnteredValue: w })) }, strict: true, showCustomUi: true } } });
 if (t.checkbox) req.push({ setDataValidation: { range: { sheetId: t.id, startRowIndex: t.checkbox.r0, endRowIndex: t.checkbox.r1 + 1, startColumnIndex: t.checkbox.col, endColumnIndex: t.checkbox.col + 1 }, rule: { condition: { type: 'BOOLEAN' } } } });
}
// Anleitung: Titel groß, erste Spalte fett
req.push({ repeatCell: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: 11, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } });
// Pflichtfelder: Bereiche farbig absetzen
const farbe = { Angebotsanfragen: { red: 0.9, green: 0.95, blue: 1 }, Bestellungen: { red: 0.9, green: 0.98, blue: 0.92 }, Terminanfragen: { red: 0.95, green: 0.93, blue: 1 }, Reklamationen: { red: 1, green: 0.95, blue: 0.88 } };
pfz.slice(1).forEach((r, i) => req.push({ repeatCell: { range: { sheetId: 3, startRowIndex: i + 1, endRowIndex: i + 2, startColumnIndex: 0, endColumnIndex: pfz[0].length }, cell: { userEnteredFormat: { backgroundColor: farbe[r[0]] } }, fields: 'userEnteredFormat.backgroundColor' } }));
require('fs').writeFileSync(R + 'config/vorlagen/kunden-einrichtung-sheet.json', JSON.stringify({ body, requests: req }));
console.log(T.map((t) => t.title + ':' + t.rows.length).join(' | '), JSON.stringify({ body, requests: req }).length);
