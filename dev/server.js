/* Local dev server: serves the site files and runs functions/api.js against an in-memory database at /api.
   node dev/server.js [port]    (default 8787). Nothing here is deployed. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load } = require('./d1-mock');

const root = path.join(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

load().then(gas => {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api') {
      let body = '';
      if (req.method === 'POST') { req.setEncoding('utf8'); for await (const c of req) body += c; }
      const r = req.method === 'POST' ? await gas.postRawResponse(body) : await gas.getRawResponse(Object.fromEntries(url.searchParams));
      res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!path.extname(p)) p += '.html'; /* same pretty URLs as Cloudflare Pages */
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || /^\/(dev|functions)\//.test(p)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  }).listen(Number(process.argv[2]) || 8787, () => console.log('dev server up'));
});
