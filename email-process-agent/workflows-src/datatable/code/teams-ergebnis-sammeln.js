const plan = $('Kanäle planen').all().map(function (i) { return i.json; });
const antw = $input.all().map(function (i) { return i.json; });
const k = $('Kunde lesen').first().json;
let b = {};
try { b = JSON.parse(k.benachrichtigung); } catch (e) { b = {}; }
const ids = {};
const fehler = [];
plan.forEach(function (p, i) {
  const a = antw[i] || {};
  const id = p.kanal_id || (a.body && a.body.id ? a.body.id : '');
  if (id) ids[p.art] = id;
  else fehler.push(p.name + ': ' + (a.body && a.body.error ? a.body.error.code + ' ' + a.body.error.message : 'keine Antwort'));
});
if (fehler.length) throw new Error('Kanäle nicht angelegt: ' + fehler.join(' | '));
const nb = Object.assign({}, b, { channel_id: ids.system });
const kunde = $('Kunde eintragen').first().json;
return [{ json: {
  kunde_id: k.kunde_id,
  team_id: b.team_id,
  team_name: kunde.team_name || '',
  kanaele: JSON.stringify(ids),
  log_channel_id: ids.logs,
  benachrichtigung: JSON.stringify(nb),
  kanal_ids: ids,
} }];
