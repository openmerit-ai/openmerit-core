// Orb-only portal adapter for the Inference Terminal. The terminal accepts only
// loopback Host and Origin headers, so this forwards portal requests with the
// local values. Amp's portal authentication still guards the public URL.
import http from 'node:http';

const target = Number(process.env.TARGET_PORT);
const local = `127.0.0.1:${target}`;
const publicOrigin = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;

http.createServer((request, response) => {
  const headers = { ...request.headers, host: local };
  if (headers.origin && headers.origin === publicOrigin) headers.origin = `http://${local}`;
  const upstream = http.request({ host: '127.0.0.1', port: target, method: request.method, path: request.url, headers }, reply => {
    response.writeHead(reply.statusCode, reply.headers);
    reply.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502, { 'Content-Type': 'text/plain' }); response.end('Inference Terminal is not running.\n'); });
  request.pipe(upstream);
}).listen(Number(process.env.PORT), '127.0.0.1');
