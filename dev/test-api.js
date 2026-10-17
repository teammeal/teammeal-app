/* Tests for functions/api.js against a local SQLite stand-in for D1. Run: node dev/test-api.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { load } = require('./d1-mock');

const menu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'fordsgarage-menu.json'), 'utf8'));
const roster = [{ number: '17', first: 'Alex', last: 'Smith' }, { number: '9', first: 'Eli', last: 'Jones' }, { number: '07', first: 'Casey', last: 'Lee' }];
const burger = menu.sections.find(s => s.name === 'Burgers of Fame').items.find(i => i.name === 'American Standard');
const opt = burger.options[0];
const mk = (num, names, extra = {}) => ({
  num,
  people: names.map(n => ({ name: n, allergies: [], notes: '',
    items: [{ item: 'American Standard', price: 0.01, options: { [opt.name]: opt.choices[0] }, sides: Array(burger.sideCount).fill(menu.sides[0]), changes: '', ...extra }] }))
});
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('ok  ', name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const gas = await load();
  const err = async (p, code) => assert.strictEqual((await gas.post(p)).error, code);

  await ok('ping', async () => assert.strictEqual((await gas.get({ action: 'ping' })).service, 'teammeal'));
  await ok('createTeam rejects missing name', () => err({ action: 'createTeam', team: '', roster, menu }, 'invalid'));
  await ok('createTeam rejects bad roster number', () => err({ action: 'createTeam', team: 'X', roster: [{ number: 'abc', first: 'A' }], menu }, 'invalid'));
  await ok('createTeam rejects bad link', () => err({ action: 'createTeam', team: 'X', menuLink: 'javascript:alert(1)', roster, menu }, 'invalid'));
  await ok('bad json', async () => assert.strictEqual((await gas.postRaw('not json')).error, 'invalid'));
  await ok('writes need POST', async () => assert.strictEqual((await gas.get({ action: 'createTeam' })).error, 'invalid'));

  const t = await gas.post({ action: 'createTeam', team: 'Hawks 10U', menuLink: 'https://example.com/menu', roster, menu });
  await ok('createTeam works', async () => { assert(t.ok); assert(/^hawks10u-[a-z0-9]{4}$/.test(t.id)); assert.strictEqual(t.adminKey.length, 32); });

  await ok('public team has no admin key or roster names', async () => {
    const r = await gas.get({ action: 'team', id: t.id });
    assert(r.ok); const s = JSON.stringify(r);
    assert(!s.includes(t.adminKey)); assert(!s.includes('Smith'));
    assert.deepStrictEqual(r.team.numbers, ['17', '9', '07']);
    assert.strictEqual(r.team.menu.sections.length, menu.sections.length);
    assert.strictEqual(r.team.closed, false);
  });
  await ok('unknown team', async () => assert.strictEqual((await gas.get({ action: 'team', id: 'nope' })).error, 'not_found'));

  const o1 = await gas.post({ action: 'submitOrder', teamId: t.id, order: mk('17', ['Alex', 'Dana', 'Jo']) });
  await ok('submit works', async () => { assert(o1.ok); assert(o1.orderId && o1.editKey); });
  await ok('price comes from the menu, not the client', async () => {
    const r = await gas.get({ action: 'order', orderId: o1.orderId, key: o1.editKey });
    assert.strictEqual(r.order.people[0].items[0].price, burger.price);
    assert.strictEqual(r.order.total, Math.round(burger.price * 300) / 100);
  });
  await ok('submit rejects unknown item', async () => { const o = mk('17', ['A']); o.people[0].items[0].item = 'Fake'; await err({ action: 'submitOrder', teamId: t.id, order: o }, 'invalid'); });
  await ok('submit rejects missing option', async () => { const o = mk('17', ['A']); o.people[0].items[0].options = {}; await err({ action: 'submitOrder', teamId: t.id, order: o }, 'invalid'); });
  await ok('submit rejects bad side', async () => { const o = mk('17', ['A']); o.people[0].items[0].sides = ['Caviar']; await err({ action: 'submitOrder', teamId: t.id, order: o }, 'invalid'); });
  await ok('submit rejects bad number', () => err({ action: 'submitOrder', teamId: t.id, order: mk('1234', ['A']) }, 'invalid'));
  await ok('submit rejects empty person', async () => { const o = mk('17', ['A']); o.people[0].items = []; await err({ action: 'submitOrder', teamId: t.id, order: o }, 'invalid'); });

  const o2 = await gas.post({ action: 'submitOrder', teamId: t.id, order: mk('9', ['Eli', 'Mia']) });
  await ok('second order for another number', async () => assert(o2.ok));
  const o3 = await gas.post({ action: 'submitOrder', teamId: t.id, order: mk('17', ['Parent']) });
  await ok('same number can have two separate orders', async () => assert(o3.ok && o3.orderId !== o1.orderId));

  await ok('edit key cannot read all orders', async () => assert.strictEqual((await gas.get({ action: 'orders', id: t.id, key: o1.editKey })).error, 'bad_key'));
  await ok('no key cannot read all orders', async () => assert.strictEqual((await gas.get({ action: 'orders', id: t.id })).error, 'bad_key'));
  await ok('organizer reads all orders incl. roster', async () => {
    const r = await gas.get({ action: 'orders', id: t.id, key: t.adminKey });
    assert(r.ok); assert.strictEqual(r.orders.length, 3); assert.strictEqual(r.team.roster[0].last, 'Smith');
    assert(!JSON.stringify(r).includes(o1.editKey));
  });
  await ok('order read needs the right key', async () => {
    assert.strictEqual((await gas.get({ action: 'order', orderId: o1.orderId, key: o2.editKey })).error, 'bad_key');
    assert((await gas.get({ action: 'order', orderId: o1.orderId, key: t.adminKey })).isAdmin);
  });

  /* the Suzy case: remove a person */
  const edited = mk('17', ['Alex', 'Jo']);
  edited.people[1].items[0].changes = '=HYPERLINK("http://x")';
  await ok('owner edits own order (removes a person)', async () => assert((await gas.post({ action: 'updateOrder', orderId: o1.orderId, key: o1.editKey, order: edited })).ok));
  await ok('edit replaced the order, no duplicates', async () => {
    const r = await gas.get({ action: 'order', orderId: o1.orderId, key: o1.editKey });
    assert.deepStrictEqual(r.order.people.map(p => p.name), ['Alex', 'Jo']);
    assert.strictEqual((await gas.get({ action: 'orders', id: t.id, key: t.adminKey })).orders.length, 3);
  });
  await ok('someone else cannot edit it', () => err({ action: 'updateOrder', orderId: o1.orderId, key: o2.editKey, order: edited }, 'bad_key'));
  await ok('organizer can edit anyone', async () => assert((await gas.post({ action: 'updateOrder', orderId: o2.orderId, key: t.adminKey, order: mk('9', ['Eli']) })).ok));
  await ok('changing the player number works', async () => {
    assert((await gas.post({ action: 'updateOrder', orderId: o3.orderId, key: o3.editKey, order: mk('9', ['Parent']) })).ok);
    assert.strictEqual((await gas.get({ action: 'order', orderId: o3.orderId, key: o3.editKey })).order.num, '9');
  });

  await ok('csv export is for the organizer only and neutralises formulas', async () => {
    assert.strictEqual((await gas.get({ action: 'csv', id: t.id, key: o1.editKey })).error, 'bad_key');
    const r = await gas.getRaw({ action: 'csv', id: t.id, key: t.adminKey });
    assert(/text\/csv/.test(r.headers.get('content-type')));
    const text = await r.text();
    assert(text.includes('"Player #"') && text.includes('"Alex"'));
    assert(text.includes(`"'=HYPERLINK(""http://x"")"`), 'formula text must be neutralised');
  });

  await ok('owner removes whole order, data is wiped', async () => {
    assert((await gas.post({ action: 'deleteOrder', orderId: o3.orderId, key: o3.editKey })).ok);
    assert.strictEqual((await gas.get({ action: 'order', orderId: o3.orderId, key: o3.editKey })).error, 'not_found');
    assert.strictEqual((await gas.get({ action: 'orders', id: t.id, key: t.adminKey })).orders.length, 2);
    assert.strictEqual(gas.env.DB.raw.prepare('SELECT payload FROM orders WHERE order_id = ?').get(o3.orderId).payload, '{}');
  });
  await ok('wrong key cannot delete', () => err({ action: 'deleteOrder', orderId: o1.orderId, key: 'x' }, 'bad_key'));

  const soon = await gas.post({ action: 'createTeam', team: 'Deadline Team', orderBy: Date.now() + 400, roster, menu });
  const early = await gas.post({ action: 'submitOrder', teamId: soon.id, order: mk('17', ['Alex']) });
  await ok('can order before the deadline', async () => assert(early.ok));
  await sleep(600);
  await ok('team shows closed', async () => assert.strictEqual((await gas.get({ action: 'team', id: soon.id })).team.closed, true));
  await ok('new orders blocked after deadline', () => err({ action: 'submitOrder', teamId: soon.id, order: mk('9', ['Eli']) }, 'closed'));
  await ok('owner edit blocked after deadline', () => err({ action: 'updateOrder', orderId: early.orderId, key: early.editKey, order: mk('17', ['Alex', 'Zed']) }, 'closed'));
  await ok('owner delete blocked after deadline', () => err({ action: 'deleteOrder', orderId: early.orderId, key: early.editKey }, 'closed'));
  await ok('owner can still read their order after deadline (locked)', async () => assert.strictEqual((await gas.get({ action: 'order', orderId: early.orderId, key: early.editKey })).locked, true));
  await ok('organizer can edit after deadline', async () => assert((await gas.post({ action: 'updateOrder', orderId: early.orderId, key: soon.adminKey, order: mk('17', ['Alex', 'Zed']) })).ok));
  await ok('organizer can delete after deadline', async () => assert((await gas.post({ action: 'deleteOrder', orderId: early.orderId, key: soon.adminKey })).ok));

  /* limits: same connection */
  const same = 'one-noisy-connection';
  await ok('one connection can make 5 teams a day, not 6', async () => {
    for (let i = 0; i < 5; i++) assert((await gas.post({ action: 'createTeam', team: 'Spam ' + i, roster, menu }, same)).ok);
    const r = await gas.post({ action: 'createTeam', team: 'Spam 6', roster, menu }, same);
    assert.strictEqual(r.error, 'limit'); assert(/tomorrow/.test(r.message));
  });
  await ok('a different connection is not affected', async () => assert((await gas.post({ action: 'createTeam', team: 'Fine', roster, menu }, 'someone-else')).ok));
  await ok('one connection can place 60 orders an hour, not 61', async () => {
    const team = await gas.post({ action: 'createTeam', team: 'Busy', roster, menu });
    for (let i = 0; i < 60; i++) assert((await gas.post({ action: 'submitOrder', teamId: team.id, order: mk('17', ['A']) }, 'rink-wifi')).ok, 'order ' + i);
    assert.strictEqual((await gas.post({ action: 'submitOrder', teamId: team.id, order: mk('17', ['A']) }, 'rink-wifi')).error, 'limit');
    assert((await gas.post({ action: 'submitOrder', teamId: team.id, order: mk('17', ['A']) }, 'other-phone')).ok);
  });
  await ok('the stored fingerprint is not the IP address', async () => {
    const rows = gas.env.DB.raw.prepare('SELECT k FROM hits').all().map(r => r.k).join(' ');
    assert(!rows.includes('rink-wifi') && !rows.includes('one-noisy'));
  });
  await ok('old counters are removable', async () => {
    gas.env.DB.raw.prepare('UPDATE hits SET until = 1').run();
    for (let i = 0; i < 400 && gas.env.DB.raw.prepare('SELECT COUNT(*) c FROM hits WHERE until = 1').get().c; i++) await gas.post({ action: 'ping' });
    /* ping is a GET, so cleanup runs on writes; trigger some */
    for (let i = 0; i < 300 && gas.env.DB.raw.prepare('SELECT COUNT(*) c FROM hits WHERE until = 1').get().c; i++) await gas.post({ action: 'deleteOrder', orderId: 'x', key: 'y' });
    assert.strictEqual(gas.env.DB.raw.prepare('SELECT COUNT(*) c FROM hits WHERE until = 1').get().c, 0);
  });

  await ok('wait list: saves a valid email once, rejects junk, ignores bots', async () => {
    assert((await gas.post({ action: 'joinWaitlist', email: ' Mom@Example.com ' })).ok);
    assert((await gas.post({ action: 'joinWaitlist', email: 'mom@example.com' })).ok);
    assert.strictEqual((await gas.post({ action: 'joinWaitlist', email: 'nope' })).error, 'invalid');
    assert((await gas.post({ action: 'joinWaitlist', email: 'bot@example.com', company: 'Acme' })).ok);
    const rows = gas.env.DB.raw.prepare('SELECT email FROM waitlist').all().map(r => r.email);
    assert.deepStrictEqual(rows, ['mom@example.com']);
    assert.strictEqual((await gas.get({ action: 'joinWaitlist', email: 'x@y.co' })).error, 'invalid');
  });
  await ok('wait list: 10 sign-ups an hour per connection', async () => {
    for (let i = 0; i < 10; i++) assert((await gas.post({ action: 'joinWaitlist', email: `p${i}@example.com` }, 'spammer')).ok);
    assert.strictEqual((await gas.post({ action: 'joinWaitlist', email: 'p11@example.com' }, 'spammer')).error, 'limit');
  });

  await ok('owner page: key is made once, only the right key reads, nothing else leaks', async () => {
    const a = await gas.post({ action: 'adminSetup' });
    assert(a.ok && a.key.length === 32);
    assert.strictEqual((await gas.post({ action: 'adminSetup' })).error, 'invalid');
    assert.strictEqual((await gas.get({ action: 'admin', key: 'nope' })).error, 'bad_key');
    assert.strictEqual((await gas.get({ action: 'admin' })).error, 'bad_key');
    const r = await gas.get({ action: 'admin', key: a.key });
    assert(r.ok); assert(r.waitlist.some(w => w.email === 'mom@example.com'));
    assert(r.teams.length > 3 && typeof r.totalOrders === 'number');
    const s = JSON.stringify(r);
    assert(!s.includes(t.adminKey) && !s.includes(o1.editKey), 'no private team or order keys');
  });
  await ok('owner page: guessing the key is limited', async () => {
    for (let i = 0; i < 30; i++) assert.strictEqual((await gas.get({ action: 'admin', key: 'guess' + i }, 'guesser')).error, 'bad_key');
    assert.strictEqual((await gas.get({ action: 'admin', key: 'guess31' }, 'guesser')).error, 'limit');
  });

  console.log('\n' + passed + ' checks passed');
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
