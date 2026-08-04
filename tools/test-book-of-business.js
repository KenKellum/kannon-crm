// The Book of Business — the client list that replaces an Active Client column
// filling with every client the agency has ever written.
//
// The filters and the grouping are the whole value of the page: an agent asks
// "who is in force", "what ends soon", "who has a Blue Cross plan", and the
// answer has to be right without anybody maintaining a status by hand. These
// run the real functions out of crm.js against a book spanning every state.
const fs = require('fs');
const src = fs.readFileSync('C:/kannon-crm/crm.js', 'utf8');

function grab(name) {
  const decl = new RegExp('(?:^|\\n)(?:const |function |async function )' + name + '\\b');
  const m = decl.exec(src);
  if (!m) throw new Error('missing ' + name);
  const start = m.index + (m[0][0] === '\n' ? 1 : 0);
  let depth = 0, seen = false;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{' || ch === '[') { depth++; seen = true; }
    else if (ch === '}' || ch === ']') { depth--; if (seen && !depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

global.window = global;
eval(grab('enrollDate_'));
eval(grab('coverageState_'));
eval(grab('RENEWAL_WINDOW_DAYS').replace(/^const /, 'var '));
eval(grab('renewalDueWithin_'));
eval(grab('CLIENT_FILTERS').replace(/^const /, 'var '));
eval(grab('clientsFilter_'));
eval(grab('clientsGroup_'));
eval(grab('clientsDecorate_'));

let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };

// A book with one of everything, including the two states nobody updates by
// hand: a policy that lapsed months ago and one cancelled for a future date.
global.contacts = [
  { id: 'c1', name: 'Shannon Kellum', phone: '406-555-0100' },
  { id: 'c2', name: 'Scott Schweitzer' },
  { id: 'c3', name: 'Aaron Adams' },
];
global.allAgents = [
  { id: 'ag1', display_name: 'Ken Kellum' },
  { id: 'ag2', display_name: 'Second Agent' },
];
const rows = [
  { id: 'e1', contact_id: 'c1', agent_id: 'ag1', line: 'Health — Individual', carrier_name: 'Blue Cross',
    plan_name: 'Bronze POS 205', monthly_premium: 120.50, status: 'active', effective_date: '2026-01-01' },
  { id: 'e2', contact_id: 'c1', agent_id: 'ag1', line: 'Dental/Vision/Hearing', carrier_name: 'Ameritas',
    plan_name: 'PrimeStar Dental', monthly_premium: 29.50, status: 'active', effective_date: '2026-09-01' },
  { id: 'e3', contact_id: 'c1', agent_id: 'ag1', line: 'Life', carrier_name: 'Omaha',
    plan_name: 'Term Life 20yr', monthly_premium: 41.20, status: 'submitted' },
  { id: 'e4', contact_id: 'c2', agent_id: 'ag2', line: 'Accident', carrier_name: 'Blue Cross',
    plan_name: 'Accident Plus', monthly_premium: 12, status: 'active',
    effective_date: '2026-01-01', termination_date: '2026-10-31' },
  { id: 'e5', contact_id: 'c2', agent_id: 'ag2', line: 'Short-Term Medical', carrier_name: 'Y Health',
    plan_name: 'STM 6mo', monthly_premium: 80, status: 'active',
    effective_date: '2025-06-01', termination_date: '2026-03-31', termination_reason: 'moved to a Marketplace plan' },
  { id: 'e6', contact_id: 'c3', agent_id: 'ag1', line: 'Life', carrier_name: 'Omaha',
    plan_name: 'Never Started', monthly_premium: 30, status: 'withdrawn', policy_number: 'ZZ-1' },
];
const T = '2026-08-04';
// The page decorates with today's date; pin it so the test does not rot.
const items = rows.map(r => {
  const st = coverageState_(r, T);
  const c = contacts.find(x => x.id === r.contact_id);
  const a = allAgents.find(x => x.id === r.agent_id);
  return { r, st, name: (c && c.name) || 'Unknown client', contact: c, agent: (a && a.display_name) || '' };
});
const F = (o) => clientsFilter_(items, Object.assign({ filter: '', line: '', carrier: '', agent: '', q: '' }, o));
const names = (list) => list.map(x => x.r.plan_name).sort().join(', ');

// ── 1. the filter chips ──────────────────────────────────────────────────────
console.log('1. each filter answers the question an agent actually asks');
ok(names(F({ filter: 'in_force' })) === 'Accident Plus, Bronze POS 205',
   'In force = started and not ended: ' + names(F({ filter: 'in_force' })));
ok(names(F({ filter: 'pending' })) === 'Term Life 20yr',
   'Applied = still with the carrier: ' + names(F({ filter: 'pending' })));
ok(names(F({ filter: 'starting' })) === 'PrimeStar Dental',
   'Starting = approved, cover not begun: ' + names(F({ filter: 'starting' })));
ok(names(F({ filter: 'ending' })) === 'Accident Plus',
   'Ending = in force with an end date set: ' + names(F({ filter: 'ending' })));
ok(names(F({ filter: 'ended' })) === 'Never Started, STM 6mo',
   'Ended covers both lapsed and never taken: ' + names(F({ filter: 'ended' })));
// The one that matters: a policy cancelled for a future date is BOTH in force
// and ending, and must show under both.
const acc = items.find(x => x.r.id === 'e4');
ok(CLIENT_FILTERS.in_force.test(acc.st, acc.r) && CLIENT_FILTERS.ending.test(acc.st, acc.r),
   'a policy cancelled mid-term is in force AND ending — it appears under both');
ok(!CLIENT_FILTERS.ended.test(acc.st, acc.r), 'and it is not filed as already ended');
ok(F({ filter: '' }).length === 6, 'Everything shows all six');

// ── 2. the other filters ─────────────────────────────────────────────────────
console.log('\n2. narrowing down');
ok(names(F({ carrier: 'Blue Cross' })) === 'Accident Plus, Bronze POS 205', 'by carrier');
ok(names(F({ line: 'Life' })) === 'Never Started, Term Life 20yr', 'by coverage type');
ok(F({ agent: 'ag2' }).length === 2, 'by the agent who wrote it — what a broker needs');
ok(names(F({ q: 'shannon' })) === 'Bronze POS 205, PrimeStar Dental, Term Life 20yr',
   'search finds a client by name');
ok(names(F({ q: 'ameritas' })) === 'PrimeStar Dental', 'search finds a carrier');
ok(names(F({ q: 'zz-1' })) === 'Never Started', 'search finds a policy number, case-insensitively');
ok(F({ q: 'nothing at all' }).length === 0, 'and finds nothing when there is nothing');
ok(names(F({ filter: 'in_force', carrier: 'Blue Cross', line: 'Accident' })) === 'Accident Plus',
   'filters combine rather than override each other');

// ── 3. grouped by person ─────────────────────────────────────────────────────
console.log('\n3. grouped by person, because that is how an agent thinks');
const groups = clientsGroup_(F({ filter: '' }), 'name');
ok(groups.length === 3, 'three clients out of six products');
ok(groups[0].name === 'Aaron Adams' && groups[2].name === 'Shannon Kellum', 'sorted by name');
const shan = groups.find(g => g.name === 'Shannon Kellum');
ok(shan.rows.length === 3, 'Shannon has three products');
ok(shan.inForce === 1, 'but only one in force');
// Only what is in force counts toward what a client actually pays today.
ok(shan.premium === 120.50,
   'her monthly total counts the in-force plan only, not the pending or future ones: ' + shan.premium);
const scott = groups.find(g => g.name === 'Scott Schweitzer');
ok(scott.premium === 12, 'a lapsed policy adds nothing to the total');
const aaron = groups.find(g => g.name === 'Aaron Adams');
ok(aaron.premium === 0 && aaron.inForce === 0, 'a client with nothing in force totals zero, not NaN');

console.log('\n4. sorting');
ok(clientsGroup_(F({ filter: '' }), 'premium')[0].name === 'Shannon Kellum', 'by premium, biggest first');
// "Next date" is what surfaces the work: whose policy moves soonest.
// Only dates STILL AHEAD count. Shannon's dental starts in September and
// Scott's accident plan ends in October, so she is the sooner of the two;
// Aaron has nothing ahead at all and goes last.
const byNext = clientsGroup_(F({ filter: '' }), 'next');
ok(byNext.map(g => g.name).join(' | ') === 'Shannon Kellum | Scott Schweitzer | Aaron Adams',
   'by next date, soonest thing ahead first: ' + byNext.map(g => g.name + ' ' + (g.next || '-')).join(' | '));
ok(!byNext[0].next || byNext[0].next >= '2026-08-04', 'and a date in the past never sorts as "next"');
ok(clientsGroup_([], 'name').length === 0, 'an empty book groups to nothing rather than throwing');

console.log(bad ? '\n' + bad + ' FAILED' : '\nthe book answers the questions an agent asks of it');
process.exit(bad ? 1 : 0);
