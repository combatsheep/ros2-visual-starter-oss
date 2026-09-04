#!/usr/bin/env node
import net from 'node:net';
import { clearTimeout, setTimeout } from 'node:timers';

const [host, rawPort, path, origin] = process.argv.slice(2);
const port = Number(rawPort);
if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535
  || !path?.startsWith('/') || /[\r\n]/u.test(path)
  || (origin !== '-' && (!origin || /[\r\n]/u.test(origin)))) {
  process.stderr.write('Usage: websocket_upgrade_probe.mjs HOST PORT PATH ORIGIN|-\n');
  process.exit(2);
}

const headers = [
  `GET ${path} HTTP/1.1`,
  `Host: ${host}:${port}`,
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
];
if (origin !== '-') headers.push(`Origin: ${origin}`);
headers.push('', '');

const socket = net.createConnection({ host, port });
let response = '';
let finished = false;
const finish = (status, error) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  socket.destroy();
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${status}\n`);
};
const timeout = setTimeout(() => finish('', 'WebSocket upgrade probe timed out.'), 2_000);
socket.on('connect', () => socket.write(headers.join('\r\n')));
socket.on('data', (chunk) => {
  response += chunk.toString('utf8');
  if (response.includes('\r\n')) finish(response.split('\r\n', 1)[0]);
});
socket.on('end', () => finish(response.split('\r\n', 1)[0] || '', response ? '' : 'No HTTP response.'));
socket.on('error', (error) => finish('', error.message));
