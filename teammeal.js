/* Shared helpers for the Team Meal pages (setup, order, organizer). No accounts, no tracking. */
(function () {
  var TM = window.TM = {};

  TM.api = function () { return window.TEAMMEAL_API || ""; };
  TM.enabled = function () { return !!TM.api(); };

  function toError(res) {
    var e = new Error(res && res.message ? res.message : "Something went wrong. Please try again.");
    e.code = (res && res.error) || "server";
    return e;
  }
  function netError() {
    var e = new Error("We could not reach Team Meal. Check your connection and try again.");
    e.code = "network";
    return e;
  }
  TM.get = function (params) {
    return fetch(TM.api() + "?" + new URLSearchParams(params).toString(), { cache: "no-store" })
      .catch(function () { throw netError(); })
      .then(function (r) { return r.json().catch(function () { throw netError(); }); })
      .then(function (j) { if (!j || !j.ok) throw toError(j); return j; });
  };
  TM.post = function (body) {
    /* Plain text body keeps this a "simple" request, so it works from any page without a preflight. */
    return fetch(TM.api(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) })
      .catch(function () { throw netError(); })
      .then(function (r) { return r.json().catch(function () { throw netError(); }); })
      .then(function (j) { if (!j || !j.ok) throw toError(j); return j; });
  };

  TM.esc = function (t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  TM.money = function (n) { return "$" + Number(n).toFixed(2); };
  TM.fmtTime = function (ms) {
    if (!ms) return "";
    return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  /* ---------- links ---------- */
  TM.teamLink = function (id) { return location.origin + "/order?team=" + encodeURIComponent(id); };
  TM.orderLink = function (teamId, orderId, key) {
    return location.origin + "/order?team=" + encodeURIComponent(teamId) + "&order=" + encodeURIComponent(orderId) + "&key=" + encodeURIComponent(key);
  };
  TM.organizerLink = function (teamId, key) {
    return location.origin + "/organizer?team=" + encodeURIComponent(teamId) + "&key=" + encodeURIComponent(key);
  };

  /* ---------- things saved on this device ---------- */
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  TM.mine = {
    list: function (teamId) { return read("teammeal_my_orders").filter(function (o) { return !teamId || o.teamId === teamId; }); },
    save: function (entry) {
      var all = read("teammeal_my_orders").filter(function (o) { return o.orderId !== entry.orderId; });
      all.unshift(entry); write("teammeal_my_orders", all.slice(0, 40));
    },
    remove: function (orderId) { write("teammeal_my_orders", read("teammeal_my_orders").filter(function (o) { return o.orderId !== orderId; })); }
  };
  TM.teams = {
    list: function () { return read("teammeal_my_teams"); },
    save: function (entry) {
      var all = read("teammeal_my_teams").filter(function (t) { return t.id !== entry.id; });
      all.unshift(entry); write("teammeal_my_teams", all.slice(0, 20));
    }
  };

  /* ---------- kitchen summary ---------- */
  function bump(map, key, label) {
    if (!map[key]) map[key] = { label: label, n: 0 };
    map[key].n++;
  }
  function sorted(map) {
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.n - a.n || a.label.localeCompare(b.label); });
  }
  /* orders: [{orderId, playerNumber, order:{num, people:[{name, allergies, notes, items:[...]}]}}] */
  TM.summarize = function (orders, menu) {
    var index = {}, i = 0;
    ((menu && menu.sections) || []).forEach(function (s) { s.items.forEach(function (it) { index[it.name] = i++; }); });
    var items = {}, allergies = [], meals = 0, people = 0;
    orders.forEach(function (o) {
      if (!o.order) return;
      o.order.people.forEach(function (p) {
        people++;
        var names = [];
        p.items.forEach(function (li) {
          meals++; names.push(li.item);
          var it = items[li.item] = items[li.item] || { name: li.item, count: 0, options: {}, sides: {}, changes: {} };
          it.count++;
          Object.keys(li.options || {}).forEach(function (k) { it.options[k] = it.options[k] || {}; bump(it.options[k], li.options[k], li.options[k]); });
          (li.sides || []).forEach(function (s) { bump(it.sides, s, s); });
          var c = (li.changes || "").trim();
          if (c) bump(it.changes, c.toLowerCase(), c);
        });
        if ((p.allergies && p.allergies.length) || (p.notes && p.notes.trim())) {
          allergies.push({ name: p.name, num: o.order.num, allergens: p.allergies || [], notes: (p.notes || "").trim(), items: names });
        }
      });
    });
    var list = Object.keys(items).map(function (k) {
      var it = items[k];
      return {
        name: it.name, count: it.count,
        options: Object.keys(it.options).map(function (k2) { return { name: k2, choices: sorted(it.options[k2]) }; }),
        sides: sorted(it.sides), changes: sorted(it.changes)
      };
    }).sort(function (a, b) { return (index[a.name] == null ? 1e6 : index[a.name]) - (index[b.name] == null ? 1e6 : index[b.name]); });
    allergies.sort(function (a, b) { return (b.allergens.length > 0) - (a.allergens.length > 0); });
    return { meals: meals, people: people, items: list, allergies: allergies };
  };

  TM.kitchenText = function (info) {
    /* info: {team, restaurant, orderBy, summary, orders} */
    var s = info.summary, L = [];
    L.push((info.team || "Team order") + (info.restaurant ? " - " + info.restaurant : ""));
    L.push(s.meals + " meals" + (info.orderBy ? " - order closes " + TM.fmtTime(info.orderBy) : ""));
    var alg = s.allergies.filter(function (a) { return a.allergens.length; });
    if (alg.length) {
      L.push("", "ALLERGIES");
      alg.forEach(function (a) { L.push("- " + a.name + " (#" + a.num + ", " + a.items.join(" / ") + "): " + a.allergens.join(", ") + (a.notes ? ". " + a.notes : "")); });
    }
    var req = s.allergies.filter(function (a) { return !a.allergens.length; });
    if (req.length) {
      L.push("", "SPECIAL REQUESTS");
      req.forEach(function (a) { L.push("- " + a.name + " (#" + a.num + "): " + a.notes); });
    }
    L.push("", "ITEMS");
    s.items.forEach(function (it) {
      L.push(it.count + " x " + it.name);
      it.options.forEach(function (o) { L.push("    " + o.name + ": " + o.choices.map(function (c) { return c.label + " x" + c.n; }).join(", ")); });
      if (it.sides.length) L.push("    Sides: " + it.sides.map(function (c) { return c.label + " x" + c.n; }).join(", "));
      if (it.changes.length) L.push("    Changes: " + it.changes.map(function (c) { return c.label + " x" + c.n; }).join(", "));
    });
    L.push("", "WHO ORDERED WHAT");
    var byNum = {};
    (info.orders || []).forEach(function (o) { if (o.order) (byNum[o.order.num] = byNum[o.order.num] || []).push(o); });
    Object.keys(byNum).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (n) {
      L.push("#" + n);
      byNum[n].forEach(function (o) {
        o.order.people.forEach(function (p) { L.push("  " + p.name + ": " + p.items.map(function (li) { return li.item; }).join(", ")); });
      });
    });
    return L.join("\n");
  };
})();
