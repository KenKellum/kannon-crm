// Every Needs Attention card must be clickable.
//
// The first version of this matched '<div style="flex-shrink:0;width:220px;'
// and silently missed the three 230px cards — Quote Interest among them. The
// bug was invisible because the code still "worked" on the cards it did match.
// This asserts coverage against the builder itself, so a new card or a new
// width fails here rather than in Ken's hands.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'crm.js'), 'utf8');

let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };

// Pull the live substitution out of crm.js rather than restating it here, so
// the test cannot drift away from the code it is checking.
const fnSrc = /function _naClickable_\(html, contactId\) \{[\s\S]*?\n\}/.exec(src);
if (!fnSrc) { console.log('  FAIL _naClickable_ not found'); process.exit(1); }
const _naClickable_ = new Function('html', 'contactId',
  fnSrc[0].replace(/^function _naClickable_\(html, contactId\) \{/, '').replace(/\}$/, ''));

// Isolate the builder.
const start = src.indexOf('function _buildNeedsAttentionHTML');
const end   = src.indexOf('\nfunction ', src.indexOf('return `<div style="background:${headerBg};', start));
const body  = src.slice(start, end > start ? end : start + 40000);

const wrappers = body.match(/<div style="flex-shrink:0;width:\d+px;/g) || [];
const widths   = [...new Set(wrappers.map(w => /width:(\d+)px/.exec(w)[1]))].sort();
console.log('card variants: ' + wrappers.length + ' across widths ' + widths.join('px, ') + 'px');
ok(wrappers.length >= 10, 'found the card variants to check');
ok(widths.length > 1, 'more than one width exists — the reason this test is here');

console.log('\nevery variant becomes clickable');
wrappers.forEach(w => {
  const out = _naClickable_(w + 'display:flex;"></div>', 'C1');
  ok(/onclick="naOpenContact_\(event,'C1'\)"/.test(out) && /cursor:pointer/.test(out),
     w.replace('<div style="flex-shrink:0;', '').replace(';', ''));
});

console.log('\nguards');
ok(_naClickable_('<div style="flex-shrink:0;width:220px;">x</div>', null)
   === '<div style="flex-shrink:0;width:220px;">x</div>', 'no contact id leaves the card untouched');
ok(_naClickable_('', 'C1') === '', 'empty card stays empty');
const withBtn = _naClickable_('<div style="flex-shrink:0;width:220px;"><button onclick="go()">Call</button></div>', 'C1');
ok(withBtn.includes('<button onclick="go()">'), 'buttons keep their own handlers');
ok((withBtn.match(/onclick="naOpenContact_/g) || []).length === 1, 'the card is wrapped once, not per element');

// The click handler must let real controls through.
ok(/closest\('button, a, input, select, textarea'\)/.test(src),
   'the handler ignores clicks that landed on a control');

console.log('\n' + (bad ? bad + ' FAILURE(S)' : 'every Needs Attention card is clickable'));
process.exit(bad ? 1 : 0);
