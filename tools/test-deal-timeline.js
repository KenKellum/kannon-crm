// Exercise the real timeline code out of crm.js against fixture activity.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'crm.js'), 'utf8');

function grab(name) {
  const decl = new RegExp('(?:^|\\n)(?:const |function )' + name + '\\b');
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

const ACTIVITY_META = eval('(' + grab('ACTIVITY_META').replace(/^const ACTIVITY_META = /, '') + ')');
let dealActivities = [];
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
eval(/const DEAL_TL_PREVIEW = \d+;/.exec(src)[0].replace('const', 'var'));
eval(grab('DEAL_TL_KINDS').replace(/^const /, 'var '));
eval(grab('_dealTlKind_'));
eval(grab('_dealTimelineItems_'));
eval(grab('_dealTimelineRow_'));
eval(grab('_renderDealMergedTimeline'));

let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
const day = 86400000, now = Date.now();
const at = d => new Date(now - d * day).toISOString();

// ── bucketing ────────────────────────────────────────────────────────────────
console.log('1. every real activity type lands in a sensible bucket');
const expect = {
  call_made: 'call', call_connected: 'call', call_voicemail: 'call',
  email_sent: 'email', email_opened: 'email', email_replied: 'email', email_auto_reply: 'email',
  email_bounced_hard: 'problem', email_bounced_soft: 'problem', email_blocked: 'problem',
  email_opted_out: 'problem', email_complained: 'problem',
  meeting_booked: 'meeting', meeting_no_show: 'meeting', calendar_declined: 'meeting',
  note_added: 'note', intake_completed: 'intake', status_changed: 'status',
};
Object.entries(expect).forEach(([t, want]) =>
  ok(_dealTlKind_(t) === want, t + ' -> ' + _dealTlKind_(t) + ' (want ' + want + ')'));
// Nothing in the real catalogue may fall through to "other".
Object.keys(ACTIVITY_META).forEach(t =>
  ok(_dealTlKind_(t) !== 'other', t + ' has a bucket'));

// ── build ────────────────────────────────────────────────────────────────────
console.log('\n2. manual + system merge, newest first');
dealActivities = [
  { deal_id: 'D', type: 'call',  content: 'Left voicemail about dental',  created_at: at(1) },
  { deal_id: 'D', type: 'note',  content: 'Wants to revisit in September', created_at: at(40) },
  { deal_id: 'X', type: 'note',  content: 'OTHER DEAL - must not appear',  created_at: at(0) },
];
const sys = [
  { activity_type: 'email_sent',        subject: 'Your quote',   created_at: at(2),   metadata: {} },
  { activity_type: 'email_bounced_hard',subject: 'Undeliverable',created_at: at(3),   metadata: {} },
  { activity_type: 'intake_completed',  subject: 'Intake done',  created_at: at(200), metadata: { session_id: 'S1' } },
  { activity_type: 'meeting_booked',    subject: 'Zoom Tue',     created_at: at(10),  metadata: {} },
];
const items = _dealTimelineItems_('D', sys);
ok(items.length === 6, 'six items (2 manual for D + 4 system), got ' + items.length);
ok(!items.some(i => /OTHER DEAL/.test(i.text)), "another deal's activity is excluded");
ok(items.every((it, i) => i === 0 || items[i - 1].ts >= it.ts), 'sorted newest first');
ok(items[0].text === 'Left voicemail about dental', 'newest is the 1-day-old call');

console.log('\n3. panel preview shows 3 and offers the rest');
const html = _renderDealMergedTimeline('D', sys);
ok((html.match(/class="activity-item"/g) || []).length === 3, 'exactly 3 rows rendered');
ok(/View all activity \(6\)/.test(html), 'button offers all 6');
ok(/openDealActivityLog_\('D'\)/.test(html), 'button opens the log for this deal');
ok(!/OTHER DEAL/.test(html), 'preview leaks nothing from another deal');

console.log('\n4. a short timeline gets no button');
const few = _renderDealMergedTimeline('D', []);
ok((few.match(/class="activity-item"/g) || []).length === 2, 'both manual rows show');
ok(!/View all activity/.test(few), 'no button when everything already fits');

console.log('\n5. empty state survives');
dealActivities = [];
ok(/No activity yet/.test(_renderDealMergedTimeline('D', [])), 'empty state renders');

// ── filters (the modal's logic, applied to the same items) ───────────────────
console.log('\n6. filters');
dealActivities = [{ deal_id: 'D', type: 'call', content: 'Left voicemail about dental', created_at: at(1) },
                  { deal_id: 'D', type: 'note', content: 'Wants to revisit in September', created_at: at(40) }];
const all = _dealTimelineItems_('D', sys);
const filt = (kind, days, q) => all.filter(it => {
  if (kind !== 'all' && it.kind !== kind) return false;
  if (days && (now - it.ts) > days * day) return false;
  if (q && (it.label + ' ' + it.text).toLowerCase().indexOf(q.toLowerCase()) < 0) return false;
  return true;
});
ok(filt('call', 0, '').length === 1, 'type=Calls -> 1');
ok(filt('problem', 0, '').length === 1, 'type=Delivery problems -> 1 (the hard bounce)');
ok(filt('all', 7, '').length === 3, 'last 7 days -> 3 (call, email, bounce)');
ok(filt('all', 30, '').length === 4, 'last 30 days -> 4 (+ the meeting)');
ok(filt('all', 365, '').length === 6, 'last year -> all 6 (oldest fixture is 200 days)');
ok(filt('all', 0, 'september').length === 1, 'search is case-insensitive');
ok(filt('all', 0, 'dental')[0].text === 'Left voicemail about dental', 'search hits note text');
ok(filt('call', 7, 'dental').length === 1, 'filters combine');
ok(filt('meeting', 7, '').length === 0, 'meeting is outside 7 days');

console.log('\n7. escaping');
dealActivities = [{ deal_id: 'D', type: 'note', content: '<img src=x onerror=alert(1)>', created_at: at(1) }];
const row = _dealTimelineRow_(_dealTimelineItems_('D', [])[0]);
ok(!/<img/.test(row) && /&lt;img/.test(row), 'a note cannot inject markup');

console.log('\n' + (bad ? bad + ' FAILURE(S)' : 'all checks passed'));
process.exit(bad ? 1 : 0);
