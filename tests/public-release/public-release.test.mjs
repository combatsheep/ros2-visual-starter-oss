import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, lstat, readdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const execFileAsync = promisify(execFile);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const ignoredDirectories = new Set([
  '.git', '.logs', '.pixi', '.playwright-cli', '.playwright-mcp', '.pytest_cache',
  '__pycache__', 'coverage', 'dist', 'node_modules', 'output',
]);
const allowedRootEntries = new Set([
  '.env.example', '.github', '.gitignore', 'ASSETS.md', 'CONTRIBUTING.md', 'LICENSE',
  'LICENSES', 'Makefile', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'assets', 'backend',
  'docs', 'eslint.config.js', 'examples', 'index.html', 'maps', 'package-lock.json',
  'package.json', 'pixi.lock', 'pixi.toml', 'public', 'run.sh', 'scripts', 'setup.sh',
  'src', 'start.sh', 'stop.sh', 'tests', 'tsconfig.json', 'vite.config.ts',
]);
const downloadOnlyPaths = [
  ['public/vision/', 'yolox_nano.onnx'].join(''),
  ['public/vision/', 'dog.jpg'].join(''),
];
const downloadOnlyHashes = [
  ['c789161ed43c8269fcd4e67c67eeeb4e8', '0c622da2eb296a20bc6007bd18a0b7d'].join(''),
  ['5a9522051c3cec2bbd2f6323fccba32e8', 'fbf3ddcc2b3e2fd46b04c720bc6f866'].join(''),
];
const modelWeightExtensions = new Set([
  '.bin', '.ckpt', '.gguf', '.onnx', '.pt', '.pth', '.safetensors', '.weights',
]);
const lockfileAllowedHosts = new Map([
  ['package-lock.json', new Set(['eslint.org', 'github.com', 'opencollective.com', 'registry.npmjs.org', 'tidelift.com'])],
  ['pixi.lock', new Set(['conda.anaconda.org', 'prefix.dev'])],
]);

function nonLoopbackIpv6Literals(content) {
  const candidates = [
    ...(content.match(/\[[0-9a-f:.]+\]/giu) ?? []),
    ...(content.match(/(?<![0-9a-z])(?=[0-9a-f:]*[0-9a-f])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f:.]{0,15}(?![0-9a-z])/giu) ?? []),
    ...[...content.matchAll(/(?:listen|bind|host|address)\s*(?:[:=]\s*)?['"]?(::)(?:['"\s,;]|$)/giu)].map((match) => match[1]),
    ...[...content.matchAll(/['"](::)['"]/gu)].map((match) => match[1]),
    ...[...content.matchAll(/(?:^|[=:])\s*(::)(?=\s*(?:[,;}\]]|$))/gmu)].map((match) => match[1]),
    ...[...content.matchAll(/^\s*(::)\s*$/gmu)].map((match) => match[1]),
  ];
  return [...new Set(candidates
    .map((candidate) => candidate.replace(/^\[|\]$/gu, ''))
    .filter((candidate) => isIP(candidate) === 6 && candidate !== '::1'))];
}

const removedScopeSubstringTerms = [
  ['Tail', 'scale'].join(''),
  ['Tail', 'net'].join(''),
  ['Fun', 'nel'].join(''),
  ['.ts', '.net'].join(''),
  ['--tail', 'net'].join(''),
  ['VITE_ALLOWED_', 'HOSTS=all'].join(''),
  ['ROS2_VISUAL_', 'HOST'].join(''),
  ['WALL', '_E'].join(''),
  ['wall', 'E'].join(''),
  ['Gem', 'ma'].join(''),
  ['com', 'pactor'].join(''),
  ['reference', '-guided'].join(''),
  ['side', ' claws'].join(''),
  ['inferred', ' rear shell'].join(''),
  ['/Users', '/'].join(''),
  ['ChatGPT', '-chat'].join(''),
  ['CON', 'TINUITY'].join(''),
];
const removedScopeBoundedTerms = [['Wall', '-E'].join('')];

function removedScopeViolations(content) {
  const violations = [];
  const foldedContent = content.toLocaleLowerCase('en-US');
  for (const term of removedScopeSubstringTerms) {
    if (foldedContent.includes(term.toLocaleLowerCase('en-US'))) violations.push(term);
  }
  for (const term of removedScopeBoundedTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'iu').test(content)) violations.push(term);
  }
  if (/phase_[^\s/]*_start_prompt/iu.test(content)) violations.push('internal phase start document');
  return violations;
}

function relative(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}

async function readText(absolutePath) {
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) return null;
  try {
    const content = utf8Decoder.decode(bytes);
    return /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content) ? null : content;
  } catch {
    return null;
  }
}

