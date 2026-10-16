/**
 * Team Meal backend. Cloudflare Pages Function at /api, storing data in a Cloudflare D1 database
 * bound to the project as DB. No Google account involved.
 *
 * Access model (no accounts):
 *  - Anyone with a team link can read the team and menu and place orders.
 *  - Each order has a private edit key. It can change or remove that one order.
 *  - Each team has a private organizer key. It can read, change, or remove every order.
 *  - Normal edit keys stop working at the order deadline. The organizer key never does.
 *
 * Actions: GET ping | team | order | orders | csv      POST createTeam | submitOrder | updateOrder | deleteOrder
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, order_by INTEGER NOT NULL DEFAULT 0, menu_link TEXT NOT NULL DEFAULT '',
    admin_key TEXT NOT NULL, created INTEGER NOT NULL, roster TEXT NOT NULL, menu TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, edit_key TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    player_number TEXT NOT NULL, people INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', payload TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS orders_team ON orders (team_id, status)`,
  `CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (k, bucket))`
];

/* Limits. Normal use never gets near these; they stop one connection from flooding the site.
   Each is [max, window in ms]. Counted per connection (a scrambled fingerprint of the IP address, never the address itself). */
const LIMITS = {
  createTeam: [5, 24 * 3600e3],     /* 5 new teams per connection per day */
  submitOrder: [60, 3600e3],        /* 60 new orders per connection per hour (a whole rink on one wifi is fine) */
  change: [120, 3600e3],            /* 120 edits or removals per connection per hour */
  joinWaitlist: [10, 3600e3]        /* 10 wait list sign-ups per connection per hour */
};
const SITE_TEAMS_PER_DAY = 200;     /* all connections together */
const ORDERS_PER_TEAM = 300;        /* one team link can hold at most this many orders */
let ready = false;

const fail = (code, message) => Object.assign(new Error(message), { code });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  try {
    if (!env.DB) throw fail('server', 'The database is not connected yet.');
    if (!ready) { await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))); ready = true; }
    const WRITES = { joinWaitlist: 1, createTeam: 1, submitOrder: 1, updateOrder: 1, deleteOrder: 1 };
    let action, p;
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > 400000) throw fail('invalid', 'That request is too large.');
      try { p = JSON.parse(text || '{}'); } catch (e) { throw fail('invalid', 'That request was not readable.'); }
      if (!p || typeof p !== 'object') throw fail('invalid', 'That request was not readable.');
      action = p.action;
    } else if (request.method === 'GET') {
      p = Object.fromEntries(url.searchParams); action = p.action || 'ping';
      if (WRITES[action]) throw fail('invalid', 'That action needs a POST.');
    } else {
      throw fail('invalid', 'Unsupported request.');
    }
    const db = env.DB;
    if (WRITES[action]) await enforceLimits(db, request, action);
    switch (action) {
      case 'ping': return json({ ok: true, service: 'teammeal' });
      case 'team': return json({ ok: true, ...(await getTeam(db, p)) });
      case 'order': return json({ ok: true, ...(await getOrder(db, p)) });
      case 'orders': return json({ ok: true, ...(await getOrders(db, p)) });
      case 'csv': return await getCsv(db, p);
      case 'joinWaitlist': return json({ ok: true, ...(await joinWaitlist(db, p)) });
      case 'createTeam': return json({ ok: true, ...(await createTeam(db, p)) });
      case 'submitOrder': return json({ ok: true, ...(await submitOrder(db, p)) });
      case 'updateOrder': return json({ ok: true, ...(await updateOrder(db, p)) });
      case 'deleteOrder': return json({ ok: true, ...(await deleteOrder(db, p)) });
      default: throw fail('invalid', 'Unknown action.');
    }
  } catch (err) {
    if (err && err.code) return json({ ok: false, error: err.code, message: err.message });
    return json({ ok: false, error: 'server', message: 'Something went wrong on our side. Please try again.' });
  }
}

/* ---------- limits ---------- */

