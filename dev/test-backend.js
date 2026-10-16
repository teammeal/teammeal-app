/* Tests for backend/Code.gs using the local mock. Run: node dev/test-backend.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { load } = require('./gas-mock');

const menu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fordsgarage-menu.json'), 'utf8'));
const roster = [{ number: '17', first: 'Alex', last: 'Smith' }, { number: '9', first: 'Eli', last: 'Jones' }, { number: '07', first: 'Casey', last: 'Lee' }];
const burger = menu.sections.find(s => s.name === 'Burgers of Fame').items.find(i => i.name === 'American Standard');
const opt = burger.options[0];
const mk = (num, names, extra = {}) => ({
  num,
  people: names.map(n => ({
    name: n, allergies: [], notes: '',
    items: [{ item: 'American Standard', price: 0.01, options: { [opt.name]: opt.choices[0] }, sides: Array(burger.sideCount).fill(menu.sides[0]), changes: '', ...extra }]
  }))
});
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('ok  ', name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const gas = load();

  ok('ping', () => assert.strictEqual(gas.get({ action: 'ping' }).service, 'teammeal'));
  ok('createTeam rejects missing name', () => assert.strictEqual(gas.post({ action: 'createTeam', team: '', roster, menu }).error, 'invalid'));
  ok('createTeam rejects bad roster number', () => assert.strictEqual(gas.post({ action: 'createTeam', team: 'X', roster: [{ number: 'abc', first: 'A' }], menu }).error, 'invalid'));
  ok('createTeam rejects bad link', () => assert.strictEqual(gas.post({ action: 'createTeam', team: 'X', menuLink: 'javascript:alert(1)', roster, menu }).error, 'invalid'));
  ok('bad json', () => assert.strictEqual(gas.postRaw('not json').error, 'invalid'));
  ok('writes need POST', () => assert.strictEqual(gas.get({ action: 'createTeam' }).error, 'invalid'));

  const t = gas.post({ action: 'createTeam', team: 'Hawks 10U', menuLink: 'https://example.com/menu', roster, menu });
  ok('createTeam works', () => { assert(t.ok); assert(/^hawks10u-[a-z0-9]{4}$/.test(t.id)); assert.strictEqual(t.adminKey.length, 32); });

  ok('public team has no admin key or roster names', () => {
    const r = gas.get({ action: 'team', id: t.id });
    assert(r.ok); const s = JSON.stringify(r);
    assert(!s.includes(t.adminKey)); assert(!s.includes('Smith'));
    assert.deepStrictEqual(r.team.numbers, ['17', '9', '07']);
    assert.strictEqual(r.team.menu.sections.length, menu.sections.length);
    assert.strictEqual(r.team.closed, false);
  });
  ok('unknown team', () => assert.strictEqual(gas.get({ action: 'team', id: 'nope' }).error, 'not_found'));

  /* orders */
  const o1 = gas.post({ action: 'submitOrder', teamId: t.id, order: mk('17', ['Alex', 'Dana', 'Jo']) });
  ok('submit works', () => { assert(o1.ok); assert(o1.orderId && o1.editKey); });
  ok('price comes from the menu, not the client', () => {
    const r = gas.get({ action: 'order', orderId: o1.orderId, key: o1.editKey });
    assert.strictEqual(r.order.people[0].items[0].price, burger.price);
    assert.strictEqual(r.order.total, Math.round(burger.price * 300) / 100);
  });
  ok('submit rejects unknown item', () => { const o = mk('17', ['A']); o.people[0].items[0].item = 'Fake'; assert.strictEqual(gas.post({ action: 'submitOrder', teamId: t.id, order: o }).error, 'invalid'); });
  ok('submit rejects missing option', () => { const o = mk('17', ['A']); o.people[0].items[0].options = {}; assert.strictEqual(gas.post({ action: 'submitOrder', teamId: t.id, order: o }).error, 'invalid'); });
  ok('submit rejects bad side', () => { const o = mk('17', ['A']); o.people[0].items[0].sides = ['Caviar']; assert.strictEqual(gas.post({ action: 'submitOrder', teamId: t.id, order: o }).error, 'invalid'); });
  ok('submit rejects bad number', () => assert.strictEqual(gas.post({ action: 'submitOrder', teamId: t.id, order: mk('1234', ['A']) }).error, 'invalid'));
  ok('submit rejects empty person', () => { const o = mk('17', ['A']); o.people[0].items = []; assert.strictEqual(gas.post({ action: 'submitOrder', teamId: t.id, order: o }).error, 'invalid'); });
  ok('lines sheet has 3 rows for 3 people', () => assert.strictEqual(gas.ss.getSheetByName('Lines').rows.length - 1, 3));

  const o2 = gas.post({ action: 'submitOrder', teamId: t.id, order: mk('9', ['Eli', 'Mia']) });
  ok('second order for another number', () => assert(o2.ok));
  const o3 = gas.post({ action: 'submitOrder', teamId: t.id, order: mk('17', ['Parent']) });
  ok('same number can have two separate orders', () => assert(o3.ok && o3.orderId !== o1.orderId));

  /* access */
  ok('edit key cannot read all orders', () => assert.strictEqual(gas.get({ action: 'orders', id: t.id, key: o1.editKey }).error, 'bad_key'));
  ok('no key cannot read all orders', () => assert.strictEqual(gas.get({ action: 'orders', id: t.id }).error, 'bad_key'));
  ok('organizer reads all orders incl. roster', () => {
    const r = gas.get({ action: 'orders', id: t.id, key: t.adminKey });
    assert(r.ok); assert.strictEqual(r.orders.length, 3); assert.strictEqual(r.team.roster[0].last, 'Smith');
    assert(!JSON.stringify(r).includes(o1.editKey));
  });
  ok('order read needs the right key', () => {
    assert.strictEqual(gas.get({ action: 'order', orderId: o1.orderId, key: o2.editKey }).error, 'bad_key');
    assert(gas.get({ action: 'order', orderId: o1.orderId, key: t.adminKey }).isAdmin);
  });

  /* the Suzy case: remove a person and change an item */
  const edited = mk('17', ['Alex', 'Jo']);
  edited.people[1].items[0].changes = '=HYPERLINK("http://x")';
  ok('owner edits own order (removes a person)', () => assert(gas.post({ action: 'updateOrder', orderId: o1.orderId, key: o1.editKey, order: edited }).ok));
  ok('edit replaced the order, no duplicates', () => {
    const r = gas.get({ action: 'order', orderId: o1.orderId, key: o1.editKey });
    assert.deepStrictEqual(r.order.people.map(p => p.name), ['Alex', 'Jo']);
    assert.strictEqual(gas.get({ action: 'orders', id: t.id, key: t.adminKey }).orders.length, 3);
    const lines = gas.ss.getSheetByName('Lines').rows.slice(1).filter(l => l[11] === o1.orderId);
    assert.strictEqual(lines.length, 2);
    assert(lines.some(l => l[7] === "'=HYPERLINK(\"http://x\")"), 'formula text must be neutralised');
  });
  ok('someone else cannot edit it', () => assert.strictEqual(gas.post({ action: 'updateOrder', orderId: o1.orderId, key: o2.editKey, order: edited }).error, 'bad_key'));
  ok('organizer can edit anyone', () => assert(gas.post({ action: 'updateOrder', orderId: o2.orderId, key: t.adminKey, order: mk('9', ['Eli']) }).ok));
  ok('changing the player number works', () => { assert(gas.post({ action: 'updateOrder', orderId: o3.orderId, key: o3.editKey, order: mk('9', ['Parent']) }).ok); assert.strictEqual(gas.get({ action: 'order', orderId: o3.orderId, key: o3.editKey }).order.num, '9'); });

  /* delete */
  ok('owner removes whole order', () => {
    assert(gas.post({ action: 'deleteOrder', orderId: o3.orderId, key: o3.editKey }).ok);
    assert.strictEqual(gas.get({ action: 'order', orderId: o3.orderId, key: o3.editKey }).error, 'not_found');
    assert.strictEqual(gas.get({ action: 'orders', id: t.id, key: t.adminKey }).orders.length, 2);
    assert.strictEqual(gas.ss.getSheetByName('Lines').rows.slice(1).filter(l => l[11] === o3.orderId).length, 0);
  });
  ok('wrong key cannot delete', () => assert.strictEqual(gas.post({ action: 'deleteOrder', orderId: o1.orderId, key: 'x' }).error, 'bad_key'));

  /* deadline */
  const soon = gas.post({ action: 'createTeam', team: 'Deadline Team', orderBy: Date.now() + 400, roster, menu });
  const early = gas.post({ action: 'submitOrder', teamId: soon.id, order: mk('17', ['Alex']) });
  ok('can order before the deadline', () => assert(early.ok));
  await sleep(600);
  ok('team shows closed', () => assert.strictEqual(gas.get({ action: 'team', id: soon.id }).team.closed, true));
  ok('new orders blocked after deadline', () => assert.strictEqual(gas.post({ action: 'submitOrder', teamId: soon.id, order: mk('9', ['Eli']) }).error, 'closed'));
  ok('owner edit blocked after deadline', () => assert.strictEqual(gas.post({ action: 'updateOrder', orderId: early.orderId, key: early.editKey, order: mk('17', ['Alex', 'Zed']) }).error, 'closed'));
  ok('owner delete blocked after deadline', () => assert.strictEqual(gas.post({ action: 'deleteOrder', orderId: early.orderId, key: early.editKey }).error, 'closed'));
  ok('owner can still read their order after deadline (locked)', () => assert.strictEqual(gas.get({ action: 'order', orderId: early.orderId, key: early.editKey }).locked, true));
  ok('organizer can edit after deadline', () => assert(gas.post({ action: 'updateOrder', orderId: early.orderId, key: soon.adminKey, order: mk('17', ['Alex', 'Zed']) }).ok));
  ok('organizer can delete after deadline', () => assert(gas.post({ action: 'deleteOrder', orderId: early.orderId, key: soon.adminKey }).ok));

  /* sheets text */
  ok('teams sheet keeps the menu in chunks and a roster', () => {
    const row = gas.ss.getSheetByName('Teams').rows[1];
    assert(JSON.parse(row[7] + (row[8] || '') + (row[9] || '') + (row[10] || '') + (row[11] || '')).sections.length > 0);
    assert(JSON.parse(row[6]).length === 3);
  });
  ok('one spreadsheet, three tabs', () => assert.deepStrictEqual(gas.sheets.map(s => s.name), ['Teams', 'Orders', 'Lines']));

  console.log('\n' + passed + ' checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
