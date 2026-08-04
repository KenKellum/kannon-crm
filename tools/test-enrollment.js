// Enrollment — the rules that decide what a client is recorded as having.
//
// The database guards (an enrolled product's numbers are frozen while the rest
// of the quote stays workable, one enrollment per option, a terminated policy
// needs an end date, coverage cannot be deleted) are proved against the real
// database by probe; those cannot be reached from here. What IS here is the
// code that decides what the agent sees and what gets written.
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

// A DOM small enough to hold a form.
const nodes = {};
function node(id) {
  if (!nodes[id]) nodes[id] = { id, value: '', innerHTML: '', style: {}, textContent: '', dataset: {} };
  return nodes[id];
}
global.document = { getElementById: id => nodes[id] || null };
global.window = global;

eval(grab('escWeb'));
eval(grab('PIPELINES').replace(/^const /, 'var '));
eval(grab('ENROLLMENT_STATUS').replace(/^const /, 'var '));
eval(grab('COVERAGE_STAGE').replace(/^const /, 'var '));
eval(grab('DEAL_WON_REASON').replace(/^const /, 'var '));
eval(grab('DEAL_CLOSE_REASONS').replace(/^const /, 'var '));
eval(grab('dealWasWon_'));
eval(grab('enrollMoney_'));
eval(grab('enrollDate_'));
eval(grab('CARRIER_LINES').replace(/^const /, 'var '));
eval(grab('RENEWAL_WINDOW_DAYS').replace(/^const /, 'var '));
eval(grab('renewalDueWithin_'));
eval(grab('coverageState_'));
eval(grab('coverageRollup_'));
eval(grab('dealCoverageVerdict_'));
eval(grab('TERM_LIMITED_LINES').replace(/^const /, 'var '));
eval(grab('PLAN_YEAR_LINES').replace(/^const /, 'var '));
eval(grab('coverageEndRule_'));
eval(grab('planYearEnd_'));
eval(grab('enrollQuoteExpired_'));
eval(grab('enrollPortalLink_'));
eval(grab('enrollCardState_'));
eval(grab('enrollHeadline_'));
eval(grab('coverageListHtml_'));
eval(grab('cvStatusChanged_'));

const T = '2026-08-04';
let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
const day = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// ── 1. where a deal sits, given what the coverage is doing ───────────────────
console.log('1. every stage the coverage can send a deal to is a real stage');
Object.entries(COVERAGE_STAGE).forEach(([pipe, map]) => {
  const stages = (PIPELINES[pipe] || {}).stages || [];
  Object.entries(map).forEach(([when, stage]) => {
    ok(stages.includes(stage), pipe + ' / ' + when + ' -> "' + stage + '" exists in that pipeline');
  });
  ok(stages.indexOf(map.applied) <= stages.indexOf(map.settled), pipe + ': applied comes before settled');
  ok(stages.indexOf(map.settled) <= stages.indexOf(map.in_force), pipe + ': settled comes before in force');
});
Object.keys(PIPELINES).forEach(p => {
  if (p.startsWith('agent-')) ok(!COVERAGE_STAGE[p], p + ' has no coverage stages — an agent is contracted, not enrolled');
  else ok(!!COVERAGE_STAGE[p], p + ' has coverage stages');
});

console.log('\n1a. a deal is finished only when nothing is still with a carrier');
const V = (pipe, rows) => dealCoverageVerdict_(pipe, rows, T);
const R = (o) => Object.assign({ status: 'active' }, o);
ok(!V('individual-family', []).stage, 'no coverage at all leaves the deal alone');
let v = V('individual-family', [R({ status: 'submitted' })]);
ok(v.stage === 'Application' && !v.close, 'an application in the carrier\'s hands -> Application, stays on the board');
v = V('individual-family', [R({ effective_date: '2026-09-01' })]);
ok(v.stage === 'Enrolled' && !v.close, 'approved but not started -> Enrolled, still on the board');
v = V('individual-family', [R({ effective_date: '2026-01-01' })]);
ok(v.stage === 'Active Client' && v.close, 'cover in force -> Active Client, and the deal closes');
// The case that matters: do not take a deal off the board while there is still
// something to chase.
v = V('individual-family', [R({ effective_date: '2026-01-01' }), R({ status: 'submitted' })]);
ok(!v.close, 'one policy in force but another still pending does NOT close the deal');
ok(v.stage === 'Application', 'and it sits at Application, because that is the outstanding work');
v = V('medicare', [R({ effective_date: '2026-01-01' })]);
ok(v.stage === 'Annual Review' && v.close, 'a Medicare client in force -> Annual Review, closed');
v = V('group-employer', [R({ status: 'submitted' })]);
ok(v.stage === 'Enrolled', 'group has no Application stage, so it uses Enrolled');
// Coverage that has ended is not a reason to close a deal as won today.
v = V('individual-family', [R({ effective_date: '2025-01-01', termination_date: '2026-03-31' })]);
ok(!v.close && !v.stage, 'coverage that lapsed months ago does not close anything now');
ok(!V('agent-insured', [R({ effective_date: '2026-01-01' })]).stage,
   'a recruiting deal is never touched by coverage');

