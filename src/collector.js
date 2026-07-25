import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const UPSTREAM = {
  name: 'chatgpt-exporter', version: '1.1.0',
  revision: 'c0185e8937b7e3d19a5f1f34aab5d49fa8d1aa7e',
  integrity: 'sha512-UGMzldzZMwu/551ewevfPJcoqrIY2I6w4btfvFWFLKQflxQubRR4n1U03TWtUUw72NMjL+OyI0nm8CYr6i6pqw==',
  license: 'MIT'
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const exists = async (file) => { try { await fs.access(file); return true; } catch { return false; } };
const resolve = (base, value) => path.resolve(base, value);
const safeRelative = (value, label) => {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error(`${label} must be relative`);
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`${label} escapes its root`);
  return normalized;
};

export async function loadConfig(file) {
  const root = path.dirname(path.resolve(file));
  const config = parseYaml(await fs.readFile(file, 'utf8')) || {};
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('projects must be a non-empty list');
  const stateDir = resolve(root, config.state_dir || './state');
  const outputDir = resolve(root, config.output_dir || './output');
  if (stateDir === outputDir || outputDir.startsWith(`${stateDir}${path.sep}`) || stateDir.startsWith(`${outputDir}${path.sep}`)) throw new Error('state_dir and output_dir must not overlap');
  const projects = config.projects.map((project) => {
    if (!project?.id || !project?.name) throw new Error('each project needs id and name');
    const id = safeRelative(String(project.id), 'project id');
    const output = safeRelative(String(project.output || id), `project ${id} output`);
    return { ...project, id, output };
  });
  const destinations = new Set();
  for (const project of projects) {
    if ([...destinations].some((destination) => destination === project.output || destination.startsWith(`${project.output}/`) || project.output.startsWith(`${destination}/`))) throw new Error(`duplicate project destination: ${project.output}`);
    destinations.add(project.output);
  }
  return {
    ...config, root, stateDir, outputDir, projects,
    tokenEnv: config.token_env || 'CHATGPT_TOKEN',
    exporter: { concurrency: 3, delay_ms: 0, timeout_ms: 600000, timeout_grace_ms: 5000, supports_token_env: true, executable: 'chatgpt-exporter', ...(config.exporter || {}),
      executable: /[\\/]/.test((config.exporter || {}).executable || 'chatgpt-exporter') ? resolve(root, (config.exporter || {}).executable) : ((config.exporter || {}).executable || 'chatgpt-exporter') }
  };
}

async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full)); else result.push(full);
  }
  return result;
}

function referencedFiles(markdown) {
  const refs = new Set();
  for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    const ref = match[1].split(/[?#]/, 1)[0].trim();
    if (ref && !/^(?:https?:|data:|#)/i.test(ref)) refs.add(ref);
  }
  return refs;
}

export async function validateStage(stage, project) {
  const files = await walk(stage);
  const markdown = files.filter((file) => path.extname(file).toLowerCase() === '.md');
  if (!markdown.length) throw new Error(`project ${project.id}: exporter produced no markdown`);
  const selected = new Set(markdown);
  const missing = [];
  for (const file of markdown) {
    const text = await fs.readFile(file, 'utf8');
    for (const ref of referencedFiles(text)) {
      const target = path.resolve(path.dirname(file), ref);
      if (!target.startsWith(`${stage}${path.sep}`) || !(await exists(target))) missing.push({ from: path.relative(stage, file), ref });
      else selected.add(target);
    }
  }
  if (missing.length) throw new Error(`project ${project.id}: missing attachment ${JSON.stringify(missing[0])}`);
  const entries = [];
  for (const file of selected) {
    const data = await fs.readFile(file);
    entries.push({ path: path.relative(stage, file).split(path.sep).join('/'), bytes: data.length, sha256: sha256(data), classification: path.extname(file).toLowerCase() === '.md' ? 'markdown' : 'asset' });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { files: entries, counts: { markdown: entries.filter((x) => x.classification === 'markdown').length, assets: entries.filter((x) => x.classification === 'asset').length, total: entries.length } };
}

function runExporter(config, project, output, token) {
  const args = ['backup', '-o', output, '--incremental', '--download-files', '--project', project.id, '--concurrency', String(config.exporter.concurrency), '--delay', String(config.exporter.delay_ms)];
  const env = { ...process.env, ...(config.exporter.env || {}) };
  if (config.exporter.supports_token_env) env[config.tokenEnv] = token; else args.push('--token', token);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.exporter.executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const killTimer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), config.exporter.timeout_grace_ms); }, config.exporter.timeout_ms);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (timedOut) reject(Object.assign(new Error(`exporter timed out for ${project.id}`), { classification: 'timeout' }));
      else if (code !== 0) reject(Object.assign(new Error(`exporter failed for ${project.id}: code=${code} signal=${signal || 'none'} ${stderr.trim()}`), { code, signal, stderr }));
      else resolvePromise({ stdout, stderr, args });
    });
  });
}