async function who(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('teammeal|' + ip));
  return Array.from(new Uint8Array(bytes).slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function bump(db, key, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const r = await db.prepare('INSERT INTO hits (k, bucket, n, until) VALUES (?, ?, 1, ?) ON CONFLICT (k, bucket) DO UPDATE SET n = n + 1 RETURNING n').bind(key, bucket, (bucket + 1) * windowMs).first();
  return r ? Number(r.n) : 1;
}
async function enforceLimits(db, request, action) {
  const kind = (action === 'updateOrder' || action === 'deleteOrder') ? 'change' : action;
  const [max, windowMs] = LIMITS[kind];
  const me = await who(request);
  if (await bump(db, kind + ':' + me, windowMs) > max) {
    throw fail('limit', kind === 'createTeam' ? 'You have made a lot of teams today. Please try again tomorrow.' : 'Too many requests from this connection. Please wait a little while and try again.');
  }
  if (action === 'createTeam' && await bump(db, 'site:createTeam', 24 * 3600e3) > SITE_TEAMS_PER_DAY) {
    throw fail('limit', 'Team Meal is very busy right now. Please try again later.');
  }
  if (Math.random() < 0.02) await db.prepare('DELETE FROM hits WHERE until < ?').bind(Date.now()).run().catch(() => {});
}

/* ---------- storage ---------- */

const safeJson = (s, d) => { try { return s ? JSON.parse(String(s)) : d; } catch (e) { return d; } };
const newKey = () => crypto.randomUUID().replace(/-/g, '');

function teamFromRow(r) {
  return { id: r.id, name: r.name, orderBy: Number(r.order_by) || 0, menuLink: r.menu_link || '', adminKey: r.admin_key,
    created: Number(r.created) || 0, roster: safeJson(r.roster, []), menu: safeJson(r.menu, null) };
}
async function findTeam(db, id) {
  id = String(id || '');
  if (!id) throw fail('not_found', 'That team link is missing its team.');
  const r = await db.prepare('SELECT * FROM teams WHERE id = ?').bind(id).first();
  if (!r) throw fail('not_found', 'We could not find that team. Check the link.');
  return teamFromRow(r);
}
const orderFromRow = r => ({ orderId: r.order_id, teamId: r.team_id, editKey: r.edit_key, created: Number(r.created) || 0,
  updated: Number(r.updated) || 0, status: r.status, payload: safeJson(r.payload, null) });
async function findOrder(db, orderId) {
  const r = await db.prepare("SELECT * FROM orders WHERE order_id = ? AND status = 'active'").bind(String(orderId || '')).first();
  if (!r) throw fail('not_found', 'We could not find that order. It may have been removed.');
  return orderFromRow(r);
}

/* ---------- checks and cleaning ---------- */

function str(x, max) {
  let s = (x === null || x === undefined) ? '' : String(x);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'team';

async function makeTeamId(db, name) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (let tries = 0; tries < 20; tries++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    let suffix = '';
    for (const b of bytes) suffix += chars.charAt(b % chars.length);
    const id = slug(name) + '-' + suffix;
    const hit = await db.prepare('SELECT 1 AS x FROM teams WHERE id = ?').bind(id).first();
    if (!hit) return id;
  }
  throw fail('server', 'Could not make a team id. Try again.');
}

function cleanRoster(list) {
  if (!Array.isArray(list)) throw fail('invalid', 'The roster is missing.');
  if (list.length < 1 || list.length > 80) throw fail('invalid', 'The roster needs 1 to 80 players.');
  return list.map(p => {
    const num = str(p && p.number, 3).replace(/^#/, '');
    if (!/^\d{1,3}$/.test(num)) throw fail('invalid', 'Every player needs a number with 1 to 3 digits.');
    const first = str(p && p.first, 40);
    if (!first) throw fail('invalid', 'Every player needs a first name.');
    return { number: num, first, last: str(p && p.last, 40) };
  });
}

function cleanMenu(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.sections) || !m.sections.length) throw fail('invalid', 'The menu is missing.');
  let items = 0;
  const clean = { restaurant: str(m.restaurant, 80), sides: (Array.isArray(m.sides) ? m.sides : []).map(s => str(s, 60)).filter(Boolean).slice(0, 40), sections: [] };
  if (!clean.restaurant) throw fail('invalid', 'The menu needs a restaurant name.');
  m.sections.slice(0, 40).forEach(s => {
    const name = str(s && s.name, 80);
    if (!name || !Array.isArray(s.items)) throw fail('invalid', 'A menu section is missing its name or items.');
    const sec = { name, note: str(s.note, 300), items: [] };
    s.items.slice(0, 200).forEach(it => {
      const n = str(it && it.name, 100);
      const price = Number(it && it.price);
      if (!n || !isFinite(price) || price < 0 || price > 1000) throw fail('invalid', 'Every menu item needs a name and a price.');
      const sideCount = Math.floor(Number(it.sideCount) || 0);
      if (sideCount < 0 || sideCount > 4) throw fail('invalid', '"' + n + '" has an odd number of sides.');
      const opts = (Array.isArray(it.options) ? it.options : []).slice(0, 8).map(o => ({
        name: str(o && o.name, 40),
        choices: (Array.isArray(o && o.choices) ? o.choices : []).map(c => str(c, 60)).filter(Boolean).slice(0, 30)
      })).filter(o => o.name && o.choices.length >= 2);
      sec.items.push({ name: n, price: Math.round(price * 100) / 100, description: str(it.description, 300), sideCount, options: opts });
      items++;
    });
    if (sec.items.length) clean.sections.push(sec);
  });
  if (!items) throw fail('invalid', 'The menu has no items.');
  return clean;
}

