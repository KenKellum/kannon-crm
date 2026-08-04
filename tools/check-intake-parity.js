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

console.log('\n7. what each intent type asks, in the order it is asked');
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
