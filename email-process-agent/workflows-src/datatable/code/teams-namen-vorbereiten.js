const e = $('Ergebnis sammeln').first().json;
const plan = $('Kanäle planen').all().map(function (i) { return i.json; });
return plan.map(function (p) {
  return { json: { url: 'https://graph.microsoft.com/v1.0/teams/' + e.team_id + '/channels/' + e.kanal_ids[p.art], name: p.name } };
});