async function atomicCopy(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (await exists(destination)) {
    const [before, after] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
    if (sha256(before) === sha256(after)) return false;
  }
  const temp = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try { await fs.copyFile(source, temp); await fs.rename(temp, destination); return true; } finally { await fs.rm(temp, { force: true }); }
}

async function acquireLock(stateDir) {
  const lock = path.join(stateDir, 'sync.lock');
  try { await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner'), `${process.pid}\n`); return lock; }
  catch { throw Object.assign(new Error('another sync is already running'), { classification: 'locked' }); }
}

async function publish(runDir, outputDir, manifest, stateDir) {
  const publishDir = path.join(stateDir, 'publication', manifest.run_id);
  await fs.mkdir(publishDir, { recursive: true });
  const planned = [];
  for (const file of manifest.files) {
    const destination = path.join(outputDir, manifest.output_prefix, file.path);
    const staged = path.join(publishDir, file.path);
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.copyFile(path.join(runDir, file.path), staged);
    planned.push({ source: staged, destination, path: file.path });
  }
  await fs.writeFile(path.join(publishDir, 'state.json'), json({ status: 'staged', planned }));
  const changed = [], skipped = [];
  for (const item of planned) (await atomicCopy(item.source, item.destination) ? changed : skipped).push(item.path);
  await fs.writeFile(path.join(publishDir, 'state.json'), json({ status: 'complete', changed, skipped }));
  await fs.rm(publishDir, { recursive: true, force: true });
  return { changed, skipped };
}

async function recoverPublications(stateDir) {
  const root = path.join(stateDir, 'publication');
  if (!(await exists(root))) return;
  for (const name of await fs.readdir(root)) {
    const dir = path.join(root, name); const stateFile = path.join(dir, 'state.json');
    if (!(await exists(stateFile))) { await fs.rm(dir, { recursive: true, force: true }); continue; }
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.status !== 'staged') continue;
    for (const item of state.planned || []) if (await exists(item.source)) await atomicCopy(item.source, item.destination);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function classify(error) {
  if (error.classification) return error.classification;
  const message = String(error.message || error).toLowerCase();
  if (message.includes('missing attachment')) return 'invalid-output';
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid token|authentication failed|access token/i.test(message)) return 'auth';
  if (message.includes('rate')) return 'rate-limit';
  if (message.includes('interrupted') || error.signal) return 'interrupted';
  return 'exporter-failure';
}

async function recordFailure(config, classification, error, runId = null, startedAt = null) {
  await fs.mkdir(config.stateDir, { recursive: true });
  const result = { status: 'failed', classification, error: String(error), run_id: runId, upstream: UPSTREAM, started_at: startedAt, completed_at: new Date().toISOString() };
  await fs.writeFile(path.join(config.stateDir, 'collector-state.json'), json(result));
  return result;
}

export async function sync(config, token = process.env[config.tokenEnv]) {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  if (!token) return recordFailure(config, 'missing-token', 'token is not set', runId, startedAt);
  let lock;
  try {
    await fs.mkdir(config.stateDir, { recursive: true });
    lock = await acquireLock(config.stateDir);
    await recoverPublications(config.stateDir);
    const runDir = path.join(config.stateDir, 'runs', runId);
    const prior = await exists(path.join(config.stateDir, 'manifest.json')) ? JSON.parse(await fs.readFile(path.join(config.stateDir, 'manifest.json'), 'utf8')) : null;
    const projects = [];
    for (const project of config.projects) {
      const upstreamDir = path.join(config.stateDir, 'upstream-export', project.id);
      const stage = path.join(runDir, project.id);
      await fs.mkdir(stage, { recursive: true });
      await runExporter(config, project, upstreamDir, token);
      const manifest = await validateStage(upstreamDir, project);
      const previous = prior?.projects?.find((item) => item.project === project.id);
      const old = new Map((previous?.files || []).map((file) => [file.path, file.sha256]));
      const comparison = { added: 0, changed: 0, unchanged: 0 };
      for (const file of manifest.files) old.has(file.path) ? (old.get(file.path) === file.sha256 ? comparison.unchanged++ : comparison.changed++) : comparison.added++;
      await fs.cp(upstreamDir, stage, { recursive: true });
      projects.push({ project: project.id, name: project.name, output_prefix: project.output, ...manifest, comparison });
    }
    const publication = { changed: [], skipped: [] };
    for (const manifest of projects) { const result = await publish(path.join(runDir, manifest.project), config.outputDir, { ...manifest, run_id: runId }, config.stateDir); publication.changed.push(...result.changed); publication.skipped.push(...result.skipped); }
    const result = { status: 'ok', run_id: runId, started_at: startedAt, completed_at: new Date().toISOString(), upstream: UPSTREAM, configured_projects: config.projects.map(({ id, name, output }) => ({ id, name, output })), projects, publication, auth: { token_env: config.tokenEnv, mode: config.exporter.supports_token_env ? 'environment' : 'argument' }, errors: [], skipped: publication.skipped, hashes: projects.flatMap((project) => project.files.map((file) => ({ project: project.project, ...file }))), counts: projects.reduce((a, x) => ({ markdown: a.markdown + x.counts.markdown, assets: a.assets + x.counts.assets, total: a.total + x.counts.total }), { markdown: 0, assets: 0, total: 0 }) };
    await fs.writeFile(path.join(config.stateDir, 'manifest.json'), json(result));
    await fs.writeFile(path.join(config.stateDir, 'collector-state.json'), json(result));
    return result;
  } catch (error) {
    return recordFailure(config, classify(error), error.message, runId, startedAt);
  } finally { if (lock) await fs.rm(lock, { recursive: true, force: true }); }
}

export async function verify(config) {
  const manifestFile = path.join(config.stateDir, 'manifest.json');
  if (!(await exists(manifestFile))) return { status: 'invalid', classification: 'missing-manifest' };
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (manifest.upstream?.revision !== UPSTREAM.revision || manifest.upstream?.integrity !== UPSTREAM.integrity) return { status: 'invalid', classification: 'upstream-mismatch', expected: UPSTREAM, actual: manifest.upstream };
  const failures = [];
  for (const project of manifest.projects || []) for (const file of project.files || []) {
    const target = path.join(config.outputDir, project.output_prefix, file.path);
    if (!(await exists(target))) failures.push({ path: file.path, classification: 'missing' });
    else if (sha256(await fs.readFile(target)) !== file.sha256) failures.push({ path: file.path, classification: 'hash-mismatch' });
  }
  return failures.length ? { status: 'invalid', failures } : { status: 'ok', run_id: manifest.run_id, counts: manifest.counts };
}

export async function status(config) { const file = path.join(config.stateDir, 'collector-state.json'); return (await exists(file)) ? JSON.parse(await fs.readFile(file, 'utf8')) : { status: 'never-run' }; }
