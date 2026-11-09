const k = $('Kunde lesen').first().json;
if (!k || !k.kunde_id) throw new Error('Kunde nicht in epa_config_allgemein gefunden');
let b = {};
try { b = JSON.parse(k.benachrichtigung); } catch (e) { b = {}; }
if (!b.team_id) throw new Error('team_id fehlt in benachrichtigung');
const res = $input.first().json;
if (res.statusCode !== 200) throw new Error('Kanäle konnten nicht gelesen werden: ' + JSON.stringify(res.body).slice(0, 200));
const vorh = (res.body && res.body.value) || [];
// Fünf Kanäle, bei jedem Kunden gleich (Namen und Zuordnung: src/kanaele.js).
const soll = kanaele.KANAELE.map(function (k) { return { art: k.art, name: k.name, text: k.text }; });
function rein(s) { return String(s).replace(/^\d+\s+/, '').toLowerCase(); }
return soll.map(function (s) {
  const f = vorh.find(function (x) { return rein(x.displayName) === rein(s.name); });
  return { json: { team_id: b.team_id, art: s.art, name: s.name, beschreibung: s.text, kanal_id: f ? f.id : '', alt_name: f ? f.displayName : s.name } };
});
