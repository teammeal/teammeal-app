/**
 * Team Meal backend. Google Apps Script web app.
 *
 * Deploy: script.google.com > New project > paste this file > Deploy > New deployment >
 * Web app > Execute as: Me, Who has access: Anyone. Copy the /exec URL into teammeal-config.js.
 * The first request creates a Google Sheet called "Team Meal data" in the owner's Drive and
 * remembers it. Tabs: Teams, Orders (one row per order, JSON inside), Lines (one row per
 * item, easy to read and sort).
 *
 * Access model (no accounts):
 *  - Anyone with a team link can read the team and menu and place orders.
 *  - Each order has a private edit key. It can change or remove that one order.
 *  - Each team has a private organizer key. It can read, change, or remove every order.
 *  - Normal edit keys stop working at the order deadline. The organizer key never does.
 */

var SHEET_NAMES = { teams: 'Teams', orders: 'Orders', lines: 'Lines' };
var TEAM_HEAD = ['id', 'name', 'orderBy', 'menuLink', 'adminKey', 'created', 'roster', 'menu1', 'menu2', 'menu3', 'menu4', 'menu5'];
var ORDER_HEAD = ['orderId', 'teamId', 'editKey', 'created', 'updated', 'playerNumber', 'people', 'status', 'payload'];
var LINE_HEAD = ['Updated', 'Team', 'Player #', 'Person', 'Item', 'Options', 'Sides', 'Changes', 'Allergies', 'Notes', 'Price', 'OrderId'];
var CHUNK = 40000;
var MENU_COLS = 5;
var _db = null;

/* ---------- web app entry points ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  return run_(p.action || 'ping', p, false);
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'invalid', message: 'That request was not readable.' }); }
  return run_(body.action, body, true);
}

function run_(action, p, isPost) {
  var lock = null;
  try {
    var writes = { createTeam: 1, submitOrder: 1, updateOrder: 1, deleteOrder: 1 };
    if (writes[action]) {
      if (!isPost) throw fail_('invalid', 'That action needs a POST.');
      lock = LockService.getScriptLock();
      lock.waitLock(20000);
    }
    var res;
    switch (action) {
      case 'ping': res = { service: 'teammeal' }; break;
      case 'team': res = getTeam_(p); break;
      case 'order': res = getOrder_(p); break;
      case 'orders': res = getOrders_(p); break;
      case 'createTeam': res = createTeam_(p); break;
      case 'submitOrder': res = submitOrder_(p); break;
      case 'updateOrder': res = updateOrder_(p); break;
      case 'deleteOrder': res = deleteOrder_(p); break;
      default: throw fail_('invalid', 'Unknown action.');
    }
    res.ok = true;
    return out_(res);
  } catch (err) {
    if (err && err.code) return out_({ ok: false, error: err.code, message: err.message });
    return out_({ ok: false, error: 'server', message: 'Something went wrong on our side. Please try again.' });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(code, message) { return { code: code, message: message }; }

/* ---------- storage ---------- */

function db_() {
  if (_db) return _db;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SSID');
  var ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create('Team Meal data'); props.setProperty('SSID', ss.getId()); }
  function sheet(name, head, textCols) {
    var s = ss.getSheetByName(name);
    if (s) return s;
    var all = ss.getSheets();
    if (all.length === 1 && all[0].getName() === 'Sheet1' && all[0].getLastRow() === 0) { s = all[0]; s.setName(name); }
    else s = ss.insertSheet(name);
    s.appendRow(head);
    s.setFrozenRows(1);
    (textCols || []).forEach(function (c) { s.getRange(1, c, 500, 1).setNumberFormat('@'); });
    return s;
  }
  _db = {
    ss: ss,
    teams: sheet(SHEET_NAMES.teams, TEAM_HEAD, []),
    orders: sheet(SHEET_NAMES.orders, ORDER_HEAD, [6]),
    lines: sheet(SHEET_NAMES.lines, LINE_HEAD, [3])
  };
  return _db;
}

function rows_(sheet) {
  var v = sheet.getDataRange().getValues();
  return v.slice(1);
}

