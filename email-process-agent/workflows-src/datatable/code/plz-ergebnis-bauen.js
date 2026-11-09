const angefragt = $('PLZ normalisieren').first().json.liste;
const info = {};
for (const p of angefragt) info[p] = { gefunden: false };
let fehler = false;
for (const i of $input.all()) {
  const j = i.json || {};
  if (j.error) { fehler = true; continue; }
  if (j.plz && info[j.plz]) info[j.plz] = { gefunden: true, ort: j.ort || '', bundesland: j.bundesland || '' };
}
return [{ json: { ok: !fehler, plz_info: fehler ? {} : info } }];
