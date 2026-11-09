// Wählt den Teams-Kanal nach dem Anlass der Meldung (feste Zuordnung in src/kanaele.js, bei jedem Kunden gleich).
// Fehlt kanaele in der Config, bleibt der übergebene Kanal (benachrichtigung.channel_id).
const eingabe = $('Eingabe prüfen').first().json;
const row = $input.first().json || {};
const art = kanaele.kanalArt(eingabe.anlass);
const ziel = kanaele.kanalId(row.kanaele, eingabe.anlass);
return [{ json: { ...row, ziel_channel_id: ziel, kanal_art: ziel ? art : 'standard' } }];
