import { chmod, mkdir, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, status, sync, verify } from '../src/collector.js';

const root = path.resolve('.tmp-test');
const fixture = path.join(root, 'fake-exporter.mjs');
const configFile = path.join(root, 'config.yaml');
const configText = () => `exporter:\n  executable: ${fixture}\n  supports_token_env: true\n  concurrency: 4\n  delay_ms: 17\n  mode: ok\nstate_dir: ${path.join(root, 'state')}\noutput_dir: ${path.join(root, 'output')}\nprojects:\n  - id: alpha\n    name: Alpha\n    output: alpha\n  - id: beta\n    name: Beta\n    output: beta\n`;

beforeEach(async () => {
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
  await writeFile(fixture, `#!${process.execPath}
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const out = process.argv[process.argv.indexOf('-o') + 1];
const project = process.argv[process.argv.indexOf('--project') + 1];
await writeFile(process.env.ARGS_FILE, JSON.stringify(process.argv));
if (!process.argv.includes('backup') || !process.argv.includes('--incremental') || !process.argv.includes('--download-files') || process.argv.includes('--request-delay')) process.exit(21);
if (!process.env.CHATGPT_TOKEN && !process.argv.includes('--token')) process.exit(22);
if (process.env.FAKE_MODE === 'fail') process.exit(9);
if (process.env.FAKE_MODE === 'auth') { console.error('401 unauthorized'); process.exit(1); }
if (process.env.FAKE_MODE === 'rate') { console.error('rate limit'); process.exit(1); }
if (process.env.FAKE_MODE === 'partial' && project === 'beta') { await mkdir(out, { recursive: true }); await writeFile(path.join(out, 'broken.md'), '[x](missing.png)'); process.exit(0); }
await mkdir(out, { recursive: true });
await rm(path.join(out, 'broken.md'), { force: true });
await writeFile(path.join(out, 'conversation.md'), '# ' + project + (process.env.FAKE_VERSION || '') + '\\n![asset](asset.png)\\n');
await writeFile(path.join(out, 'asset.png'), 'asset-' + project);
await writeFile(path.join(out, 'private.json'), '{}');
`, 'utf8');
  await chmod(fixture, 0o755); process.env.ARGS_FILE = path.join(root, 'args.json'); await writeFile(configFile, configText());
});
afterEach(async () => { delete process.env.FAKE_MODE; delete process.env.FAKE_VERSION; delete process.env.ARGS_FILE; await rm(root, { recursive: true, force: true }); });

test('exact args, persistent incremental output, filtered publication, and idempotence', async () => {
  const config = await loadConfig(configFile); const first = await sync(config, 'secret');
  assert.equal(first.status, 'ok', JSON.stringify(first)); assert.equal(first.counts.total, 4);
  const args = JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--delay') + 1], '17'); assert.ok(!args.includes('--request-delay'));
  assert.ok(await stat(path.join(root, 'state', 'upstream-export', 'alpha', 'conversation.md')));
  await assert.rejects(() => readFile(path.join(root, 'output', 'alpha', 'private.json')));
  await sync(config, 'secret'); assert.equal((await verify(config)).status, 'ok');
});

test('failure, auth, rate, partial output, and changed content do not corrupt publication', async () => {
  const config = await loadConfig(configFile); await sync(config, 'secret');
  const before = await readFile(path.join(root, 'output', 'alpha', 'conversation.md'), 'utf8');
  process.env.FAKE_MODE = 'partial'; assert.equal((await sync(config, 'secret')).classification, 'invalid-output');
  assert.equal(await readFile(path.join(root, 'output', 'alpha', 'conversation.md'), 'utf8'), before);
  process.env.FAKE_MODE = 'auth'; assert.equal((await sync(config, 'secret')).classification, 'auth');
  process.env.FAKE_MODE = 'rate'; assert.equal((await sync(config, 'secret')).classification, 'rate-limit');
  process.env.FAKE_MODE = 'fail'; assert.equal((await sync(config, 'secret')).classification, 'exporter-failure');
  delete process.env.FAKE_MODE; process.env.FAKE_VERSION = '-updated'; await sync(config, 'secret');
  assert.match(await readFile(path.join(root, 'output', 'alpha', 'conversation.md'), 'utf8'), /# alpha-updated/);
});

test('equal hashes preserve mtime and verify detects mismatch', async () => {
  const config = await loadConfig(configFile); await sync(config, 'secret');
  const target = path.join(root, 'output', 'alpha', 'conversation.md'); await utimes(target, new Date(123456000), new Date(123456000));
  await sync(config, 'secret'); assert.equal((await stat(target)).mtimeMs, 123456000);
  const manifestPath = path.join(root, 'state', 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.upstream.revision = 'wrong'; await writeFile(manifestPath, JSON.stringify(manifest)); assert.equal((await verify(config)).classification, 'upstream-mismatch');
});

test('token environment and optional token argument branches plus lock overlap', async () => {
  const config = await loadConfig(configFile); config.exporter.supports_token_env = false; assert.equal((await sync(config, 'secret')).status, 'ok');
  const args = JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8')); assert.equal(args[args.indexOf('--token') + 1], 'secret');
  await mkdir(path.join(root, 'state', 'sync.lock'), { recursive: true }); assert.equal((await sync(config, 'secret')).classification, 'locked');
});

test('missing token is classified without invoking exporter', async () => {
  const config = await loadConfig(configFile); assert.equal((await sync(config, undefined)).classification, 'missing-token'); assert.equal((await status(config)).status, 'failed');
});

test('omitted exporter uses the flake runtime command', async () => {
  const config = await loadConfig(configFile);
  const text = await readFile(configFile, 'utf8');
  await writeFile(configFile, text.replace(/exporter:\n  executable: .*\n/, 'exporter:\n'));
  const defaulted = await loadConfig(configFile);
  assert.equal(defaulted.exporter.executable, 'chatgpt-exporter');
});

test('staged publication is recovered before a later failed export', async () => {
  const config = await loadConfig(configFile); await sync(config, 'secret');
  const destination = path.join(root, 'output', 'alpha', 'conversation.md'); const content = await readFile(destination);
  await rm(destination); const publication = path.join(root, 'state', 'publication', 'interrupted'); const source = path.join(publication, 'conversation.md');
  await mkdir(publication, { recursive: true }); await writeFile(source, content); await writeFile(path.join(publication, 'state.json'), JSON.stringify({ status: 'staged', planned: [{ source, destination, path: 'conversation.md' }] }));
  process.env.FAKE_MODE = 'fail'; assert.equal((await sync(config, 'secret')).classification, 'exporter-failure'); assert.deepEqual(await readFile(destination), content);
});