async function auditedFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  const files = [];
  for (const file of stdout.toString('utf8').split('\0').filter(Boolean)) {
    const absolutePath = path.join(repositoryRoot, file);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${file}`);
    if (!stats.isFile()) throw new Error(`submodule or special file is not allowed: ${file}`);
    if (stats.nlink > 1) throw new Error(`hard-linked file is not allowed: ${file}`);
    files.push(absolutePath);
  }
  return files;
}

async function trackedFiles() {
  const { stdout } = await execFileAsync('git', ['ls-files', '--stage', '-z'], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const match = /^(\d{6}) [0-9a-f]{40,64} \d+\t([\s\S]+)$/u.exec(record);
    assert.ok(match, `unexpected Git index record: ${record}`);
    return { mode: match[1], file: match[2] };
  });
}

async function hasCommit() {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repositoryRoot });
    return true;
  } catch {
    return false;
  }
}

test('workspace root uses the public allowlist', async () => {
  const entries = await readdir(repositoryRoot);
  const violations = entries.filter((entry) => entry !== '.git' && !ignoredDirectories.has(entry) && !allowedRootEntries.has(entry));
  assert.deepEqual(violations, []);
});

test('workspace contains no unexpected hidden source files', async () => {
  const allowedHiddenFiles = new Set(['.env.example', '.gitignore']);
  const violations = (await auditedFiles())
    .map(relative)
    .filter((file) => {
      if (allowedHiddenFiles.has(file)) return false;
      const parts = file.split('/');
      if (parts[0] === '.github') parts.shift();
      return parts.some((part) => part.startsWith('.'));
    });
  assert.deepEqual(violations, []);
});

test('tracked tree contains regular files and executable scripts only', async () => {
  const violations = [];
  for (const { mode, file } of await trackedFiles()) {
    if (mode !== '100644' && mode !== '100755') violations.push(`${mode} ${file}`);
    if (mode === '100755') {
      const content = await readText(path.join(repositoryRoot, file));
      if (content === null || !content.startsWith('#!')) violations.push(`${mode} ${file}: executable is not a text script`);
    }
  }
  assert.deepEqual(violations, []);
});

test('forbidden files and generated artifacts are absent from the public workspace', async () => {
  const prohibitedExact = new Set([
    ['AGENT', '.md'].join(''),
    ['AGENT', 'S.md'].join(''),
    ['CON', 'TINUITY.md'].join(''),
    ['CON', 'TINUITY-LT.md'].join(''),
    ['CODEX_', 'START_HERE.md'].join(''),
    ['START_', 'PROMPT.txt'].join(''),
    ['PACKAGE_', 'MANIFEST.md'].join(''),
    'maps/.selected_map',
  ]);
  const prohibitedBasenames = new Set([
    ['AGENT', '.md'].join(''),
    ['AGENT', 'S.md'].join(''),
    ['CON', 'TINUITY.md'].join(''),
    ['CON', 'TINUITY-LT.md'].join(''),
    ['CODEX_', 'START_HERE.md'].join(''),
    ['START_', 'PROMPT.txt'].join(''),
    ['PACKAGE_', 'MANIFEST.md'].join(''),
    ['ChatGPT', '-chat.md'].join(''),
    '.selected_map',
  ]);
  const prohibitedParts = new Set([
    '.cache', '.logs', '.pixi', '.playwright-cli', '.playwright-mcp', '.pytest_cache',
    '__pycache__', 'cache', 'coverage', 'dist', 'generated', 'node_modules', 'output', 'temp', 'tmp',
  ]);
  const present = new Set([
    ...(await auditedFiles()).map(relative),
    ...(await trackedFiles()).map(({ file }) => file),
  ]);
  const violations = [...present].filter((file) => {
    const parts = file.split('/');
    return prohibitedExact.has(file)
      || parts.some((part) => prohibitedParts.has(part))
      || parts.some((part) => prohibitedBasenames.has(part))
      || /(?:^|\/)[^/]+\.(?:log|tmp|temp)$/iu.test(file)
      || file.startsWith('docs/html/')
      || file.startsWith('docs/_hide/')
      || file === ['docs/ChatGPT', '-chat.md'].join('')
      || (file.startsWith('docs/') && /prompt/iu.test(file))
      || file.toLocaleLowerCase('en-US').startsWith('docs/phase');
  });
  for (const file of present) {
    for (const violation of removedScopeViolations(file)) violations.push(`${file}: ${violation}`);
    if (file.includes('@')) violations.push(`${file}: email-like filename`);
    if (/(?:^|\/)(?:id_(?:dsa|ecdsa|ed25519|rsa)|[^/]+\.(?:cer|crt|der|jks|key|keystore|mobileprovision|p12|pem|pfx))$/iu.test(file)) {
      violations.push(`${file}: credential-like filename`);
    }
  }
  assert.deepEqual(violations, []);
});

test('all binary assets are declared and checksummed', async () => {
  const manifestPath = path.join(repositoryRoot, 'assets', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.assets));
  const declared = new Map();
  const tracked = new Set((await trackedFiles()).map(({ file }) => file));
  const downloadOnlyPathSet = new Set(downloadOnlyPaths.map((file) => file.toLocaleLowerCase('en-US')));
  for (const asset of manifest.assets) {
    assert.equal(typeof asset.path, 'string');
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(asset.type?.trim());
    assert.ok(asset.creatorOrSource?.trim());
    assert.ok(asset.purpose?.trim());
    assert.ok(asset.license?.trim());
    assert.doesNotMatch(asset.license, /(?:unknown|tbd|pending)/iu);
    assert.doesNotMatch(asset.creatorOrSource, /(?:unknown|tbd|pending)/iu);
    assert.equal(asset.approvedForRedistribution, true, `asset approval is required: ${asset.path}`);
    assert.equal(declared.has(asset.path), false, `duplicate asset entry: ${asset.path}`);
    assert.equal(path.isAbsolute(asset.path), false, `asset path must be relative: ${asset.path}`);
    assert.equal(path.posix.normalize(asset.path), asset.path, `asset path is not normalized: ${asset.path}`);
    assert.equal(asset.path.startsWith('../'), false, `asset path escapes repository: ${asset.path}`);
    const absolutePath = path.join(repositoryRoot, asset.path);
    assert.equal(relative(absolutePath), asset.path, `asset path escapes repository: ${asset.path}`);
    assert.equal(tracked.has(asset.path), true, `manifest asset must be tracked: ${asset.path}`);
    assert.equal(downloadOnlyPathSet.has(asset.path.toLocaleLowerCase('en-US')), false, `download-only asset must not enter the manifest: ${asset.path}`);
    const bytes = await readFile(absolutePath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `asset checksum mismatch: ${asset.path}`);
    declared.set(asset.path, asset);
  }

  const binaryFiles = [];
  const textOnlyExtensions = new Set([
    '.css', '.html', '.js', '.json', '.md', '.mjs', '.py', '.sh', '.toml', '.ts', '.txt', '.xml', '.yaml', '.yml',
  ]);
  const textOnlyBasenames = new Set(['.env.example', '.gitignore', 'LICENSE', 'Makefile', 'pixi.lock']);
  for (const absolutePath of await auditedFiles()) {
    if (await readText(absolutePath) === null) {
      const file = relative(absolutePath);
      assert.equal(
        textOnlyExtensions.has(path.posix.extname(file)) || textOnlyBasenames.has(path.posix.basename(file)),
        false,
        `text source is not valid UTF-8: ${file}`,
      );
      binaryFiles.push(file);
    }
  }
  const presentFiles = new Set([
    ...(await auditedFiles()).map(relative),
    ...(await trackedFiles()).map(({ file }) => file),
  ]);
  const prohibitedArtifacts = [];
  for (const file of presentFiles) {
    const folded = file.toLocaleLowerCase('en-US');
    if (downloadOnlyPathSet.has(folded)) prohibitedArtifacts.push(`${file}: download-only path`);
    if (modelWeightExtensions.has(path.posix.extname(folded))) prohibitedArtifacts.push(`${file}: model weight`);
    const bytes = await readFile(path.join(repositoryRoot, file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (downloadOnlyHashes.includes(digest)) prohibitedArtifacts.push(`${file}: download-only bytes`);
  }
  assert.deepEqual(prohibitedArtifacts, []);
  const undeclared = binaryFiles.filter((file) => !declared.has(file));
  assert.deepEqual(undeclared, []);
  const trackedBinaryFiles = binaryFiles.filter((file) => tracked.has(file)).sort();
  assert.deepEqual([...declared.keys()].sort(), trackedBinaryFiles);
});

test('public text contains no secrets, personal paths, or private endpoints', async () => {
  const macHome = new RegExp(['/Users', '/(?!example(?:/|$))[A-Za-z0-9._-]+(?:/|$)'].join(''));
  const userFolder = new RegExp(['~/', '(?:Desktop|Documents|Downloads)(?:/|$)'].join(''));
  const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
  const rules = [
    ['macOS home path', macHome],
    ['user home shortcut', userFolder],
    ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
    ['GitHub token', new RegExp(['\\b(?:ghp|github_pat)', '_[A-Za-z0-9_]{20,}\\b'].join(''))],
    ['OpenAI-style key', new RegExp(['\\bsk', '-[A-Za-z0-9_-]{32,}\\b'].join(''))],
    ['Bearer token literal', /\bBearer\s+(?!<|\$\{|example\b)[A-Za-z0-9._~+/=-]{12,}\b/u],
    ['private key block', /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/u],
    ['PGP private key block', new RegExp(['-----BEGIN PGP PRIVATE', ' KEY BLOCK-----'].join(''))],
    ['certificate block', new RegExp(['-----BEGIN CERT', 'IFICATE-----'].join(''))],
    ['literal authorization value', /Authorization\s*:\s*(?:Basic|Bearer)\s+(?!<|\$\{)[A-Za-z0-9._~+/=-]{16,}/iu],
  ];
  const violations = [];
  for (const absolutePath of await auditedFiles()) {
    const content = await readText(absolutePath);
    if (content === null) continue;
    for (const [label, pattern] of rules) {
      if (pattern.test(content)) violations.push(`${relative(absolutePath)}: ${label}`);
      pattern.lastIndex = 0;
    }
    for (const candidate of content.match(email) ?? []) {
      const normalized = candidate.toLocaleLowerCase('en-US');
      const allowed = normalized.endsWith('.invalid')
        || normalized === 'noreply@github.com'
        || normalized.endsWith('@users.noreply.github.com');
      if (!allowed) violations.push(`${relative(absolutePath)}: non-placeholder email`);
    }
    const file = relative(absolutePath);
    const allowedLockfileHosts = lockfileAllowedHosts.get(file);
    if (allowedLockfileHosts) {
      for (const candidate of content.match(/https?:\/\/[^\s"'<>]+/gu) ?? []) {
        let parsed;
        try {
          parsed = new URL(candidate.replace(/[),\]]+$/gu, ''));
        } catch {
          violations.push(`${file}: invalid lockfile URL`);
          continue;
        }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowedLockfileHosts.has(parsed.hostname)) {
          violations.push(`${file}: unexpected lockfile endpoint ${parsed.origin}`);
        }
      }
    }
    const scanNetworkLiterals = !allowedLockfileHosts;
    for (const candidate of scanNetworkLiterals ? (content.match(ipv4) ?? []) : []) {
      const octets = candidate.split('.').map(Number);
      if (octets.some((octet) => octet > 255)) continue;
      if (candidate !== '127.0.0.1') violations.push(`${relative(absolutePath)}: non-loopback IPv4 ${candidate}`);
    }
    for (const candidate of scanNetworkLiterals ? nonLoopbackIpv6Literals(content) : []) {
      violations.push(`${relative(absolutePath)}: non-loopback IPv6 ${candidate}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('IPv6 scanner rejects non-loopback literals and permits loopback', () => {
  const privateExample = ['2001', 'db8', '', '1'].join(':');
  assert.deepEqual(nonLoopbackIpv6Literals(`listen ${privateExample}`), [privateExample]);
  const unspecified = ['', '', ''].join(':');
  assert.deepEqual(nonLoopbackIpv6Literals(`listen ${unspecified}`), [unspecified]);
  assert.deepEqual(nonLoopbackIpv6Literals(`listen ${['', '', '1'].join(':')}`), []);
});

test('removed scopes and private implementation names are absent', async () => {
  const localServerExample = ['LM', ' Studio'].join('');
  const violations = [];
  for (const absolutePath of await auditedFiles()) {
    const content = await readText(absolutePath);
    if (content === null) continue;
    for (const violation of removedScopeViolations(content)) violations.push(`${relative(absolutePath)}: ${violation}`);
    if (content.includes(localServerExample) && relative(absolutePath) !== 'docs/OPTIONAL_LOCAL_LLM.md') {
      violations.push(`${relative(absolutePath)}: provider example outside optional LLM guide`);
    }
    if (/listen[^\n]{0,80}0\.0\.0\.0|0\.0\.0\.0[^\n]{0,80}listen/iu.test(content)) {
      violations.push(`${relative(absolutePath)}: all-interface listener`);
    }
  }
  assert.deepEqual(violations, []);
});

test('removed-scope scanner covers identifiers without matching neutral wall ids', () => {
  for (const candidate of [
    ['Tail', 'netProxy'].join(''),
    ['Tail', 'scaleServe'].join(''),
    ['ROS2_VISUAL_', 'HOSTNAME'].join(''),
    ['wall', 'EModel'].join(''),
    ['com', 'pactorBody'].join(''),
    ['phase_', '5_start_prompt'].join(''),
    ['Wall', '-E'].join(''),
  ]) assert.ok(removedScopeViolations(candidate).length > 0, `scanner missed ${candidate}`);
  assert.deepEqual(removedScopeViolations('wall-east'), []);
});

test('adapted and copied files retain provenance and license pointers', async () => {
  const expectations = new Map([
    ['backend/config/nav2.yaml', ['SPDX-License-Identifier: Apache-2.0', '6be3614013ec586051b86c97b919b293281490fe', 'LICENSES/Apache-2.0.txt']],
    ['backend/config/navigate_to_pose_with_bounded_backup.xml', ['SPDX-License-Identifier: Apache-2.0', '6be3614013ec586051b86c97b919b293281490fe', 'LICENSES/Navigation2-LICENSE.txt']],
    ['backend/config/slam_toolbox.yaml', ['SPDX-License-Identifier: LGPL-2.1-only AND Apache-2.0', 'ec8f7635dea317b531c419f798f87d90a336f32e', 'LICENSES/LGPL-2.1-only.txt']],
    ['backend/ros2_visual_backend/yolox_runtime.py', ['SPDX-License-Identifier: Apache-2.0', '419778480ab6ec0590e5d3831b3afb3b46ab2aa3', 'Copyright (c) Megvii']],
    ['backend/ros2_visual_backend/object_search_targets.py', ['SPDX-License-Identifier: Apache-2.0', '419778480ab6ec0590e5d3831b3afb3b46ab2aa3', 'Copyright (c) Megvii']],
    ['src/objectSearchTargets.ts', ['SPDX-License-Identifier: Apache-2.0', '419778480ab6ec0590e5d3831b3afb3b46ab2aa3', 'Copyright (c) Megvii']],
  ]);
  for (const [file, markers] of expectations) {
    const content = await readFile(path.join(repositoryRoot, file), 'utf8');
    for (const marker of markers) assert.ok(content.includes(marker), `${file} is missing provenance marker: ${marker}`);
  }
  for (const file of ['LICENSES/Apache-2.0.txt', 'LICENSES/LGPL-2.1-only.txt', 'LICENSES/Navigation2-LICENSE.txt']) {
    await access(path.join(repositoryRoot, file));
  }
});

test('required public documentation and package license are present', async () => {
  const required = [
    'LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
    'ASSETS.md', 'docs/ARCHITECTURE.md', 'docs/DEVELOPMENT.md', 'docs/STATE_MACHINE.md',
    'docs/OPTIONAL_LOCAL_LLM.md', 'docs/TROUBLESHOOTING.md',
    'docs/DEPENDENCY_LICENSE_AUDIT.md', '.github/workflows/ci.yml',
  ];
  for (const file of required) await access(path.join(repositoryRoot, file));
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, 'MIT');
  const license = await readFile(path.join(repositoryRoot, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License\n/u);
  assert.match(license, /^Copyright \(c\) 2026 ROS2 Visual Starter contributors$/mu);
  assert.match(license, /Permission is hereby granted, free of charge, to any person obtaining a copy/u);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/u);
  const environmentExample = await readFile(path.join(repositoryRoot, '.env.example'), 'utf8');
  const environmentSettings = environmentExample.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(environmentSettings, [
    'ROS2_VISUAL_LLM_ENABLED=0',
    'ROS2_VISUAL_LLM_BASE_URL=http://127.0.0.1:1234/v1',
    'ROS2_VISUAL_LLM_MODEL=',
    'ROS2_VISUAL_LLM_TOKEN=',
  ]);
});

