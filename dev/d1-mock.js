/* Local stand-in for Cloudflare D1 (SQLite) so functions/api.js can run in Node for tests.
   Only the parts of the D1 API that api.js uses: prepare().bind().first()/all()/run(), batch(). */
const { DatabaseSync } = require('node:sqlite');

function makeD1() {
  const db = new DatabaseSync(':memory:');
  const wrap = sql => {
    let args = []; const st = { get: (...a) => db.prepare(sql).get(...a), all: (...a) => db.prepare(sql).all(...a), run: (...a) => db.prepare(sql).run(...a) }; /* compiled when run, like D1 */
    const o = {
      bind: (...a) => { args = a; return o; },
      first: async () => st.get(...args) || null,
      all: async () => ({ results: st.all(...args) }),
      run: async () => { st.run(...args); return { success: true }; }
    };
    return o;
  };
  return { prepare: wrap, batch: async list => { for (const s of list) await s.run(); return []; }, raw: db };
}

async function load() {
  const { onRequest } = await import('../functions/api.js');
  const env = { DB: makeD1() };
  let n = 0;
  const call = async (method, path, body, ip) => {
    const req = new Request('http://localhost' + path, { method, body, headers: { 'CF-Connecting-IP': ip || 'test-ip-' + (n++) } });
    return onRequest({ request: req, env });
  };
  return {
    env,
    get: async (params, ip) => (await call('GET', '/api?' + new URLSearchParams(params), undefined, ip)).json(),
    getRaw: params => call('GET', '/api?' + new URLSearchParams(params)),
    post: async (body, ip) => (await call('POST', '/api', JSON.stringify(body), ip)).json(),
    postRaw: async text => (await call('POST', '/api', text)).json(),
    postRawResponse: text => call('POST', '/api', text),
    getRawResponse: params => call('GET', '/api?' + new URLSearchParams(params))
  };
}
module.exports = { load };
