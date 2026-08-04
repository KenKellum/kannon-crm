// Does the agent's catalogue and the client's catalogue still agree?
const fs = require('fs');

function grab(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error('not found: ' + decl);
  const start = src.indexOf(src[i + decl.length] === '[' ? '[' : '{', i + decl.length - 1);
  const open = src[start], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = null, esc = false;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (esc) { esc = false; continue; }
    if (inStr) { if (ch === '\\') esc = true; else if (ch === inStr) inStr = null; continue; }
    // Comments can hold apostrophes, which would look like an opening quote.
    if (ch === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (ch === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (!depth) return eval('(' + src.slice(start, j + 1) + ')'); }
  }
  throw new Error('unbalanced: ' + decl);
}

const crm = fs.readFileSync('C:/kannon-crm/crm.js', 'utf8');
const html = fs.readFileSync('C:/kannon-crm/intake.html', 'utf8');

const A = grab(crm, 'const INTAKE_FIELD_DEFS = ');
const B = grab(html, 'const FIELD_DEFS = ');
const SECS_A = grab(crm, 'const INTAKE_SECTIONS = ');
const SECS_B = grab(html, 'const INTAKE_SECTIONS = ');
const DEF = grab(crm, 'const INTAKE_TYPE_DEFAULTS = ');

const AGENT_ONLY = new Set(['notes_health', 'notes_financial', 'notes_group', 'notes_career']);
let bad = 0;
const fail = (m) => { bad++; console.log('  ✗ ' + m); };

console.log('agent catalogue: ' + Object.keys(A).length + ' fields');
console.log('client catalogue: ' + Object.keys(B).length + ' fields');

console.log('\n1. every agent field reaches the client');
Object.keys(A).forEach(id => {
  if (!B[id] && !AGENT_ONLY.has(id)) fail(id + ' is selectable in the CRM but the client page cannot render it');
});

console.log('2. no client field is unreachable from the CRM');
Object.keys(B).forEach(id => { if (!A[id]) fail(id + ' exists on the client page but no agent can select it'); });

console.log('3. option lists agree');
Object.keys(A).forEach(id => {
  if (!B[id]) return;
  const a = A[id].options, b = B[id].options;
  if (!a && !b) return;
  if (!a || !b) return fail(id + ': one side has options and the other does not');
  if (a.join('|') !== b.join('|')) fail(id + ':\n      CRM    ' + JSON.stringify(a) + '\n      client ' + JSON.stringify(b));
});

console.log('4. the two section lists are identical');
if (SECS_A.length !== SECS_B.length) fail('different section counts: ' + SECS_A.length + ' vs ' + SECS_B.length);
SECS_A.forEach((s, i) => {
  const t = SECS_B[i];
  if (!t) return fail('client is missing section ' + s.key);
  if (s.key !== t.key || s.title !== t.title) fail('section ' + i + ': ' + s.key + '/' + s.title + ' vs ' + t.key + '/' + t.title);
  if (s.ids.join(',') !== t.ids.join(',')) fail('section ' + s.key + ' holds different fields');
});

console.log('5. every field in a section exists, and every field sits in a section');
const placed = new Set();
SECS_A.forEach(s => s.ids.forEach(id => {
  placed.add(id);
  if (!A[id]) fail('section ' + s.key + ' lists ' + id + ', which is not in the catalogue');
  if (A[id] && A[id].section !== s.title) fail(id + '.section is "' + A[id].section + '" but it sits under "' + s.title + '"');
}));
Object.keys(A).forEach(id => {
  if (!placed.has(id) && !/^notes_(financial|group|career)$/.test(id)) fail(id + ' is in the catalogue but no section shows it');
});

console.log('6. every default is a real, renderable field');
Object.entries(DEF).forEach(([type, ids]) => {
  ids.forEach(id => {
    if (!A[id]) fail(type + ' defaults to ' + id + ', which the CRM cannot render');
    else if (!B[id] && !AGENT_ONLY.has(id)) fail(type + ' defaults to ' + id + ', which the client cannot render');
    if (!placed.has(id)) fail(type + ' defaults to ' + id + ', which no section shows');
  });
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dupes.length) fail(type + ' lists twice: ' + dupes.join(', '));
});

console.log('7. the "only ask what applies" rules match');
// Both sides hide the same follow-up questions. If they drift, the agent gets
// asked something the client never was, and the two forms disagree about the
// same client. Compared by normalised source, so a changed condition is caught.
const _fv = () => '', _sepNeeded_ = () => true, _imFv_ = () => '', _imSepNeeded_ = () => true;
const RA = grab(crm, 'const IM_FIELD_RULES = ');
const RB = grab(html, 'const FIELD_RULES = ');
const norm = (fn) => String(fn).replace(/_imFv_/g, '_fv').replace(/_imSepNeeded_/g, '_sepNeeded_')
  .replace(/\s+/g, ' ').trim();
Object.keys(RA).forEach(id => { if (!RB[id]) fail('rule for ' + id + ' exists in the CRM but not on the client page'); });
Object.keys(RB).forEach(id => { if (!RA[id]) fail('rule for ' + id + ' exists on the client page but not in the CRM'); });
Object.keys(RA).forEach(id => {
  if (RB[id] && norm(RA[id]) !== norm(RB[id])) {
    fail(id + ' is hidden under different conditions:\n      CRM    ' + norm(RA[id]) + '\n      client ' + norm(RB[id]));
  }
});