test('shell entrypoints are executable and declare strict mode', async () => {
  for (const file of ['setup.sh', 'run.sh', 'start.sh', 'stop.sh']) {
    const absolutePath = path.join(repositoryRoot, file);
    const stats = await lstat(absolutePath);
    const content = await readFile(absolutePath, 'utf8');
    assert.ok((stats.mode & 0o111) !== 0, `${file} is not executable`);
    assert.match(content, /^#!\/usr\/bin\/env bash\n/u);
    assert.match(content, /set -euo pipefail/u);
  }
});

test('CI external actions use immutable commit SHAs', async () => {
  const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gmu)].map((match) => match[1]);
  assert.ok(actionUses.length >= 2);
  for (const action of actionUses) assert.match(action, /@[0-9a-f]{40}$/u);
});

test('Git remote is absent or exactly the explicitly allowed public remote', async () => {
  const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd: repositoryRoot, encoding: 'utf8' });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const allowedRemote = process.env.PUBLIC_RELEASE_ALLOWED_REMOTE_URL?.trim();
  if (!allowedRemote) {
    assert.deepEqual(lines, [], 'public draft must not have a remote');
    return;
  }
  assert.equal(lines.length, 2, 'the public repository must have one fetch/push remote pair');
  const directions = new Set();
  for (const line of lines) {
    const match = /^origin\t(.+) \((fetch|push)\)$/u.exec(line);
    assert.ok(match, `unexpected remote entry: ${line}`);
    assert.equal(match[1], allowedRemote, `unexpected remote URL: ${match[1]}`);
    directions.add(match[2]);
  }
  assert.deepEqual(directions, new Set(['fetch', 'push']));
});

