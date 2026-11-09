const roh = $input.first().json.plz_liste;
const liste = Array.isArray(roh) ? roh : [];
const sauber = [];
for (const x of liste) {
  const s = String(x === null || x === undefined ? '' : x).trim();
  if (/^[0-9]{5}$/.test(s) && !sauber.includes(s)) sauber.push(s);
}
const l = sauber.slice(0, 3);
return [{ json: { liste: l, p1: l[0] || '00000x', p2: l[1] || '00000x', p3: l[2] || '00000x' } }];