function teamFromRow_(r, rowNum) {
  var menuText = '';
  for (var i = 0; i < MENU_COLS; i++) menuText += String(r[7 + i] || '');
  return {
    row: rowNum,
    id: String(r[0]), name: String(r[1]), orderBy: Number(r[2]) || 0, menuLink: String(r[3] || ''),
    adminKey: String(r[4]), created: Number(r[5]) || 0,
    roster: safeJson_(r[6], []), menu: safeJson_(menuText, null)
  };
}

function findTeam_(id) {
  id = String(id || '');
  if (!id) throw fail_('not_found', 'That team link is missing its team.');
  var rs = rows_(db_().teams);
  for (var i = 0; i < rs.length; i++) {
    if (String(rs[i][0]) === id) return teamFromRow_(rs[i], i + 2);
  }
  throw fail_('not_found', 'We could not find that team. Check the link.');
}

function orderFromRow_(r, rowNum) {
  return {
    row: rowNum, orderId: String(r[0]), teamId: String(r[1]), editKey: String(r[2]),
    created: Number(r[3]) || 0, updated: Number(r[4]) || 0, status: String(r[7]),
    payload: safeJson_(r[8], null)
  };
}

function findOrder_(orderId) {
  orderId = String(orderId || '');
  var rs = rows_(db_().orders);
  for (var i = 0; i < rs.length; i++) {
    if (String(rs[i][0]) === orderId && String(rs[i][7]) === 'active') return orderFromRow_(rs[i], i + 2);
  }
  throw fail_('not_found', 'We could not find that order. It may have been removed.');
}

function safeJson_(s, dflt) {
  try { return s ? JSON.parse(String(s)) : dflt; } catch (e) { return dflt; }
}

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '');
}

/* ---------- checks and cleaning ---------- */

function str_(x, max) {
  var s = (x === null || x === undefined) ? '' : String(x);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function slug_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'team';
}

function makeTeamId_(name) {
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (var tries = 0; tries < 20; tries++) {
    var suffix = '';
    for (var i = 0; i < 4; i++) suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    var id = slug_(name) + '-' + suffix;
    try { findTeam_(id); } catch (e) { return id; }
  }
  throw fail_('server', 'Could not make a team id. Try again.');
}

function cleanRoster_(list) {
  if (!Array.isArray(list)) throw fail_('invalid', 'The roster is missing.');
  if (list.length < 1 || list.length > 80) throw fail_('invalid', 'The roster needs 1 to 80 players.');
  return list.map(function (p) {
    var num = str_(p && p.number, 3).replace(/^#/, '');
    if (!/^\d{1,3}$/.test(num)) throw fail_('invalid', 'Every player needs a number with 1 to 3 digits.');
    var first = str_(p && p.first, 40);
    if (!first) throw fail_('invalid', 'Every player needs a first name.');
    return { number: num, first: first, last: str_(p && p.last, 40) };
  });
}

function cleanMenu_(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.sections) || !m.sections.length) throw fail_('invalid', 'The menu is missing.');
  var items = 0;
  var clean = { restaurant: str_(m.restaurant, 80), sides: (Array.isArray(m.sides) ? m.sides : []).map(function (s) { return str_(s, 60); }).filter(Boolean).slice(0, 40), sections: [] };
  if (!clean.restaurant) throw fail_('invalid', 'The menu needs a restaurant name.');
  m.sections.slice(0, 40).forEach(function (s) {
    var name = str_(s && s.name, 80);
    if (!name || !Array.isArray(s.items)) throw fail_('invalid', 'A menu section is missing its name or items.');
    var sec = { name: name, note: str_(s.note, 300), items: [] };
    s.items.slice(0, 200).forEach(function (it) {
      var n = str_(it && it.name, 100);
      var price = Number(it && it.price);
      if (!n || !isFinite(price) || price < 0 || price > 1000) throw fail_('invalid', 'Every menu item needs a name and a price.');
      var sideCount = Math.floor(Number(it.sideCount) || 0);
      if (sideCount < 0 || sideCount > 4) throw fail_('invalid', '"' + n + '" has an odd number of sides.');
      var opts = (Array.isArray(it.options) ? it.options : []).slice(0, 8).map(function (o) {
        var ch = (Array.isArray(o && o.choices) ? o.choices : []).map(function (c) { return str_(c, 60); }).filter(Boolean).slice(0, 30);
        return { name: str_(o && o.name, 40), choices: ch };
      }).filter(function (o) { return o.name && o.choices.length >= 2; });
      sec.items.push({ name: n, price: Math.round(price * 100) / 100, description: str_(it.description, 300), sideCount: sideCount, options: opts });
      items++;
    });
    if (sec.items.length) clean.sections.push(sec);
  });
  if (!items) throw fail_('invalid', 'The menu has no items.');
  return clean;
}