console.log('8. the product catalogue holds together');
// Every product's questions must be real, renderable, and shown by some section.
// Referral products must ask nothing — we don't place them, so asking a client
// for detail would imply a quote we're not going to give.
const PRODS = grab(crm, 'const INTAKE_PRODUCTS = ');
const LINES = grab(crm, 'const CARRIER_LINES = ');
const NEEDS = grab(crm, 'const INTAKE_PRODUCT_NEEDS = ');
const CAPS = new Set(['household', 'gender', 'tobacco', 'covered', 'meds', 'providers',
                      'county', 'hw', 'amount', 'solo']);
const knownLines = new Set(LINES);
const seenKeys = new Set();
Object.keys(NEEDS).forEach(k => {
  if (!PRODS.some(p => p.key === k)) fail('INTAKE_PRODUCT_NEEDS has "' + k + '", which is not a product');
  NEEDS[k].forEach(c => { if (!CAPS.has(c)) fail(k + ' needs unknown capability "' + c + '"'); });
});
PRODS.forEach(p => {
  if (seenKeys.has(p.key)) fail('duplicate product key: ' + p.key);
  seenKeys.add(p.key);
  if (!NEEDS[p.key]) fail(p.key + ' has no entry in INTAKE_PRODUCT_NEEDS — the widgets would not know what to show');
  if (p.referral && (NEEDS[p.key] || []).length) fail('referral product ' + p.key + ' asks for widgets; it should ask for none');
  if (p.referral && p.ids.length) fail('referral product ' + p.key + ' asks ' + p.ids.length + ' question(s) — it should ask none');
  // A product that says it needs the medication or provider picker has to
  // actually ask for it, or the flag is a promise the form never keeps.
  const cap = NEEDS[p.key] || [];
  if (cap.includes('meds') && !p.ids.includes('med_medications')) fail(p.key + " needs 'meds' but never asks med_medications");
  if (cap.includes('providers') && !p.ids.includes('med_doctors')) fail(p.key + " needs 'providers' but never asks med_doctors");
  if (cap.includes('household') && !p.ids.includes('household_members') && p.key !== 'group') {
    fail(p.key + " needs 'household' but never asks household_members");
  }
  (p.lines || []).forEach(l => {
    if (!knownLines.has(l)) fail(p.key + ' maps to line "' + l + '", which is not in CARRIER_LINES');
  });
  p.ids.forEach(id => {
    if (!A[id]) fail(p.key + ' wants ' + id + ', which is not in the catalogue');
    else if (!B[id] && !AGENT_ONLY.has(id)) fail(p.key + ' wants ' + id + ', which the client page cannot render');
    if (!placed.has(id)) fail(p.key + ' wants ' + id + ', which no section shows');
  });
});

console.log('8b. the two copies of the product catalogue agree');
// The client page carries its own copy of the products and their questions so
// that ticking one there actually asks them. Same drift risk as the field
// catalogues, same guard.
const PRODS_B = grab(html, 'const INTAKE_PRODUCTS = ');
const IDS_B   = grab(html, 'const INTAKE_PRODUCT_IDS = ');
const NEEDS_B = grab(html, 'const INTAKE_PRODUCT_NEEDS = ');
const keysA = PRODS.map(p => p.key).join(',');
const keysB = PRODS_B.map(p => p.key).join(',');
if (keysA !== keysB) fail('product keys differ:\n      CRM    ' + keysA + '\n      client ' + keysB);
PRODS.forEach(p => {
  const mine = (IDS_B[p.key] || []).join(',');
  if (mine !== p.ids.join(',')) {
    fail(p.key + ' asks different questions on each side:\n      CRM    ' + p.ids.join(',') + '\n      client ' + mine);
  }
  if ((NEEDS_B[p.key] || []).join(',') !== (NEEDS[p.key] || []).join(',')) {
    fail(p.key + ' needs different widgets on each side');
  }
  const b = PRODS_B.find(x => x.key === p.key);
  if (b && !!b.partner !== !!p.referral) fail(p.key + ': partner/referral flag disagrees between the two files');
});
// The word itself must never reach the client page.
if (/referral/i.test(html)) fail('the word "referral" appears in intake.html — it must not be shown to a client');

console.log('\n9. what each product asks for');
PRODS.forEach(p => {
  console.log('  ' + (p.referral ? '~' : ' ') + ' ' + p.key.padEnd(13)
    + String(p.ids.length).padStart(2) + ' questions   '
    + (p.lines.length ? p.lines.join(', ') : '(no quotable line)'));
});

console.log('\n10. what each intent type asks, in the order it is asked');
Object.entries(DEF).forEach(([type, ids]) => {
  const set = new Set(ids);
  console.log('\n  ' + type + '  (' + ids.length + ' questions)');
  SECS_A.forEach(s => {
    const mine = s.ids.filter(id => set.has(id));
    if (mine.length) console.log('    ' + s.title.padEnd(30) + mine.join(', '));
  });
});

console.log('\n' + (bad ? bad + ' PROBLEM(S)' : 'catalogues agree'));
process.exit(bad ? 1 : 0);