function cleanOrder(o, menu) {
  if (!o || typeof o !== 'object') throw fail('invalid', 'The order is missing.');
  const num = str(o.num, 4).replace(/^#/, '');
  if (!/^\d{1,3}$/.test(num)) throw fail('invalid', 'The player number needs 1 to 3 digits.');
  if (!Array.isArray(o.people) || o.people.length < 1 || o.people.length > 30) throw fail('invalid', 'An order needs 1 to 30 people.');
  const byName = {};
  menu.sections.forEach(s => s.items.forEach(it => { byName[it.name] = it; }));
  let total = 0, itemCount = 0;
  const people = o.people.map(p => {
    const name = str(p && p.name, 40);
    if (!name) throw fail('invalid', 'Everyone on the order needs a name.');
    if (!Array.isArray(p.items) || !p.items.length) throw fail('invalid', name + ' has no food on the order.');
    const items = p.items.map(li => {
      const it = byName[li && li.item];
      if (!it) throw fail('invalid', 'One of the items is not on this menu.');
      const options = {};
      const given = (li.options && typeof li.options === 'object') ? li.options : {};
      it.options.forEach(op => {
        const v = str(given[op.name], 60);
        if (op.choices.indexOf(v) < 0) throw fail('invalid', 'Pick a ' + op.name + ' for ' + it.name + '.');
        options[op.name] = v;
      });
      const sides = (Array.isArray(li.sides) ? li.sides : []).slice(0, 4).map(s => str(s, 60));
      if (sides.length !== it.sideCount) throw fail('invalid', 'Pick your side choices for ' + it.name + '.');
      sides.forEach(s => { if ((menu.sides || []).indexOf(s) < 0) throw fail('invalid', 'That side is not on this menu.'); });
      total += it.price; itemCount++;
      return { item: it.name, price: it.price, options, sides, changes: str(li.changes, 200) };
    });
    const allergies = (Array.isArray(p.allergies) ? p.allergies : []).slice(0, 12).map(a => str(a, 40)).filter(Boolean);
    return { name, allergies, notes: str(p.notes, 500), items };
  });
  if (itemCount > 150) throw fail('invalid', 'That is too many items for one order.');
  const clean = { num, first: people[0].name, total: Math.round(total * 100) / 100, people };
  if (JSON.stringify(clean).length > 40000) throw fail('invalid', 'That order is too large.');
  return clean;
}

const isClosed = team => !!team.orderBy && Date.now() > team.orderBy;

function authFor(team, order, key) {
  key = String(key || '');
  if (!key) throw fail('bad_key', 'That link is missing its key.');
  if (key === team.adminKey) return { admin: true };
  if (order && key === order.editKey) return { admin: false };
  throw fail('bad_key', 'That link is not valid for this order.');
}

/* ---------- reads ---------- */

const publicTeam = t => ({ id: t.id, name: t.name, orderBy: t.orderBy, menuLink: t.menuLink, closed: isClosed(t),
  numbers: t.roster.map(p => p.number), menu: t.menu });

async function getTeam(db, p) { return { team: publicTeam(await findTeam(db, p.id)) }; }

async function getOrder(db, p) {
  const order = await findOrder(db, p.orderId);
  const team = await findTeam(db, order.teamId);
  const auth = authFor(team, order, p.key);
  return { orderId: order.orderId, order: order.payload, created: order.created, updated: order.updated,
    isAdmin: auth.admin, locked: isClosed(team) && !auth.admin, team: publicTeam(team) };
}

async function activeOrders(db, teamId) {
  const rs = await db.prepare("SELECT * FROM orders WHERE team_id = ? AND status = 'active' ORDER BY created").bind(teamId).all();
  return (rs.results || []).map(orderFromRow);
}

async function getOrders(db, p) {
  const team = await findTeam(db, p.id);
  if (String(p.key || '') !== team.adminKey) throw fail('bad_key', 'That is not the organizer link.');
  const orders = (await activeOrders(db, team.id)).map(o => ({ orderId: o.orderId, playerNumber: o.payload ? o.payload.num : '',
    created: o.created, updated: o.updated, order: o.payload }));
  const pub = publicTeam(team);
  pub.roster = team.roster;
  return { team: pub, orders };
}

/* One row per person per item, for opening in Excel or Google Sheets. */
async function getCsv(db, p) {
  const team = await findTeam(db, p.id);
  if (String(p.key || '') !== team.adminKey) throw fail('bad_key', 'That is not the organizer link.');
  const safe = v => { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  const rows = [['Player #', 'Person', 'Item', 'Options', 'Sides', 'Changes', 'Allergies', 'Notes', 'Price', 'Updated'].map(safe).join(',')];
  (await activeOrders(db, team.id)).forEach(o => {
    if (!o.payload) return;
    o.payload.people.forEach(pe => pe.items.forEach(li => {
      rows.push([o.payload.num, pe.name, li.item, Object.keys(li.options).map(k => k + ': ' + li.options[k]).join('; '), li.sides.join(', '),
        li.changes, pe.allergies.join(', '), pe.notes, li.price.toFixed(2), new Date(o.updated).toISOString()].map(safe).join(','));
    }));
  });
  return new Response('﻿' + rows.join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="' + slug(team.name) + '-orders.csv"', 'Cache-Control': 'no-store' } });
}

/* ---------- writes ---------- */

/* Wait list for the home page. Emails are read in the Cloudflare dashboard (D1 > teammeal > Explore data > waitlist). */
async function joinWaitlist(db, b) {
  if (str(b.company, 100)) return {}; /* hidden field only bots fill in: pretend it worked */
  const email = str(b.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw fail('invalid', 'Enter a valid email address, like you@example.com.');
  await db.prepare('INSERT OR IGNORE INTO waitlist (email, created) VALUES (?, ?)').bind(email, Date.now()).run();
  return {};
}

async function createTeam(db, b) {
  const name = str(b.team, 60);
  if (!name) throw fail('invalid', 'The team needs a name.');
  const link = str(b.menuLink, 300);
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw fail('invalid', 'The menu link must start with http:// or https://.');
  let orderBy = 0;
  if (b.orderBy) {
    orderBy = typeof b.orderBy === 'number' ? b.orderBy : Date.parse(b.orderBy);
    if (!isFinite(orderBy)) throw fail('invalid', 'The order-by time is not a valid date.');
  }
  const roster = cleanRoster(b.roster);
  const menu = cleanMenu(b.menu);
  const menuText = JSON.stringify(menu);
  if (menuText.length > 200000) throw fail('invalid', 'That menu is too large.');
  const id = await makeTeamId(db, name);
  const adminKey = newKey();
  await db.prepare('INSERT INTO teams (id, name, order_by, menu_link, admin_key, created, roster, menu) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, orderBy, link, adminKey, Date.now(), JSON.stringify(roster), menuText).run();
  return { id, adminKey };
}

async function submitOrder(db, b) {
  const team = await findTeam(db, b.teamId);
  if (isClosed(team)) throw fail('closed', 'Ordering for this team has closed.');
  const cnt = await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE team_id = ? AND status = 'active'").bind(team.id).first();
  if (cnt && Number(cnt.c) >= ORDERS_PER_TEAM) throw fail('limit', 'This team has reached its limit of ' + ORDERS_PER_TEAM + ' orders. Ask your organizer.');
  const payload = cleanOrder(b.order, team.menu);
  const now = Date.now();
  const orderId = 'o' + newKey().slice(0, 12), editKey = newKey();
  await db.prepare("INSERT INTO orders (order_id, team_id, edit_key, created, updated, player_number, people, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)")
    .bind(orderId, team.id, editKey, now, now, payload.num, payload.people.length, JSON.stringify(payload)).run();
  return { orderId, editKey };
}

async function updateOrder(db, b) {
  const order = await findOrder(db, b.orderId);
  const team = await findTeam(db, order.teamId);
  const auth = authFor(team, order, b.key);
  if (isClosed(team) && !auth.admin) throw fail('closed', 'Ordering has closed. Ask your organizer to make the change.');
  const payload = cleanOrder(b.order, team.menu);
  await db.prepare("UPDATE orders SET updated = ?, player_number = ?, people = ?, payload = ? WHERE order_id = ? AND status = 'active'")
    .bind(Date.now(), payload.num, payload.people.length, JSON.stringify(payload), order.orderId).run();
  return { orderId: order.orderId };
}

async function deleteOrder(db, b) {
  const order = await findOrder(db, b.orderId);
  const team = await findTeam(db, order.teamId);
  const auth = authFor(team, order, b.key);
  if (isClosed(team) && !auth.admin) throw fail('closed', 'Ordering has closed. Ask your organizer to remove it.');
  /* Removed orders keep nothing: the names and food are wiped, only the id stays. */
  await db.prepare("UPDATE orders SET status = 'deleted', updated = ?, payload = '{}' WHERE order_id = ?").bind(Date.now(), order.orderId).run();
  return { orderId: order.orderId };
}
