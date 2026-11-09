// Wählt den Teams-Kanal nach Meldungsart. Fehlt kanaele in der Config, bleibt der übergebene Kanal.
const eingabe = $('Eingabe prüfen').first().json;
const row = $input.first().json || {};
let kanaele = {};
try { kanaele = typeof row.kanaele === 'string' && row.kanaele ? JSON.parse(row.kanaele) : (row.kanaele || {}); } catch (e) { kanaele = {}; }
const html = String(eingabe.nachricht_html || '');
const titel = (html.split(/<br\s*\/?>|<\/b>/i)[0] || '').replace(/<[^>]+>/g, '').toLowerCase();
let art = 'system';
if (/anfrage vollständig|bereit zur bearbeitung|terminanfrage – kalender geprüft/.test(titel)) art = 'anfragen';
else if (/neue anfrage|pflichtangaben fehlen|rückfrage direkt|kunde reagiert nicht|maximale anzahl rückfragen|stornierung|absage|antwort eingegangen/.test(titel)) art = 'rueckfragen';
const ziel = kanaele[art] || '';
return [{ json: { ...row, ziel_channel_id: ziel, kanal_art: ziel ? art : 'standard' } }];
