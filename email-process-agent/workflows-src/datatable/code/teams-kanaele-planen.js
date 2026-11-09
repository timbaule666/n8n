const k = $('Kunde lesen').first().json;
if (!k || !k.kunde_id) throw new Error('Kunde nicht in epa_config_allgemein gefunden');
let b = {};
try { b = JSON.parse(k.benachrichtigung); } catch (e) { b = {}; }
if (!b.team_id) throw new Error('team_id fehlt in benachrichtigung');
const res = $input.first().json;
if (res.statusCode !== 200) throw new Error('Kanäle konnten nicht gelesen werden: ' + JSON.stringify(res.body).slice(0, 200));
const vorh = (res.body && res.body.value) || [];
const soll = [
  { art: 'anfragen', name: '1 Vollständige Anfragen', text: 'Anfragen, die vollständig sind und bearbeitet werden können' },
  { art: 'rueckfragen', name: '2 Rückfragen', text: 'Alles, was auf eine Antwort oder Entscheidung wartet' },
  { art: 'system', name: '3 Systemmeldungen', text: 'Warnungen, Eskalationen und Fehler des Agenten' },
  { art: 'logs', name: '4 Logs', text: 'Protokoll: eine Abschlusskarte pro Vorgang' },
];
function rein(s) { return String(s).replace(/^\d+\s+/, '').toLowerCase(); }
return soll.map(function (s) {
  const f = vorh.find(function (x) { return rein(x.displayName) === rein(s.name); });
  return { json: { team_id: b.team_id, art: s.art, name: s.name, beschreibung: s.text, kanal_id: f ? f.id : '', alt_name: f ? f.displayName : s.name } };
});