console.log('\n1b. won is not the same as lost');
ok(DEAL_CLOSE_REASONS.includes(DEAL_WON_REASON), 'the won reason is one of the close reasons');
ok(DEAL_CLOSE_REASONS[0] === DEAL_WON_REASON, 'and it is first in the list, not buried among the losses');
ok(dealWasWon_({ closed_reason: DEAL_WON_REASON }), 'a deal closed as won reads as won');
ok(!dealWasWon_({ closed_reason: 'Price' }), 'a deal lost on price does not');
ok(!dealWasWon_({}), 'and an open deal is neither');
ok(!dealWasWon_(null), 'nor is nothing at all');

// ── 1c. in force is a fact about today ───────────────────────────────────────
//
// The whole point: nothing runs on a schedule, so a stored "active" would still
// say active in June for a policy that ended in March. These are read fresh
// every time, which is why they can be trusted by a client's portal.
console.log('\n1b. what a policy reads as, worked out from its dates');
const st = (r) => coverageState_(r, T);
const cov = (o) => Object.assign({ status: 'active' }, o);

let s1 = st(cov({ effective_date: '2026-01-01' }));
ok(s1.key === 'in_force' && s1.inForce, 'started in January -> in force');
s1 = st(cov({ effective_date: '2026-08-04' }));
ok(s1.inForce, 'starting TODAY is in force today, not tomorrow');
s1 = st(cov({ effective_date: '2026-09-01' }));
ok(s1.key === 'starting' && !s1.inForce, 'a September start is not in force in August');
ok(/Starts Sep 1, 2026/.test(s1.label), 'and it says when: ' + s1.label);
ok(s1.live, 'but it is still a live record — it has not gone anywhere');

// The case that made this necessary: nobody updates a record when a date passes.
s1 = st(cov({ effective_date: '2025-01-01', termination_date: '2026-03-31' }));
ok(!s1.inForce && !s1.live, 'an end date that has passed ends it, whatever the stored status says');
ok(/Ended Mar 31, 2026/.test(s1.label), 'and it says when it ended: ' + s1.label);

// Ken's mid-coverage cancellation, set now for a future date.
s1 = st(cov({ effective_date: '2026-01-01', termination_date: '2026-10-31' }));
ok(s1.inForce, 'ending it in October leaves it IN FORCE through August');
ok(/Ends Oct 31, 2026/.test(s1.label), 'and it says when it stops: ' + s1.label);
// A date set without also flipping the status must not hide a policy that is
// about to stop — that is exactly the row an agent needs to see coming.
ok(s1.key === 'ending', 'a future end date means ENDING even while the status still says approved');
s1 = st({ status: 'terminated', effective_date: '2026-01-01', termination_date: '2026-10-31' });
ok(s1.inForce && s1.live, 'marked terminated with a FUTURE date is still in force until then');
ok(/Ends Oct 31/.test(s1.label), 'and reads as ending, not ended: ' + s1.label);
s1 = st({ status: 'terminated', effective_date: '2026-01-01', termination_date: T });
ok(!s1.inForce, 'ending it TODAY takes it out of force today');

// The states that are not about dates at all.
ok(st({ status: 'submitted' }).key === 'applied', 'an application in the carrier\'s hands is Applied');
ok(!st({ status: 'submitted', effective_date: '2026-01-01' }).inForce,
   'an application is never in force, even with a date on it — the carrier has not said yes');
