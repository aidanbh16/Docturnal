// Serves the app registration page on http://localhost:8790. GitHub sends you back to this
// address after you create the app, so the page can show the app's credentials.
//
//   node scripts/register.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8790;
const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  '/': [path.join(here, 'register.html'), 'text/html; charset=utf-8'],
  '/pkcs8.mjs': [path.join(here, 'pkcs8.mjs'), 'text/javascript; charset=utf-8'],
  '/manifest.json': [path.join(here, '..', 'manifest.json'), 'application/json; charset=utf-8'],
};

http
  .createServer((req, res) => {
    const file = FILES[new URL(req.url, 'http://localhost').pathname];
    if (!file || req.method !== 'GET') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file[0]));
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Open http://localhost:${PORT} to register the Docturnal app. Press Ctrl+C when you are done.`);
  });
