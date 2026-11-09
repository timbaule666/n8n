// Nur Absender/Betreff gleich (schwacher Treffer): bereits übergebene, ungeklärte oder alte Fälle sind keine Kandidaten.
// Starke Hinweise (Message-ID, Vorgangs-ID, Konversation) bleiben immer erhalten.
const e = $('Eingabe prüfen').first().json;
const k = (e && e.daten) || {};
const ids = new Set(k.message_ids || []);
const vids = new Set(k.vorgangs_ids || []);
const ALT_TAGE = 14;
const grenze = Date.now() - ALT_TAGE * 24 * 3600 * 1000;
const fertig = ['Bereit zur Bearbeitung', 'Zuordnung unklar'];
const liste = ($input.first().json.kandidaten || []).filter(function (v) {
  let ml = v.bekannte_message_ids;
  if (typeof ml === 'string') { try { ml = JSON.parse(ml); } catch (x) { ml = []; } }
  const stark = (ml || []).some(function (m) { return ids.has(m); }) || vids.has(v.vorgangs_id) || Boolean(k.conversation_id && v.conversation_id === k.conversation_id);
  if (stark) return true;
  if (fertig.indexOf(v.status) >= 0) return false;
  const t = v.geaendert_am ? new Date(v.geaendert_am).getTime() : 0;
  return t >= grenze;
});
return [{ json: { kandidaten: liste } }];