ok(st({ status: 'withdrawn', effective_date: '2026-01-01' }).key === 'withdrawn',
   'a withdrawn record stays withdrawn whatever its dates say');
ok(!st({ status: 'withdrawn' }).live, 'and it is not live');
ok(st(cov({ effective_date: null })).key === 'approved', 'approved with no start date says so');
ok(!st(cov({ effective_date: null })).inForce, 'and is not claimed to be in force');

// Every state must give the agent words and a colour, or the list renders blank.
['submitted', 'active', 'terminated', 'withdrawn'].forEach(x => {
  const r = st({ status: x, effective_date: '2026-01-01', termination_date: x === 'terminated' ? '2026-06-01' : null });
  ok(!!r.label && !!r.color && !!r.icon, x + ' -> "' + r.label + '"');
});

// ── 1d. when does this cover run out ─────────────────────────────────────────
//
// Ken's first real enrollment was a short-term plan with no end date on it. It
// would have read "In force" forever and never once asked to be looked at,
// while the client went uninsured the day it quietly stopped.
console.log('\n1d. the end date, which a short-term plan cannot go without');
ok(coverageEndRule_('Short-Term Medical').required, 'a short-term plan MUST have an end date');
ok(/stops on this date/.test(coverageEndRule_('Short-Term Medical').hint),
   'and the reason is spelled out: ' + coverageEndRule_('Short-Term Medical').hint);
ok(!coverageEndRule_('Health — Individual').required, 'an ACA plan does not have to have one');
ok(coverageEndRule_('Health — Individual').planYear, 'but it is offered the plan-year end');
ok(coverageEndRule_('Medicare Advantage').planYear, 'so is Medicare Advantage');
ok(coverageEndRule_('Part D (PDP)').planYear, 'and Part D');
ok(!coverageEndRule_('Life').required && !coverageEndRule_('Life').planYear,
   'life cover is open-ended — neither demanded nor pre-filled');
ok(/until somebody cancels/.test(coverageEndRule_('Life').hint), 'and says so');
// Every line that must have a date has to be a line the quote builder offers,
// or the rule can never fire.
TERM_LIMITED_LINES.concat(PLAN_YEAR_LINES).forEach(l =>
  ok(CARRIER_LINES.includes(l), '"' + l + '" is a real coverage type'));

ok(planYearEnd_('2026-09-01') === '2026-12-31', 'a September start runs to 31 December that year');
ok(planYearEnd_('2027-01-15') === '2027-12-31', 'and a January start to the end of ITS year, not this one');
ok(/^\d{4}-12-31$/.test(planYearEnd_(null)), 'no start date still yields a sane year end');