function cleanOrder_(o, menu) {
  if (!o || typeof o !== 'object') throw fail_('invalid', 'The order is missing.');
  var num = str_(o.num, 4).replace(/^#/, '');
  if (!/^\d{1,3}$/.test(num)) throw fail_('invalid', 'The player number needs 1 to 3 digits.');
  if (!Array.isArray(o.people) || o.people.length < 1 || o.people.length > 30) throw fail_('invalid', 'An order needs 1 to 30 people.');
  var byName = {};
  menu.sections.forEach(function (s) { s.items.forEach(function (it) { byName[it.name] = it; }); });
  var total = 0, itemCount = 0;
  var people = o.people.map(function (p) {
    var name = str_(p && p.name, 40);
    if (!name) throw fail_('invalid', 'Everyone on the order needs a name.');
    if (!Array.isArray(p.items) || !p.items.length) throw fail_('invalid', name + ' has no food on the order.');
    var items = p.items.map(function (li) {
      var it = byName[li && li.item];
      if (!it) throw fail_('invalid', 'One of the items is not on this menu.');
      var options = {};
      var given = (li.options && typeof li.options === 'object') ? li.options : {};
      it.options.forEach(function (op) {
        var v = str_(given[op.name], 60);
        if (op.choices.indexOf(v) < 0) throw fail_('invalid', 'Pick a ' + op.name + ' for ' + it.name + '.');
        options[op.name] = v;
      });
      var sides = (Array.isArray(li.sides) ? li.sides : []).slice(0, 4).map(function (s) { return str_(s, 60); });
      if (sides.length !== it.sideCount) throw fail_('invalid', 'Pick your side choices for ' + it.name + '.');
      sides.forEach(function (s) { if ((menu.sides || []).indexOf(s) < 0) throw fail_('invalid', 'That side is not on this menu.'); });
      total += it.price; itemCount++;
      return { item: it.name, price: it.price, options: options, sides: sides, changes: str_(li.changes, 200) };
    });
    var allergies = (Array.isArray(p.allergies) ? p.allergies : []).slice(0, 12).map(function (a) { return str_(a, 40); }).filter(Boolean);
    return { name: name, allergies: allergies, notes: str_(p.notes, 500), items: items };
  });
  if (itemCount > 150) throw fail_('invalid', 'That is too many items for one order.');
  var clean = { num: num, first: people[0].name, total: Math.round(total * 100) / 100, people: people };
  if (JSON.stringify(clean).length > 40000) throw fail_('invalid', 'That order is too large.');
  return clean;
}

function isClosed_(team) {
  return !!team.orderBy && Date.now() > team.orderBy;
}

function authFor_(team, order, key) {
  key = String(key || '');
  if (!key) throw fail_('bad_key', 'That link is missing its key.');
  if (key === team.adminKey) return { admin: true };
  if (order && key === order.editKey) return { admin: false };
  throw fail_('bad_key', 'That link is not valid for this order.');
}

/* ---------- reads ---------- */

function publicTeam_(t) {
  return {
    id: t.id, name: t.name, orderBy: t.orderBy, menuLink: t.menuLink, closed: isClosed_(t),
    numbers: t.roster.map(function (p) { return p.number; }), menu: t.menu
  };
}

function getTeam_(p) {
  return { team: publicTeam_(findTeam_(p.id)) };
}

function getOrder_(p) {
  var order = findOrder_(p.orderId);
  var team = findTeam_(order.teamId);
  var auth = authFor_(team, order, p.key);
  return {
    orderId: order.orderId, order: order.payload, created: order.created, updated: order.updated,
    isAdmin: auth.admin, locked: isClosed_(team) && !auth.admin, team: publicTeam_(team)
  };
}

function getOrders_(p) {
  var team = findTeam_(p.id);
  authFor_(team, null, p.key);
  if (String(p.key) !== team.adminKey) throw fail_('bad_key', 'That is not the organizer link.');
  var list = rows_(db_().orders).map(function (r, i) { return orderFromRow_(r, i + 2); })
    .filter(function (o) { return o.teamId === team.id && o.status === 'active'; })
    .map(function (o) { return { orderId: o.orderId, playerNumber: o.payload ? o.payload.num : '', created: o.created, updated: o.updated, order: o.payload }; });
  var pub = publicTeam_(team);
  pub.roster = team.roster;
  return { team: pub, orders: list };
}

/* ---------- writes ---------- */

function createTeam_(b) {
  var name = str_(b.team, 60);
  if (!name) throw fail_('invalid', 'The team needs a name.');
  var link = str_(b.menuLink, 300);
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw fail_('invalid', 'The menu link must start with http:// or https://.');
  var orderBy = 0;
  if (b.orderBy) {
    orderBy = typeof b.orderBy === 'number' ? b.orderBy : Date.parse(b.orderBy);
    if (!isFinite(orderBy)) throw fail_('invalid', 'The order-by time is not a valid date.');
  }
  var roster = cleanRoster_(b.roster);
  var menu = cleanMenu_(b.menu);
  var menuText = JSON.stringify(menu);
  if (menuText.length > CHUNK * MENU_COLS) throw fail_('invalid', 'That menu is too large.');
  var id = makeTeamId_(name);
  var adminKey = newKey_();
  var row = [id, name, orderBy, link, adminKey, Date.now(), JSON.stringify(roster)];
  for (var i = 0; i < MENU_COLS; i++) row.push(menuText.slice(i * CHUNK, (i + 1) * CHUNK));
  db_().teams.appendRow(row);
  return { id: id, adminKey: adminKey };
}

function writeLines_(team, orderId, payload, now) {
  var sheet = db_().lines;
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][11]) === orderId) sheet.deleteRow(i + 1);
  }
  if (!payload) return;
  var safe = function (v) { v = String(v == null ? '' : v); return /^[=+\-@]/.test(v) ? "'" + v : v; };
  var out = [];
  payload.people.forEach(function (p) {
    p.items.forEach(function (li) {
      var opts = Object.keys(li.options).map(function (k) { return k + ': ' + li.options[k]; }).join('; ');
      out.push([new Date(now).toISOString(), safe(team.name), payload.num, safe(p.name), safe(li.item), safe(opts), safe(li.sides.join(', ')),
        safe(li.changes), safe(p.allergies.join(', ')), safe(p.notes), li.price, orderId]);
    });
  });
  if (out.length) sheet.getRange(sheet.getLastRow() + 1, 1, out.length, LINE_HEAD.length).setValues(out);
}

