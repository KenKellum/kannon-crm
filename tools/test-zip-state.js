// zipToState_ decides which rate set a quote is priced against, so it has to be
// right for every ZIP, not almost all of them. Checked against the same data
// that populates zip_places.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'crm.js'), 'utf8');
function grab(name, opener) {
  const i = src.indexOf((name === 'zipToState_' ? 'function ' : 'const ') + name);
  if (i < 0) throw new Error('missing ' + name);
  const close = opener === '[' ? ']' : '}';
  let d = 0;
  for (let j = src.indexOf(opener, i); j < src.length; j++) {
    if (src[j] === opener) d++;
    else if (src[j] === close && --d === 0) return src.slice(i, j + 1);
  }
}
eval(grab('ZIP3_STATE', '[') + ';' + grab('ZIP_STATE_FIX', '{') + ';' + grab('zipToState_', '{'));

const ref = path.join(__dirname, '..', 'tools/.zipref.csv');
if (!fs.existsSync(ref)) { console.log('reference CSV missing — skipping'); process.exit(0); }
let checked = 0, wrong = 0; const ex = [];
for (const line of fs.readFileSync(ref, 'utf8').split('\n').slice(1)) {
  const f = line.split(','); if (f.length < 3) continue;
  const zip = f[0].trim(), st = f[2].trim().toUpperCase();
  if (!/^[0-9]{5}$/.test(zip) || !/^[A-Z]{2}$/.test(st)) continue;
  checked++;
  const g = (zipToState_(zip) || '').toUpperCase();
  if (g !== st) { wrong++; if (ex.length < 10) ex.push(zip + ' -> ' + (g || '(none)') + ', want ' + st); }
}
console.log('ZIPs checked: ' + checked + '   wrong: ' + wrong);
ex.forEach(e => console.log('  ' + e));
// Leading-zero ZIPs are the trap: an unquoted 00501 key is read as octal.
['00501','06390','20101','59718','90210'].forEach(z =>
  console.log('  spot ' + z + ' -> ' + zipToState_(z)));
console.log(wrong ? wrong + ' WRONG' : 'every ZIP maps to the right state');
process.exit(wrong ? 1 : 0);
