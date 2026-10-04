import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const routes = new Map();
const types = {'.html': 'text/html', '.mjs': 'text/javascript', '.ttf': 'font/ttf'};
for (const name of ['index.html', '01-sage.html', '02-signal.html', '03-paper.html', '04-workspace.html', '05-studio.html', 'prototype.mjs']) routes.set(`/web/proposals/${name}`, path.join(directory, name));
for (const name of ['dm-sans.ttf', 'manrope.ttf']) routes.set(`/web/fonts/${name}`, path.join(directory, '..', 'fonts', name));
routes.set('/', path.join(directory, 'index.html'));
const port = Number(process.env.PROPOSALS_PORT || 4173);
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://localhost:${port}`).pathname;
  if (pathname === '/') { response.writeHead(302, {'Location': '/web/proposals/index.html'}); response.end(); return; }
  const file = routes.get(pathname);
  if (request.method !== 'GET' || !file) { response.writeHead(404); response.end('Page not found'); return; }
  try {
    const content = await readFile(file);
    response.writeHead(200, {'Content-Type': `${types[path.extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-store'});
    response.end(content);
  } catch { response.writeHead(404); response.end('Page not found'); }
});
server.on('error', error => { console.error(`Theme preview could not start: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`NearKey theme proposals: http://localhost:${port}`));
