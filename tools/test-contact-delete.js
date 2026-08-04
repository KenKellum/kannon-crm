// Deleting a contact — the rule Ken set on 2026-08-04.
//
// A contact can be deleted with everything attached to them, but ONLY if they
// hold no coverage, no signed Scope of Appointment, no signed HIPAA BAA and no
// locked quote, and never without being shown first what is about to go.
//
// This exercises the real verdict function out of crm.js. The old version of
// deleteContact fired four deletes, checked none of them, and reported success
// either way — the point of testing the verdict rather than the request is that
// the verdict is what decides whether anything runs at all.
const fs = require('fs');
const src = fs.readFileSync('C:/kannon-crm/crm.js', 'utf8');

function grab(name) {
  const decl = new RegExp('(?:^|\\n)(?:const |function |async function )' + name + '\\b');
  const m = decl.exec(src);
  if (!m) throw new Error('missing ' + name);
  const start = m.index + (m[0][0] === '\n' ? 1 : 0);
  // Bracket-aware in both directions: CONTACT_DELETE_ATTACHMENTS is an ARRAY of
  // objects, so counting only braces stops at the end of its first element.
  let depth = 0, seen = false;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{' || ch === '[') { depth++; seen = true; }
    else if (ch === '}' || ch === ']') { depth--; if (seen && !depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

eval(grab('CONTACT_DELETE_ATTACHMENTS').replace(/^const /, 'var '));
eval(grab('contactDeleteSummary_'));

let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
const texts = list => list.map(x => x.text).join(', ');

// ── 1. what stops a delete dead ──────────────────────────────────────────────
console.log('1. the four things that block it outright');
[['enrollments', 'coverage'], ['signedSoas', 'a signed SOA'],
 ['baas', 'a signed HIPAA BAA'], ['lockedQuotes', 'a locked quote']].forEach(([k, what]) => {
  const s = contactDeleteSummary_({ [k]: 1 });
  ok(!!s.blocked, what + ' blocks the delete');
  ok(s.blocked.length === 1, what + ' is named as the reason: ' + (s.blocked ? texts(s.blocked) : '—'));
});
// Terminated coverage counts too. A policy that has ended is still a policy we
// sold, and the count is of records, not of live ones.
ok(!!contactDeleteSummary_({ enrollments: 3 }).blocked, 'coverage of any status blocks it, not only live coverage');
ok(contactDeleteSummary_({ enrollments: 2 }).blocked[0].text === '2 coverage records',
   'the reason is plural when there are several');

// All four at once must all be named, not just the first.
const all4 = contactDeleteSummary_({ enrollments: 1, signedSoas: 2, baas: 1, lockedQuotes: 1 });
ok(all4.blocked.length === 4, 'all four blockers are listed together: ' + texts(all4.blocked));
// A BAA that was only ever REQUESTED is not a record — the count that reaches
// here is already filtered to status 'signed', and an unsigned one must not
// hold a duplicate contact hostage.
ok(!contactDeleteSummary_({ baas: 0 }).blocked, 'an unsigned BAA request does not block anything');

// ── 2. a contact with nothing attached ───────────────────────────────────────
console.log('\n2. a duplicate or a typo');
const empty = contactDeleteSummary_({});
ok(!empty.blocked, 'nothing blocks it');
ok(empty.nothingAttached, 'it is recognised as empty, so it deletes on one click');
ok(!empty.needsTypedName, 'no name to type for a row with nothing on it');
ok(!empty.destroyed.length && !empty.orphaned.length, 'and nothing is listed as going');

// ── 3. what the warning has to say before anything runs ──────────────────────
console.log('\n3. the warning names what goes');
const s = contactDeleteSummary_({
  deals: 2, dealActivities: 14, dealTasks: 3, quotes: 1, intakes: 2,
  activities: 40, providers: 6, medications: 2, censuses: 1,
});
ok(!s.blocked, 'none of this blocks a delete under Ken\'s rule');
ok(!s.nothingAttached, 'but it is not an empty contact either');
ok(s.needsTypedName, 'so the client\'s name has to be typed');
const d = texts(s.destroyed);
ok(/2 deals/.test(d),               'the deals are named: ' + d);
ok(/14 logged calls and notes/.test(d), 'the call log is named — it cascades with the deal');
ok(/3 tasks/.test(d),               'the tasks are named');
ok(/1 quote\b/.test(d),             'the quote is named');
ok(/2 intake forms/.test(d),        'the intake forms are named');
ok(/40 timeline entries/.test(d),   'the whole timeline is named');
ok(/6 doctors and facilities/.test(d), 'the doctors are named');
ok(/2 medications/.test(d),         'the medications are named');
const o = texts(s.orphaned);
ok(/1 employee census/.test(o), 'the census is listed as kept but detached: ' + o);
ok(!/census/.test(d), 'nothing that survives is listed under Destroyed');
ok(!/deal/.test(o),   'nothing that is destroyed is listed under Kept');

// ── 4. the typed-name rule ───────────────────────────────────────────────────
console.log('\n4. when the name has to be typed');
ok(contactDeleteSummary_({ deals: 1 }).needsTypedName,    'a deal means typing the name');
ok(contactDeleteSummary_({ quotes: 1 }).needsTypedName,   'a quote means typing the name');
ok(contactDeleteSummary_({ censuses: 1 }).needsTypedName, 'a census means typing the name');
// A signed BAA no longer reaches this question — it blocks outright.
ok(!!contactDeleteSummary_({ baas: 1 }).blocked, 'a signed BAA never gets as far as typing a name');
// History alone is not a record of business. Requiring the name for a stray
// email open would train Ken to type it without reading.
ok(!contactDeleteSummary_({ activities: 40 }).needsTypedName, 'a timeline on its own does not');
ok(!contactDeleteSummary_({ providers: 6, medications: 2 }).needsTypedName, 'doctors and medications on their own do not');
ok(!contactDeleteSummary_({ intakes: 2 }).needsTypedName, 'an intake form on its own does not');

// ── 5. the catalogue cannot drift from the database ──────────────────────────
console.log('\n5. every attachment has a fate, and the blockers match the database');
CONTACT_DELETE_ATTACHMENTS.forEach(a => {
  ok(['refuse', 'destroyed', 'orphaned'].includes(a.fate), a.key + ' -> ' + a.fate);
  ok(!!a.one && !!a.many, a.key + ' has both singular and plural words: ' + a.one + ' / ' + a.many);
});
// enrollments.contact_id is ON DELETE RESTRICT and the locked-quote trigger
// raises restrict_violation, so those two would fail at the database anyway —
// this list must agree with it or the interface promises something the
// database will refuse.
['enrollments', 'lockedQuotes', 'signedSoas', 'baas'].forEach(k =>
  ok(CONTACT_DELETE_ATTACHMENTS.find(a => a.key === k).fate === 'refuse',
     k + ' is a blocker'));
// Every signed document blocks. If a new one is ever added to the catalogue,
// this is the line that should make somebody think about it.
ok(CONTACT_DELETE_ATTACHMENTS.filter(a => /signed/.test(a.one)).every(a => a.fate === 'refuse'),
   'nothing carrying a signature is left deletable');

console.log(bad ? '\n' + bad + ' FAILED' : '\na client we sold something to cannot be tidied away');
process.exit(bad ? 1 : 0);
