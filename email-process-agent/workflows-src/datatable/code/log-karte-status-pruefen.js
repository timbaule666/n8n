const e = $input.first().json;
const weiter = ['Bereit zur Bearbeitung', 'Abgeschlossen'].includes(e.neuer_status) && Boolean(e.vorgangs_id) && Boolean(e.kunde_id);
return [{ json: { weiter, kunde_id: e.kunde_id || '', vorgangs_id: e.vorgangs_id || '', neuer_status: e.neuer_status || '' } }];
