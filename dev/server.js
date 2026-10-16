/* Local dev server: serves the site files and runs backend/Code.gs against a mock at /api.
   node dev/server.js [port]    (default 8787)
   Nothing here is deployed. It is only for testing on this computer. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load } = require('./gas-mock');

const root = path.join(__dirname, '..');
const gas = load();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const send = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => send(gas.postRaw(body)));
    } else {
      send(gas.get(Object.fromEntries(url.searchParams)));
    }
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!path.extname(p)) p += '.html'; /* same pretty URLs as Cloudflare Pages */
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || p.startsWith('/dev/') || p.startsWith('/backend/')) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
}).listen(Number(process.argv[2]) || 8787, () => console.log('dev server up'));

module.exports = { gas };