// ── 1e. what is running out soon ─────────────────────────────────────────────
console.log('\n1e. renewing soon');
const inDays = n => { const d = new Date(T + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
ok(renewalDueWithin_({ termination_date: inDays(30) }, 60, T), '30 days out is renewing soon');
ok(renewalDueWithin_({ termination_date: inDays(60) }, 60, T), 'exactly 60 days out still counts');
ok(!renewalDueWithin_({ termination_date: inDays(61) }, 60, T), '61 days out does not — no crying wolf');
ok(!renewalDueWithin_({ termination_date: inDays(-1) }, 60, T), 'and one that already ended is not "renewing"');
ok(!renewalDueWithin_({ termination_date: null }, 60, T), 'a policy with no end date never comes up');
ok(RENEWAL_WINDOW_DAYS >= 30, 'the default window gives real warning: ' + RENEWAL_WINDOW_DAYS + ' days');

// ── 2. nobody enrols on a price that has run out ─────────────────────────────
console.log('\n2. an expired quote cannot be enrolled on');
ok(enrollQuoteExpired_({ valid_until: day(-1) }), 'yesterday\'s expiry is expired');
ok(!enrollQuoteExpired_({ valid_until: day(0) }), 'today is still good — they have until the end of it');
ok(!enrollQuoteExpired_({ valid_until: day(30) }), 'a month out is fine');
ok(!enrollQuoteExpired_({ valid_until: null }), 'a quote with no expiry never expires');
ok(!enrollQuoteExpired_({}), 'and a missing field does not read as expired');

// ── 3. the link to where the real enrollment happens ─────────────────────────
console.log('\n3. the carrier link — this system records, the carrier\'s site enrols');
const opt = { carrier_name: 'Blue Cross', plan_meta: null };
ok(!enrollPortalLink_(opt, null, null), 'no link at all rather than a guess');
ok(enrollPortalLink_(opt, { name: 'Blue Cross', broker_portal_url: 'https://bcbs.example/broker' }, null).url
   === 'https://bcbs.example/broker', 'the carrier\'s broker portal is used when there is one');
// The agent's own appointment link carries their writing number — it must win.
const both = enrollPortalLink_(opt,
  { name: 'Blue Cross', broker_portal_url: 'https://bcbs.example/broker' },
  { quoting_url: 'https://bcbs.example/agent/12345' });
ok(both.url === 'https://bcbs.example/agent/12345', "the agent's own appointment link beats the generic portal");
ok(both.label === 'Blue Cross', 'and it is labelled with the carrier name: ' + both.label);
ok(enrollPortalLink_({ plan_meta: { src: 'aca' } }, null, null).url.includes('healthcare.gov'),
   'a Marketplace plan points at HealthCare.gov');
ok(enrollPortalLink_({ plan_meta: { src: 'cms' } }, null, null).url.includes('medicare.gov'),
   'a Medicare plan points at Medicare.gov');

// ── 4. what each product on the quote reads as ───────────────────────────────
console.log('\n4. each product\'s state');
ok(enrollCardState_({ outcome: null }).key === 'undecided', 'a product nobody has decided is undecided');
ok(enrollCardState_({ outcome: null }).label === 'Not decided yet',
   'and says so: ' + enrollCardState_({ outcome: null }).label);
ok(enrollCardState_({ outcome: 'waived' }).key === 'waived', 'a declined product reads as waived');
// The enrolled label follows the COVERAGE record, so an application waiting on
// the carrier does not claim to be active.
ok(enrollCardState_({ outcome: 'enrolled' }, { status: 'submitted' }).label === 'Applied',
   'enrolled + application in = "Applied"');
ok(enrollCardState_({ outcome: 'enrolled' }, { status: 'active' }).label === 'Approved',
   'enrolled + approved but no start date = "Approved"');
ok(enrollCardState_({ outcome: 'enrolled' }, { status: 'active', effective_date: '2020-01-01' }).label === 'In force',
   'enrolled + approved + a start date that has passed = "In force"');
ok(enrollCardState_({ outcome: 'enrolled' }, { status: 'withdrawn' }).label === 'Not taken',
   'an undone enrollment reads as "Not taken"');
ok(enrollCardState_({ outcome: 'enrolled' }, null).label === 'Applied',
   'enrolled with no coverage row yet falls back to Applied, never to Active');

// ── 5. the headline, which is the whole screen in one line ───────────────────
console.log('\n5. the headline');
const O = (outcome, prem) => ({ outcome, monthly_premium: prem });
ok(enrollHeadline_([O(null, 10), O(null, 20)]) === '2 products still to decide.',
   'nothing decided: ' + enrollHeadline_([O(null, 10), O(null, 20)]));
ok(enrollHeadline_([O(null, 10)]) === '1 product still to decide.', 'one reads singular');
const mixed = enrollHeadline_([O('enrolled', 120.5), O('waived', 30), O(null, 18)]);
ok(/Enrolled in 1 — \$120\.50\/mo/.test(mixed), 'the total counts only what was taken: ' + mixed);
ok(/1 still to decide/.test(mixed), 'and it says what is left');
const done = enrollHeadline_([O('enrolled', 120.5), O('enrolled', 29.5)]);
ok(/\$150\.00\/mo/.test(done), 'two enrolled products add up: ' + done);
ok(/everything decided/.test(done), 'and it says when there is nothing left');
ok(enrollHeadline_([O('waived', 10)]) === 'Every product on this quote was waived.',
   'all waived is stated plainly, not left blank');

// ── 6. money and dates ───────────────────────────────────────────────────────
console.log('\n6. formatting');
ok(enrollMoney_(0) === '$0.00', 'a free product is $0.00, not blank');
ok(enrollMoney_(null) === '', 'a missing premium prints nothing rather than $NaN');
ok(enrollMoney_('12.3') === '$12.30', 'a numeric string still formats');
ok(enrollDate_('2026-03-01').includes('Mar 1, 2026'), 'a date column does not slip a day: ' + enrollDate_('2026-03-01'));
ok(enrollDate_(null) === '', 'no date prints nothing');

// ── 7. the coverage list — what the portal will mirror ───────────────────────
console.log('\n7. the coverage list');
ok(coverageListHtml_([]).includes('Nothing enrolled yet'), 'an empty list explains itself');
const html = coverageListHtml_([
  { id: 'e1', plan_name: 'Bronze POS 205', carrier_name: 'BCBS', line: 'Health — Individual',
    status: 'active', monthly_premium: 120.5, effective_date: '2026-01-01', policy_number: 'ABC1', quote_id: 'q-1' },
  { id: 'e2', plan_name: 'Applied Dental', carrier_name: 'Ameritas', line: 'Dental',
    status: 'submitted', monthly_premium: 29.5, effective_date: null },
  { id: 'e3', plan_name: 'Old Plan <script>', carrier_name: 'X', line: 'Life', status: 'terminated',
    monthly_premium: 40, termination_date: '2025-12-31', termination_reason: 'replaced' },
  { id: 'e4', plan_name: 'Never Started', carrier_name: 'Y', line: 'Life', status: 'withdrawn', source: 'manual' },
]);
ok(html.indexOf('Bronze POS 205') < html.indexOf('No longer in force'), 'in-force coverage comes first');
ok(html.indexOf('Old Plan') > html.indexOf('No longer in force'), 'terminated coverage sits below the divider');
ok(html.indexOf('Never Started') > html.indexOf('No longer in force'), 'a policy that never started is not shown as live');
ok(html.includes('In force') && html.includes('Applied'), 'applied and in force read differently');
ok(html.includes('Ended Dec 31, 2025') && html.includes('replaced'), 'a terminated policy says when and why');
ok(html.includes('no effective date yet'), 'a pending application says the date is missing');
ok(html.includes('entered by hand'), 'coverage typed in by hand is marked as such');
ok(!html.includes('<script>') && html.includes('&lt;script&gt;'), 'a plan name cannot inject markup');
ok(html.includes('manage'), 'each row can be managed');
ok(!coverageListHtml_([{ id: 'x', plan_name: 'X', carrier_name: 'Y', line: 'Life', status: 'active' }],
                      { editable: false }).includes('manage'),
   'a read-only list offers no manage link — for a client-facing view later');
ok(html.includes('quote.html?q='), 'coverage from a quote links back to the quote it was sold on');

// ── 8. ending a policy ───────────────────────────────────────────────────────
console.log('\n8. ending a policy asks for the date the database requires');
node('cv-status'); node('cv-term-wrap'); node('cv-term-why');
nodes['cv-status'].value = 'active';
cvStatusChanged_();
ok(nodes['cv-term-wrap'].style.display === 'none', 'an active policy is not asked for an end date');
nodes['cv-status'].value = 'terminated';
cvStatusChanged_();
ok(nodes['cv-term-wrap'].style.display === 'block', 'ending it asks when');
ok(nodes['cv-term-why'].style.display === 'block', 'and asks why');

// ── 9. the vocabulary the portal will show a client ──────────────────────────
console.log('\n9. every status has words a client could read');
['submitted', 'active', 'terminated', 'withdrawn'].forEach(s => {
  const m = ENROLLMENT_STATUS[s];
  ok(m && m.label && m.hint && m.color, s + ' -> "' + (m ? m.label : '?') + '"');
});
const mig = 'C:/kannon-crm/supabase/migrations/20260804_enrollment_engine.sql';
const dbStatuses = /enrollments_status_check[\s\S]*?array\[([^\]]+)\]/.exec(
  fs.existsSync(mig) ? fs.readFileSync(mig, 'utf8') : '');
if (dbStatuses) {
  const wanted = dbStatuses[1].match(/'([a-z_]+)'/g).map(s => s.replace(/'/g, ''));
  wanted.forEach(s => ok(!!ENROLLMENT_STATUS[s], 'database status "' + s + '" has a label in the CRM'));
  Object.keys(ENROLLMENT_STATUS).forEach(s => ok(wanted.includes(s), 'CRM status "' + s + '" exists in the database'));
} else {
  ok(false, 'could not read the enrollment migration to compare statuses against');
}

console.log(bad ? '\n' + bad + ' FAILED' : '\nenrollment records what the client took, and what they turned down');
process.exit(bad ? 1 : 0);
