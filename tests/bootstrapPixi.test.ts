import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const source = readFileSync(new URL('../scripts/bootstrap_pixi.sh', import.meta.url), 'utf8');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { platform?: string; arch?: string; mismatch?: boolean; hashFailure?: boolean; noHash?: boolean; downloadFailure?: boolean; version?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pixi-bootstrap-test-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const temp = path.join(root, 'temp');
  for (const dir of [bin, home, temp]) mkdirSync(dir);
  const executable = (name: string, content: string): void => writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${content}\n`, { mode: 0o755 });
  // Test-only copy pins an inert fixture archive. Production has no URL/hash override.
  writeFileSync(path.join(root, 'pixi'), `#!/bin/bash\necho executed >> "$TRACE"\necho 'pixi ${options.version ?? '0.77.0'}'\n`, { mode: 0o755 });
  execFileSync('/usr/bin/tar', ['-czf', path.join(root, 'fixture.tar.gz'), '-C', root, 'pixi']);
  const digest = createHash('sha256').update(readFileSync(path.join(root, 'fixture.tar.gz'))).digest('hex');
  writeFileSync(path.join(root, 'bootstrap.sh'), source.replaceAll(/expected_sha256="[a-f0-9]{64}"/g, `expected_sha256="${options.mismatch ? '0'.repeat(64) : digest}"`));
  for (const tool of ['awk', 'mktemp', 'rm', 'install', 'mv', 'mkdir']) {
    symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(bin, tool));
  }
  if (!options.noHash) executable('shasum', options.hashFailure ? 'exit 1' : '/usr/bin/shasum "$@"');
  executable('uname', `if [[ "$1" == '-s' ]]; then echo '${options.platform ?? 'Darwin'}'; else echo '${options.arch ?? 'arm64'}'; fi`);
  executable('curl', `echo download >> "$TRACE"\n${options.downloadFailure ? 'exit 1' : 'while [[ "$1" != "-o" ]]; do shift; done\n/bin/cp "$FIXTURE" "$2"'}`);
  executable('tar', 'echo extracted >> "$TRACE"\n/usr/bin/tar "$@"');
  const trace = path.join(root, 'trace');
  const result = spawnSync('/bin/bash', [path.join(root, 'bootstrap.sh')], {
    env: { PATH: bin, HOME: home, TMPDIR: temp, TRACE: trace, FIXTURE: path.join(root, 'fixture.tar.gz') }, encoding: 'utf8',
  });
  return { result, trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [], installed: existsSync(path.join(home, '.pixi/bin/pixi')), leftover: readdirSync(temp) };
}

describe('verified Pixi bootstrap', () => {
  it.each([['Darwin', 'arm64'], ['Darwin', 'x86_64'], ['Linux', 'aarch64'], ['Linux', 'x86_64']])('installs verified bytes on %s/%s', (platform, arch) => {
    const run = fixture({ platform, arch });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.trace).toEqual(['download', 'extracted', 'executed']);
    expect(run.installed).toBe(true);
    expect(run.leftover).toEqual([]);
  });
  it.each([{ mismatch: true }, { hashFailure: true }, { noHash: true }, { downloadFailure: true }])('never extracts or executes when verification fails: %j', (options) => {
    const run = fixture(options);
    expect(run.result.status).not.toBe(0);
    expect(run.trace).toEqual(['download']);
    expect(run.installed).toBe(false);
    expect(run.leftover).toEqual([]);
  });
  it.each([['Windows_NT', 'arm64'], ['Darwin', 'unknown'], ['Linux', 'riscv64']])('rejects unsupported %s/%s before download', (platform, arch) => {
    const run = fixture({ platform, arch });
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toContain('未対応');
    expect(run.trace).toEqual([]);
    expect(run.installed).toBe(false);
  });
  it('does not install a verified artifact with the wrong version', () => {
    const run = fixture({ version: '0.1.0' });
    expect(run.result.status).not.toBe(0);
    expect(run.installed).toBe(false);
    expect(run.leftover).toEqual([]);
  });
});