test('reachable public history has the clean-room root and permits normal contributors', async (context) => {
  if (!await hasCommit()) {
    if (process.env.PUBLIC_RELEASE_REQUIRE_SINGLE_COMMIT === '1') assert.fail('single-commit release audit requires a commit');
    context.skip('initial public commit has not been created yet');
    return;
  }
  const { stdout } = await execFileAsync('git', [
    'log', '--all', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00',
  ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const fields = stdout.split('\0');
  if (fields.at(-1)?.trim() === '') fields.pop();
  assert.equal(fields.length % 8, 0);
  let roots = 0;
  let rootRecord = null;
  const violations = [];
  for (let index = 0; index < fields.length; index += 8) {
    const [commit, parents, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = fields.slice(index, index + 8).map((field) => field.trim());
    if (!parents) {
      roots += 1;
      rootRecord = { commit, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate };
    }
    for (const [role, email, date] of [['author', authorEmail, authorDate], ['committer', committerEmail, committerDate]]) {
      if (!email || !date) violations.push(`${commit}: ${role} metadata`);
    }
  }
  assert.equal(roots, 1);
  assert.ok(rootRecord);
  if (rootRecord.authorName !== 'ROS2 Visual Starter contributors') violations.push(`${rootRecord.commit}: clean-room root author name`);
  if (rootRecord.committerName !== 'ROS2 Visual Starter contributors') violations.push(`${rootRecord.commit}: clean-room root committer name`);
  for (const [role, email] of [['author', rootRecord.authorEmail], ['committer', rootRecord.committerEmail]]) {
    if (email !== 'noreply@github.com' && !email.endsWith('@users.noreply.github.com')) violations.push(`${rootRecord.commit}: clean-room root ${role} email`);
  }
  const { stdout: rootMessage } = await execFileAsync('git', ['log', '--all', '--root', '--format=%B'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.match(rootMessage, /^Initial open-source release\s*$/mu);
  if (process.env.PUBLIC_RELEASE_REQUIRE_SINGLE_COMMIT === '1') {
    assert.equal(fields.length, 8, 'initial release must have exactly one commit');
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(status, '', 'initial release audit requires a clean working tree');
  }
  assert.deepEqual(violations, []);
});
