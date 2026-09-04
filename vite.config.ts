import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ControlLeaseRegistry, type ControlLeaseAction } from './src/controlLease';

const RUNTIME_MODES = new Set(['sim', 'base', 'mapping', 'navigation', 'exploration']);
const root = realpathSync(process.cwd());
const logs = resolve(root, '.logs');
mkdirSync(logs, { recursive: true });

const readText = (name: string): string => {
  try { return readFileSync(resolve(logs, name), 'utf8').trim(); } catch { return ''; }
};

const isAllowedSameOrigin = (origin: string | undefined, host: string | undefined): boolean => {
  if (!origin) return false;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.host === host;
  } catch {
    return false;
  }
};

const processCwd = (pid: number): string => {
  try { return realpathSync(readlinkSync(`/proc/${pid}/cwd`)); } catch { /* macOS has no /proc */ }
  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const cwd = output.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? '';
    return cwd ? realpathSync(cwd) : '';
  } catch { return ''; }
};

const ownedRosBackendAlive = (): boolean => {
  const pid = Number(readText('ros_backend.pid'));
  const pgid = Number(readText('ros_backend.pgid'));
  const ready = Number(readText('ros_backend.session_ready'));
  const token = readText('ros_backend.token');
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pgid !== pid || ready !== pid || !/^[0-9a-f]{32}$/u.test(token)) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (processCwd(pid) !== root) return false;
  try {
    const livePgid = Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
    if (livePgid !== pgid) return false;
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const identity = /scripts\/ros_process_supervisor\.py (base|mapping|navigation|exploration) ([0-9a-f]{32}) ([1-9][0-9]*)\s*$/u.exec(command);
    return identity?.[2] === token;
  } catch { return false; }
};

const runtimeState = () => {
  const storedMode = readText('runtime_mode');
  const recordedMode = RUNTIME_MODES.has(storedMode) ? storedMode : 'sim';
  const target = readText('runtime_target');
  const phase = readText('runtime_processing');
  const backendAlive = ownedRosBackendAlive();
  const mode = recordedMode !== 'sim' && !backendAlive && !phase ? 'sim' : recordedMode;
  const error = readText('runtime_error') || (recordedMode !== 'sim' && !backendAlive && !phase ? 'ROS backendが停止しました。速度を0にしてSIM状態を表示しています。' : '');
  return { mode, target: RUNTIME_MODES.has(target) ? target : mode, processing: Boolean(phase), phase, error, backendAlive };
};

const runtimeControlPlugin = (): Plugin => {
  let runtimeOperationActive = false;
  return {
    name: 'ros2-runtime-control',
    configureServer(server) {
    server.middlewares.use('/api/runtime', (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET') { response.end(JSON.stringify(runtimeState())); return; }
      if (request.method !== 'POST') { response.statusCode = 405; response.end(JSON.stringify({ error: 'Method not allowed' })); return; }
      const origin = request.headers.origin;
      if (!isAllowedSameOrigin(origin, request.headers.host)) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: '同一のloopback画面からのみ切り替えできます。' }));
        return;
      }
      let body = '';
      request.on('data', (chunk: Buffer) => { if (body.length < 4096) body += chunk.toString('utf8'); });
      request.on('end', () => {
        let mode = '';
        try { mode = String((JSON.parse(body) as { mode?: unknown }).mode ?? ''); } catch { /* handled below */ }
        if (!RUNTIME_MODES.has(mode)) { response.statusCode = 400; response.end(JSON.stringify({ error: '未対応のROS modeです。' })); return; }
        if (runtimeOperationActive || existsSync(resolve(logs, 'runtime_processing'))) {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: '別の切替処理が進行中です。' }));
          return;
        }
        runtimeOperationActive = true;
        try {
          const child = spawn(resolve(root, 'scripts/runtime.sh'), ['start', mode], { cwd: root, detached: true, stdio: 'ignore' });
          const releaseOperation = () => { runtimeOperationActive = false; };
          child.once('exit', releaseOperation);
          child.once('error', () => {
            releaseOperation();
            writeFileSync(resolve(logs, 'runtime_error'), 'ROS切替processを起動できませんでした。\n');
          });
          child.unref();
        } catch {
          runtimeOperationActive = false;
          response.statusCode = 500;
          response.end(JSON.stringify({ error: 'ROS切替processを起動できませんでした。' }));
          return;
        }
        response.statusCode = 202;
        response.end(JSON.stringify({ accepted: true, target: mode }));
      });
      });
    },
  };
};

