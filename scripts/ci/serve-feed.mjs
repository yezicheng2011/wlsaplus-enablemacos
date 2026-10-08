// Tiny static server for the self-update E2E test: serves <root>/api/latest and <root>/download/<tag>/<file>
// on 127.0.0.1 (the only host the app accepts as a test feed).   node serve-feed.mjs <root> <port>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3] || 18765);
http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, urlPath);
  const ok = file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${req.headers.range || ''} -> ${ok ? 200 : 404}`);
  if (!ok) { res.writeHead(404); res.end('not found'); return; }
  const size = fs.statSync(file).size;
  const range = /bytes=(\d+)-/.exec(req.headers.range || '');
  if (range && Number(range[1]) < size) {
    const start = Number(range[1]);
    res.writeHead(206, { 'Content-Length': size - start, 'Content-Range': `bytes ${start}-${size - 1}/${size}`, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file, { start }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`feed on http://127.0.0.1:${port} from ${root}`));
