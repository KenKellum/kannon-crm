// Do the board and the database still agree about what the stages are?
//
// The database is the source of truth: triggers advance deals at 2am when
// nobody has the CRM open, so pipeline_stages has to know the stage list. But
// crm.js draws the columns, so it keeps its own copy — and two copies of a list
// is exactly how referred employers ended up on a stage the group board had no
// column for. This is the tripwire.
//
//   node tools/check-pipeline-parity.js
//
// Reads the migration rather than the live database, so it needs no
// credentials and runs anywhere.
const fs = require('fs');
const path = require('path');

const crm = fs.readFileSync(path.join(__dirname, '..', 'crm.js'), 'utf8');
const sqlDir = path.join(__dirname, '..', 'supabase', 'migrations');
const sqlFile = fs.readdirSync(sqlDir).filter(f => /pipeline_stages/.test(f)).sort().pop();
if (!sqlFile) { console.error('No pipeline_stages migration found.'); process.exit(1); }
const sql = fs.readFileSync(path.join(sqlDir, sqlFile), 'utf8');

// ── the JS side ─────────────────────────────────────────────────────────────
function grab(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error('not found in crm.js: ' + decl);
  const start = src.indexOf('{', i + decl.length - 1);
  let depth = 0, inStr = null, esc = false;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (esc) { esc = false; continue; }
    if (inStr) { if (ch === '\\') esc = true; else if (ch === inStr) inStr = null; continue; }
    if (ch === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (ch === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return eval('(' + src.slice(start, j + 1) + ')'); }
  }
  throw new Error('unbalanced: ' + decl);
}

const PIPELINES   = grab(crm, 'const PIPELINES = ');
const ENTRY_STAGE = grab(crm, 'const ENTRY_STAGE = ');

// ── the SQL side ────────────────────────────────────────────────────────────
function valuesBlock(table) {
  const m = sql.match(new RegExp('insert into public\\.' + table + '[^;]*?values([^;]*);', 'i'));
  if (!m) throw new Error('no INSERT found for ' + table);
  return m[1];
}
const dbStages = {};           // pipeline -> [stage in sort order]
valuesBlock('pipeline_stages').match(/\('([^']+)','([^']+)',(\d+)\)/g).forEach(t => {
  const [, p, s, n] = t.match(/\('([^']+)','([^']+)',(\d+)\)/);
  (dbStages[p] = dbStages[p] || [])[Number(n)] = s;
});
const dbEntry = {};            // pipeline -> {level: stage}
valuesBlock('pipeline_entry_stages').match(/\('([^']+)','([^']+)','([^']+)'\)/g).forEach(t => {
  const [, p, lvl, s] = t.match(/\('([^']+)','([^']+)','([^']+)'\)/);
  (dbEntry[p] = dbEntry[p] || {})[lvl] = s;
});

// ── compare ─────────────────────────────────────────────────────────────────
let bad = 0;
const fail = m => { bad++; console.log('  ✗ ' + m); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('crm.js pipelines: ' + Object.keys(PIPELINES).length
          + ' | database pipelines: ' + Object.keys(dbStages).length + '  (' + sqlFile + ')\n');

console.log('1. same pipelines on both sides');
Object.keys(PIPELINES).forEach(p => { if (!dbStages[p]) fail(p + ' is drawn by crm.js but the database has no stages for it'); });
Object.keys(dbStages).forEach(p => { if (!PIPELINES[p]) fail(p + ' is in the database but crm.js never draws it'); });

console.log('2. same stages, in the same order');
Object.keys(PIPELINES).forEach(p => {
  if (!dbStages[p]) return;
  if (!eq(PIPELINES[p].stages, dbStages[p])) {
    fail(p + ' stages differ:\n      crm.js: ' + JSON.stringify(PIPELINES[p].stages)
       + '\n      db    : ' + JSON.stringify(dbStages[p]));
  }
});

console.log('3. every entry level points at a stage that pipeline HAS');
Object.entries(ENTRY_STAGE).forEach(([p, levels]) => {
  const stages = (PIPELINES[p] || {}).stages || [];
  Object.entries(levels).forEach(([lvl, st]) => {
    if (!stages.includes(st)) fail(`ENTRY_STAGE.${p}.${lvl} = "${st}" — not a stage of ${p}. This is the bug that hid deals.`);
  });
});

console.log('4. entry levels agree with the database');
Object.entries(ENTRY_STAGE).forEach(([p, levels]) => {
  const db = dbEntry[p]; if (!db) { fail(p + ' has no entry stages in the database'); return; }
  Object.entries(levels).forEach(([lvl, st]) => {
    if (db[lvl] !== st) fail(`${p}.${lvl}: crm.js says "${st}", database says "${db[lvl]}"`);
  });
});

console.log(bad ? `\n${bad} problem(s). The board and the database disagree — fix before deploying.`
                : '\nPASS — the board and the database agree.');
process.exit(bad ? 1 : 0);
