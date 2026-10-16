/* Local stand-in for the Google services that backend/Code.gs uses.
   Lets us run the real backend code in Node and test it without deploying.
   Usage: const gas = require('./gas-mock').load(); gas.get({action:'ping'}); gas.post({...}) */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeSheet(name) {
  const s = { name, rows: [], frozen: 0 };
  s.getName = () => s.name;
  s.setName = n => { s.name = n; };
  s.appendRow = r => { s.rows.push(r.slice()); };
  s.setFrozenRows = n => { s.frozen = n; };
  s.getLastRow = () => s.rows.length;
  s.getDataRange = () => ({ getValues: () => s.rows.map(r => r.slice()) });
  s.deleteRow = n => { s.rows.splice(n - 1, 1); };
  s.getRange = (row, col, nr = 1, nc = 1) => ({
    setNumberFormat: () => {},
    setValues: vals => {
      for (let i = 0; i < nr; i++) {
        while (s.rows.length < row - 1 + i + 1) s.rows.push([]);
        for (let j = 0; j < nc; j++) s.rows[row - 1 + i][col - 1 + j] = vals[i][j];
      }
    }
  });
  return s;
}

function load(opts = {}) {
  const sheets = [makeSheet('Sheet1')];
  const ss = {
    getId: () => 'mock-ss',
    getSheets: () => sheets,
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = makeSheet(n); sheets.push(s); return s; }
  };
  const props = {};
  const ctx = {
    console,
    JSON, Math, Date, Object, Array, String, Number, isFinite, RegExp, Error,
    SpreadsheetApp: { create: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: t => ({ text: t, setMimeType() { return this; } })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), ctx);
  const parse = out => JSON.parse(out.text);
  return {
    sheets, ss,
    get: params => parse(vm.runInContext('doGet', ctx)({ parameter: params })),
    post: body => parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(body) } })),
    postRaw: text => parse(vm.runInContext('doPost', ctx)({ postData: { contents: text } }))
  };
}

module.exports = { load };
