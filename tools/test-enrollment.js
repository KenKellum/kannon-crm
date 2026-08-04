// Enrollment — the rules that decide what a client is recorded as having.
//
// The database guards (a locked quote is read-only, one enrollment per option,
// a terminated policy needs an end date) are proved against the real database
// by probe; those cannot be reached from here. What IS here is the code that
// decides what the agent sees and what gets written: the enrolled/waived
// choice, the live summary, the stage each pipeline lands on, and the coverage
// list that the client portal will mirror.
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
    if (ch === '{') { depth++; seen = true; }
    else if (ch === '}') { depth--; if (seen && !depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// ── a DOM small enough to hold a form ────────────────────────────────────────
const nodes = {};
let checkedRadio = {};
function node(id) {
  if (!nodes[id]) nodes[id] = { id, value: '', checked: false, innerHTML: '', style: {}, textContent: '' };
  return nodes[id];
}
global.document = {
  getElementById: id => nodes[id] || null,
  querySelector: sel => {
    const m = /input\[name="enroll-(\d+)"\]:checked/.exec(sel);
    if (!m) return null;
    const v = checkedRadio[m[1]];
    return v ? { value: v } : null;
  },
};
function pick(i, v) { checkedRadio[i] = v; }

eval(grab('escWeb'));
eval(grab('PIPELINES').replace(/^const /, 'var '));
eval(grab('ENROLLMENT_STATUS').replace(/^const /, 'var '));
eval(grab('ENROLL_STAGE').replace(/^const /, 'var '));
eval(grab('enrollMoney_'));
eval(grab('enrollDate_'));
eval(grab('enrollPick_'));
eval(grab('enrollSummary_'));
eval(grab('enrollRowChanged_'));
eval(grab('coverageListHtml_'));

let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };

// ── 1. every pipeline that can enrol lands somewhere real ────────────────────
console.log('1. the stage a deal moves to on enrollment');
Object.entries(ENROLL_STAGE).forEach(([pipe, stage]) => {
  const stages = (PIPELINES[pipe] || {}).stages || [];
  ok(stages.includes(stage), pipe + ' -> "' + stage + '" is a real stage in that pipeline');
  ok(stages.indexOf(stage) > 0, pipe + ' -> "' + stage + '" is not the first stage');
});
// Every client-facing pipeline needs an answer. Recruiting ones must not have
// one — an agent is not enrolled in coverage.
Object.keys(PIPELINES).forEach(p => {
  if (p.startsWith('agent-')) ok(!ENROLL_STAGE[p], p + ' has no enrollment stage, and should not');
  else ok(!!ENROLL_STAGE[p], p + ' has an enrollment stage');
});
// Forward-only: enrolling must never drag a deal backwards.
const forwardOnly = (pipe, from) => {
  const stages = PIPELINES[pipe].stages;
  return stages.indexOf(from) >= stages.indexOf(ENROLL_STAGE[pipe]);
};
ok(forwardOnly('individual-family', 'Active Client'), 'an Active Client is not pulled back to Enrolled');
ok(forwardOnly('medicare', 'Annual Review'), 'a Medicare deal at Annual Review stays there');
ok(!forwardOnly('individual-family', 'Quoted'), 'a Quoted deal does move up to Enrolled');

// ── 2. the enrolled / waived choice ──────────────────────────────────────────
console.log('\n2. what the agent picks is what gets written');
window = global;
window._enrollOpts = [
  { id: 'o1', display_name: 'Bronze POS 205', monthly_premium: 120.5 },
  { id: 'o2', display_name: 'Dental',         monthly_premium: 29.5 },
  { id: 'o3', display_name: 'Term Life',      monthly_premium: 40 },
];
node('enroll-summary');
[0, 1, 2].forEach(i => { node('enroll-row-' + i); node('enroll-detail-' + i); node('enroll-why-' + i); });

pick(0, 'enrolled'); pick(1, 'waived'); pick(2, 'enrolled');
[0, 1, 2].forEach(enrollRowChanged_);
ok(enrollPick_(0) === 'enrolled' && enrollPick_(1) === 'waived', 'each row reports its own answer');
// An unanswered row must read as waived, never as enrolled by accident.
checkedRadio = {};
ok(enrollPick_(0) === 'waived', 'an unanswered product defaults to waived, not enrolled');

pick(0, 'enrolled'); pick(1, 'waived'); pick(2, 'enrolled');
[0, 1, 2].forEach(enrollRowChanged_);
ok(nodes['enroll-detail-0'].style.display === 'flex', 'enrolled shows the effective-date fields');
ok(nodes['enroll-why-0'].style.display === 'none',    'enrolled hides the "why not" box');
ok(nodes['enroll-detail-1'].style.display === 'none', 'waived hides the effective-date fields');
ok(nodes['enroll-why-1'].style.display === 'block',   'waived asks why they passed');

console.log('\n3. the summary tells the truth before the lock goes on');
const sum = nodes['enroll-summary'].innerHTML;
ok(/Enrolling in <strong>2<\/strong> of 3/.test(sum), 'counts 2 of 3: ' + sum.replace(/<[^>]+>/g, ''));
ok(sum.includes('$160.50/mo'), 'adds the premiums of the enrolled ones only');
pick(0, 'waived'); pick(2, 'waived');
[0, 1, 2].forEach(enrollRowChanged_);
ok(/all 3 products recorded as waived/.test(nodes['enroll-summary'].innerHTML),
   'all-waived says so plainly, and still locks');

// ── 4. money and dates ───────────────────────────────────────────────────────
console.log('\n4. formatting');
ok(enrollMoney_(0) === '$0.00', 'a free product is $0.00, not blank');
ok(enrollMoney_(null) === '',   'a missing premium prints nothing rather than $NaN');
ok(enrollMoney_('12.3') === '$12.30', 'a numeric string still formats');
ok(enrollDate_('2026-03-01').includes('Mar 1, 2026'), 'a date column does not slip a day: ' + enrollDate_('2026-03-01'));
ok(enrollDate_(null) === '', 'no date prints nothing');

// ── 5. the coverage list — what the portal will mirror ───────────────────────
console.log('\n5. the coverage list');
ok(coverageListHtml_([]).includes('Nothing enrolled yet'), 'an empty list explains itself');
const html = coverageListHtml_([
  { plan_name: 'Bronze POS 205', carrier_name: 'BCBS', line: 'Health — Individual',
    status: 'active', monthly_premium: 120.5, effective_date: '2026-01-01', policy_number: 'ABC1' },
  { plan_name: 'Applied Dental', carrier_name: 'Ameritas', line: 'Dental',
    status: 'submitted', monthly_premium: 29.5, effective_date: null },
  { plan_name: 'Old Plan <script>', carrier_name: 'X', line: 'Life', status: 'terminated',
    monthly_premium: 40, termination_date: '2025-12-31', termination_reason: 'replaced' },
  { plan_name: 'Never Started', carrier_name: 'Y', line: 'Life', status: 'withdrawn', source: 'manual' },
]);
ok(html.indexOf('Bronze POS 205') < html.indexOf('No longer in force'), 'in-force coverage comes first');
ok(html.indexOf('Old Plan') > html.indexOf('No longer in force'), 'terminated coverage sits below the divider');
ok(html.indexOf('Never Started') > html.indexOf('No longer in force'), 'a policy that never started is not shown as live');
ok(html.includes('Active') && html.includes('Applied'), 'applied and active read differently');
ok(html.includes('ended Dec 31, 2025') && html.includes('replaced'), 'a terminated policy says when and why');
ok(html.includes('no effective date yet'), 'a pending application says the date is missing');
ok(html.includes('entered by hand'), 'coverage typed in by hand is marked as such');
ok(!html.includes('<script>') && html.includes('&lt;script&gt;'), 'a plan name cannot inject markup');

// ── 6. the vocabulary the portal will show a client ──────────────────────────
console.log('\n6. every status has words a client could read');
['submitted', 'active', 'terminated', 'withdrawn'].forEach(s => {
  const m = ENROLLMENT_STATUS[s];
  ok(m && m.label && m.hint && m.color, s + ' -> "' + (m ? m.label : '?') + '"');
});
// The database allows exactly these four. A fifth added there without a label
// here would render as a raw word on a client's screen.
const dbStatuses = /enrollments_status_check[\s\S]*?array\[([^\]]+)\]/.exec(
  fs.existsSync('C:/kannon-crm/supabase/migrations/20260804_enrollment_engine.sql')
    ? fs.readFileSync('C:/kannon-crm/supabase/migrations/20260804_enrollment_engine.sql', 'utf8') : '');
if (dbStatuses) {
  const wanted = dbStatuses[1].match(/'([a-z_]+)'/g).map(s => s.replace(/'/g, ''));
  wanted.forEach(s => ok(!!ENROLLMENT_STATUS[s], 'database status "' + s + '" has a label in the CRM'));
  Object.keys(ENROLLMENT_STATUS).forEach(s => ok(wanted.includes(s), 'CRM status "' + s + '" exists in the database'));
} else {
  ok(false, 'could not read the enrollment migration to compare statuses against');
}

console.log(bad ? '\n' + bad + ' FAILED' : '\nenrollment records what the client took, and what they turned down');
process.exit(bad ? 1 : 0);