function submitOrder_(b) {
  var team = findTeam_(b.teamId);
  if (isClosed_(team)) throw fail_('closed', 'Ordering for this team has closed.');
  var payload = cleanOrder_(b.order, team.menu);
  var now = Date.now();
  var orderId = 'o' + newKey_().slice(0, 12);
  var editKey = newKey_();
  db_().orders.appendRow([orderId, team.id, editKey, now, now, payload.num, payload.people.length, 'active', JSON.stringify(payload)]);
  writeLines_(team, orderId, payload, now);
  return { orderId: orderId, editKey: editKey };
}

function updateOrder_(b) {
  var order = findOrder_(b.orderId);
  var team = findTeam_(order.teamId);
  var auth = authFor_(team, order, b.key);
  if (isClosed_(team) && !auth.admin) throw fail_('closed', 'Ordering has closed. Ask your organizer to make the change.');
  var payload = cleanOrder_(b.order, team.menu);
  var now = Date.now();
  db_().orders.getRange(order.row, 5, 1, 5).setValues([[now, payload.num, payload.people.length, 'active', JSON.stringify(payload)]]);
  writeLines_(team, order.orderId, payload, now);
  return { orderId: order.orderId };
}

function deleteOrder_(b) {
  var order = findOrder_(b.orderId);
  var team = findTeam_(order.teamId);
  var auth = authFor_(team, order, b.key);
  if (isClosed_(team) && !auth.admin) throw fail_('closed', 'Ordering has closed. Ask your organizer to remove it.');
  db_().orders.getRange(order.row, 8, 1, 1).setValues([['deleted']]);
  writeLines_(team, order.orderId, null, Date.now());
  return { orderId: order.orderId };
}