const shutdownControlPlugin = (): Plugin => ({
  name: 'ros2-shutdown-control',
  configureServer(server) {
    server.middlewares.use('/api/shutdown', (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      const origin = request.headers.origin;
      if (!isAllowedSameOrigin(origin, request.headers.host)) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: '同一のloopback画面からのみ終了できます。' }));
        return;
      }
      response.statusCode = 202;
      response.end(JSON.stringify({ accepted: true }));
      setTimeout(() => {
        const child = spawn(resolve(root, 'stop.sh'), [], { cwd: root, detached: true, stdio: 'ignore' });
        child.unref();
      }, 150);
    });
  },
});

const controlLeasePlugin = (): Plugin => {
  const registry = new ControlLeaseRegistry();
  return {
    name: 'ros2-browser-control-lease',
    configureServer(server) {
      server.middlewares.use('/api/control-lease', (request, response) => {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        const origin = request.headers.origin;
        if (!isAllowedSameOrigin(origin, request.headers.host)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: '同一のloopback画面からのみ操作権を更新できます。' }));
          return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => { if (body.length < 2048) body += chunk.toString('utf8'); });
        request.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { clientId?: unknown; action?: unknown };
            const clientId = String(parsed.clientId ?? '');
            const action = String(parsed.action ?? '') as ControlLeaseAction;
            if (action !== 'renew' && action !== 'claim' && action !== 'release') throw new Error('action is invalid');
            response.end(JSON.stringify(registry.update(clientId, action, Date.now())));
          } catch {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: '操作権リクエストが不正です。' }));
          }
        });
      });
    },
  };
};

const optionalLlmBoundaryPlugin = (): Plugin => ({
  name: 'optional-local-llm-boundary',
  configureServer(server) {
    server.middlewares.use('/api/llm', (request, response, next) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const path = (request.url || '/').split('?')[0];
      const validMethod = (path === '/status' && request.method === 'GET')
        || (path === '/intent' && request.method === 'POST');
      if (!validMethod) {
        response.statusCode = path === '/status' || path === '/intent' ? 405 : 404;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: response.statusCode === 405 ? 'Method not allowed' : 'Not found' }));
        return;
      }
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (!isAllowedSameOrigin(origin, request.headers.host)) {
          response.statusCode = 403;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: '同一のloopback画面からのみLocal LLMを使用できます。' }));
          return;
        }
        const contentType = String(request.headers['content-type'] || '').toLowerCase();
        const contentLength = Number(request.headers['content-length'] ?? 0);
        if (!contentType.startsWith('application/json')
          || !Number.isSafeInteger(contentLength)
          || contentLength <= 0
          || contentLength > 4_096) {
          response.statusCode = 413;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: 'Local LLM request bodyが不正です。' }));
          return;
        }
      }
      next();
    });
  },
});

export default defineConfig(() => {
  const rosbridgeProxy: Record<string, ProxyOptions> = {
    '/rosbridge': {
      target: 'ws://127.0.0.1:9090',
      ws: true,
      rewrite: () => '',
      changeOrigin: false,
      bypass(request) {
        const isWebSocket = String(request.headers.upgrade || '').toLowerCase() === 'websocket';
        if (isWebSocket && (!request.headers.origin || !isAllowedSameOrigin(request.headers.origin, request.headers.host))) {
          return false;
        }
        return undefined;
      },
    },
  };
  const optionalLlmProxy: Record<string, ProxyOptions> = {
    '/api/llm': {
      target: 'http://127.0.0.1:27184',
      changeOrigin: false,
      followRedirects: false,
      rewrite: (path: string) => path.replace(/^\/api\/llm/, ''),
      configure(proxy) {
        proxy.on('proxyReq', (proxyRequest) => {
          // Provider credentials are owned by the Python sidecar. Never accept
          // browser-supplied credentials or cookies across this boundary.
          proxyRequest.removeHeader('authorization');
          proxyRequest.removeHeader('proxy-authorization');
          proxyRequest.removeHeader('x-api-key');
          proxyRequest.removeHeader('cookie');
        });
      },
    },
  };

  return {
    base: '/',
    plugins: [optionalLlmBoundaryPlugin(), runtimeControlPlugin(), controlLeasePlugin(), shutdownControlPlugin()],
    server: {
      host: '127.0.0.1',
      port: 27182,
      strictPort: true,
      allowedHosts: ['127.0.0.1', 'localhost'],
      proxy: { ...rosbridgeProxy, ...optionalLlmProxy },
    },
    preview: {
      host: '127.0.0.1',
      port: 27183,
      strictPort: true,
      allowedHosts: ['127.0.0.1', 'localhost'],
    },
  };
});
