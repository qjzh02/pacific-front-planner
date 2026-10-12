import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './game-capture.js';
import { createCaptureRelay } from './capture-relay.mjs';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const paths = new Set(['index.html', 'app.js', 'solver.js', 'worker.js', 'styles.css', 'game-capture.js', 'data/cards.json', 'data/items.json']);
const captureRelay = createCaptureRelay(globalThis.PacificFrontCapture.validateSnapshot);
const server = http.createServer(async (request, response) => {
  try {
    if (await captureRelay(request, response)) return;
    const path = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
    if (!paths.has(path) || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404); response.end('Not found'); return; }
    const content = await readFile(fileURLToPath(new URL(path, import.meta.url)));
    const extension = path.slice(path.lastIndexOf('.'));
    response.writeHead(200, { 'Content-Type': `${types[extension]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(500); response.end('Unable to load the requested file'); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(8765, '127.0.0.1', () => console.log('太平洋战线求解器：http://127.0.0.1:8765'));
