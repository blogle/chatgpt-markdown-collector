import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { configuredTokenCommand, runTokenCommand } from './credential-provider.js';

export const UPSTREAM = {
  name: 'chatgpt-exporter', version: '1.1.0',
  revision: 'c0185e8937b7e3d19a5f1f34aab5d49fa8d1aa7e',
  integrity: 'sha512-UGMzldzZMwu/551ewevfPJcoqrIY2I6w4btfvFWFLKQflxQubRR4n1U03TWtUUw72NMjL+OyI0nm8CYr6i6pqw==',
  license: 'MIT'
};
export const AUTH_ENDPOINT = 'https://chatgpt.com/backend-api/conversations?offset=0&limit=1';
const BROWSER_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://chatgpt.com/',
  Origin: 'https://chatgpt.com',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin'
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const exists = async (file) => { try { await fs.access(file); return true; } catch { return false; } };
const resolve = (base, value) => path.resolve(base, value);
const safeRelative = (value, label, allowRoot = false) => {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error(`${label} must be relative`);
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if ((!allowRoot && normalized === '.') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`${label} escapes its root`);
  return normalized;
};

async function contained(root, target, label, allowMissing = true) {
  const rootReal = await fs.realpath(root);
  const targetPath = path.resolve(target);
  let targetReal;
  try { targetReal = await fs.realpath(targetPath); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    targetReal = path.join(await fs.realpath(path.dirname(targetPath)), path.basename(targetPath));
  }
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) throw new Error(`${label} escapes its root`);
  return targetReal;
}

async function rejectSymlinkRoot(root, label) {
  try { if ((await fs.lstat(root)).isSymbolicLink()) throw new Error(`${label} must not be a symlink`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

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
    const output = safeRelative(String(project.output || id), `project ${id} output`, true);
    return { ...project, id, output };
  });
  if (config.token_command !== undefined && !configuredTokenCommand(config.token_command)) throw new Error('token_command must be a non-empty argv list');
  const tokenEnv = config.token_env || 'CHATGPT_TOKEN';
  if (typeof tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('token_env must be a valid environment variable name');
  const destinations = new Set();
  for (const project of projects) {
    if ([...destinations].some((destination) => destination === project.output || destination.startsWith(`${project.output}/`) || project.output.startsWith(`${destination}/`))) throw new Error(`duplicate project destination: ${project.output}`);
    destinations.add(project.output);
  }
  return {
    ...config, root, stateDir, outputDir, projects,
    tokenEnv,
    tokenCommand: config.token_command,
    tokenCommandTimeoutMs: Number.isFinite(config.token_command_timeout_ms) ? config.token_command_timeout_ms : 15000,
    auth: { preflight: true, endpoint: AUTH_ENDPOINT, timeout_ms: 15000, status_ttl_ms: 60000, ...(config.auth || {}) },
    exporter: { concurrency: 3, delay_ms: 0, timeout_ms: 600000, timeout_grace_ms: 5000, supports_token_env: true, executable: 'chatgpt-exporter', ...(config.exporter || {}),
      executable: /[\\/]/.test((config.exporter || {}).executable || 'chatgpt-exporter') ? resolve(root, (config.exporter || {}).executable) : ((config.exporter || {}).executable || 'chatgpt-exporter') }
  };
}

export function credentialMetadata(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.trim()) return { status: 'no-credential', classification: 'no-credential' };
  const parts = token.split('.');
  if (parts.length !== 3) return { status: 'invalid', classification: 'credential-malformed' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Number.isFinite(payload.exp)) return { status: 'invalid', classification: 'credential-malformed' };
    const expiresAt = new Date(payload.exp * 1000).toISOString();
    if (payload.exp * 1000 <= now) return { status: 'expired', classification: 'credential-apparently-expired', expires_at: expiresAt };
    return { status: 'configured', classification: 'credential-configured', expires_at: expiresAt };
  } catch {
    return { status: 'invalid', classification: 'credential-malformed' };
  }
}

export async function authenticationPreflight(config, token, dependencies = {}) {
  const metadata = credentialMetadata(token, dependencies.now?.() ?? Date.now());
  if (metadata.status !== 'configured') return { ...metadata, ready: false };
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ...metadata, status: 'failed', classification: 'network-failure', ready: false };
  const timeoutMs = Number.isFinite(config.auth.timeout_ms) ? config.auth.timeout_ms : 15000;
  const controller = new AbortController();
  const deviceId = dependencies.deviceId || randomUUID();
  let timedOut = false;
  let interrupted = false;
  const onAbort = () => { interrupted = true; controller.abort(); };
  if (dependencies.signal?.aborted) onAbort();
  else dependencies.signal?.addEventListener('abort', onAbort, { once: true });
  let timeout;
  let pollTimer;
  let response;
  let body;
  try {
    const request = fetchImpl(config.auth.endpoint, {
      method: 'GET', redirect: 'manual',
      headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${token}`, 'Oai-Device-Id': deviceId, 'Oai-Language': 'en-US' },
      signal: controller.signal
    });
    const operation = request.then(async (result) => {
      if (result.ok) return { result, body: await result.json() };
      return { result, body: null };
    });
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('authentication preflight timed out')); }, timeoutMs);
      const check = () => {
        if (interrupted) reject(new Error('authentication preflight interrupted'));
        else pollTimer = setTimeout(check, 10);
      };
      pollTimer = setTimeout(check, 10);
    });
    ({ result: response, body } = await Promise.race([operation, deadline]));
  } catch {
    if (timedOut) return { ...metadata, status: 'failed', classification: 'preflight-timeout', ready: false, device_id: deviceId };
    if (interrupted) return { ...metadata, status: 'failed', classification: 'interrupted', ready: false, device_id: deviceId };
    return { ...metadata, status: 'failed', classification: 'network-failure', ready: false, device_id: deviceId };
  } finally {
    clearTimeout(timeout);
    clearTimeout(pollTimer);
    dependencies.signal?.removeEventListener('abort', onAbort);
  }
  const checkedAt = new Date().toISOString();
  if (response.status === 401) return { ...metadata, status: 'rejected', classification: 'credential-rejected-401', ready: false, checked_at: checkedAt, device_id: deviceId };
  if (response.status === 403) return { ...metadata, status: 'rejected', classification: 'credential-rejected-403', ready: false, checked_at: checkedAt, device_id: deviceId };
  if (response.status === 429) return { ...metadata, status: 'rate-limited', classification: 'rate-limit', ready: false, checked_at: checkedAt, device_id: deviceId };
  if ([301, 302, 303, 307, 308, 404, 405].includes(response.status)) return { ...metadata, status: 'failed', classification: 'upstream-endpoint-changed', ready: false, http_status: response.status, checked_at: checkedAt, device_id: deviceId };
  if (!response.ok) return { ...metadata, status: 'failed', classification: 'upstream-failure', ready: false, http_status: response.status, checked_at: checkedAt, device_id: deviceId };
  if (!body || typeof body !== 'object') {
    return { ...metadata, status: 'failed', classification: 'upstream-endpoint-changed', ready: false, http_status: response.status, checked_at: checkedAt, device_id: deviceId };
  }
  return { ...metadata, status: 'ready', classification: 'credential-ready', ready: true, http_status: response.status, checked_at: checkedAt, device_id: deviceId };
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
  await contained(stage, stage, `project ${project.id} stage`, false);
  const files = await walk(stage);
  const markdown = files.filter((file) => path.extname(file).toLowerCase() === '.md');
  if (!markdown.length) throw new Error(`project ${project.id}: exporter produced no markdown`);
  const selected = new Set(markdown);
  const missing = [];
  for (const file of markdown) {
    const text = await fs.readFile(file, 'utf8');
    for (const ref of referencedFiles(text)) {
      const target = path.resolve(path.dirname(file), ref);
      if (!(await exists(target))) missing.push({ from: path.relative(stage, file), ref });
      else {
        await contained(stage, target, `attachment ${ref}`, false);
        selected.add(target);
      }
    }
  }
  if (missing.length) throw new Error(`project ${project.id}: missing attachment ${JSON.stringify(missing[0])}`);
  const entries = [];
  for (const file of selected) {
    await contained(stage, file, `project ${project.id} output`, false);
    const data = await fs.readFile(file);
    entries.push({ path: path.relative(stage, file).split(path.sep).join('/'), bytes: data.length, sha256: sha256(data), classification: path.extname(file).toLowerCase() === '.md' ? 'markdown' : 'asset' });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { files: entries, counts: { markdown: entries.filter((x) => x.classification === 'markdown').length, assets: entries.filter((x) => x.classification === 'asset').length, total: entries.length } };
}

function runExporter(config, project, output, token, signal) {
  const args = ['backup', '-o', output, '--incremental', '--download-files', '--project', project.id, '--concurrency', String(config.exporter.concurrency), '--delay', String(config.exporter.delay_ms)];
  const env = { ...process.env, ...(config.exporter.env || {}) };
  if (config.exporter.supports_token_env) env[config.tokenEnv] = token; else args.push('--token', token);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.exporter.executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    let interrupted = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    let graceTimer;
    const stop = (classification, signal = 'SIGTERM') => {
      if (classification === 'timeout') timedOut = true;
      else interrupted = true;
      child.kill(signal);
      graceTimer = setTimeout(() => child.kill('SIGKILL'), config.exporter.timeout_grace_ms);
    };
    const killTimer = setTimeout(() => stop('timeout'), config.exporter.timeout_ms);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (timedOut) reject(Object.assign(new Error(`exporter timed out for ${project.id}`), { classification: 'timeout' }));
      else if (interrupted) reject(Object.assign(new Error(`exporter interrupted for ${project.id}`), { classification: 'interrupted', signal }));
      else if (code !== 0) reject(Object.assign(new Error(`exporter failed for ${project.id}: code=${code} signal=${signal || 'none'} ${stderr.trim()}`), { code, signal, stderr }));
      else resolvePromise({ stdout, stderr, args });
    });
    const onAbort = () => stop('interrupted');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => signal?.removeEventListener('abort', onAbort));
  });
}

async function resolveToken(config, suppliedToken, dependencies) {
  if (suppliedToken !== undefined) return { token: suppliedToken, classification: suppliedToken ? 'credential-configured' : 'no-credential' };
  if (configuredTokenCommand(config.tokenCommand)) return runTokenCommand(config.tokenCommand, config.tokenCommandTimeoutMs);
  const token = process.env[config.tokenEnv];
  return { token, classification: token ? 'credential-configured' : 'no-credential' };
}

async function atomicCopy(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const parent = path.dirname(destination);
  await fs.realpath(parent);
  try { if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error(`refusing symlink destination: ${destination}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (await exists(destination)) {
    const [before, after] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
    if (sha256(before) === sha256(after)) return false;
  }
  const temp = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try { await fs.copyFile(source, temp); await fs.rename(temp, destination); return true; } finally { await fs.rm(temp, { force: true }); }
}

async function acquireLock(stateDir) {
  const lock = path.join(stateDir, 'sync.lock');
  try { await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner'), json({ pid: process.pid, started_at: new Date().toISOString() })); return lock; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner'), 'utf8')); } catch { owner = null; }
    let alive = true;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (probe) { alive = probe.code === 'EPERM'; }
    }
    if (owner && !alive) {
      await fs.rm(lock, { recursive: true, force: true });
      try { await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner'), json({ pid: process.pid, started_at: new Date().toISOString() })); return lock; }
      catch { /* another process won the stale-lock race */ }
    }
    throw Object.assign(new Error('another sync is already running'), { classification: 'locked' });
  }
}

async function publish(runDir, outputDir, manifest, stateDir) {
  await fs.mkdir(outputDir, { recursive: true });
  await contained(outputDir, outputDir, 'output', false);
  const publishDir = path.join(stateDir, 'publication', manifest.run_id);
  await fs.mkdir(publishDir, { recursive: true });
  const planned = [];
  for (const file of manifest.files) {
    const staged = path.join(publishDir, file.path);
    const destination = path.join(outputDir, manifest.output_prefix, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await contained(outputDir, destination, `manifest file ${file.path}`);
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

async function recoverPublications(stateDir, outputDir) {
  const root = path.join(stateDir, 'publication');
  if (!(await exists(root))) return;
  await rejectSymlinkRoot(root, 'publication');
  await contained(stateDir, root, 'publication', false);
  for (const name of await fs.readdir(root)) {
    const dir = path.join(root, name); const stateFile = path.join(dir, 'state.json');
    if (!(await fs.lstat(dir)).isDirectory()) continue;
    await contained(root, dir, 'publication directory', false);
    if (!(await exists(stateFile))) { await fs.rm(dir, { recursive: true, force: true }); continue; }
    let state;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { await fs.rm(dir, { recursive: true, force: true }); continue; }
    if (state?.status !== 'staged' || !Array.isArray(state.planned)) { await fs.rm(dir, { recursive: true, force: true }); continue; }
    for (const item of state.planned) {
      if (!item || typeof item.source !== 'string' || typeof item.destination !== 'string') throw new Error('invalid staged publication');
      await contained(dir, item.source, 'recovery source', false);
      await contained(outputDir, item.destination, 'recovery destination');
      if (await exists(item.source)) await atomicCopy(item.source, item.destination);
    }
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

function redact(value, token) {
  return token && typeof value === 'string' ? value.split(token).join('[REDACTED]') : value;
}

function safeError(error, token) {
  return Object.assign(new Error(redact(error?.message || error, token)), error?.classification ? { classification: error.classification } : {}, error?.code ? { code: error.code } : {}, error?.signal ? { signal: error.signal } : {}, error?.stderr ? { stderr: redact(error.stderr, token) } : {});
}

async function recordFailure(config, classification, error, runId = null, startedAt = null, auth = null) {
  await fs.mkdir(config.stateDir, { recursive: true });
  await rejectSymlinkRoot(config.stateDir, 'state_dir');
  const result = { status: 'failed', classification, error: String(error), run_id: runId, upstream: UPSTREAM, started_at: startedAt, completed_at: new Date().toISOString(), ...(auth ? { auth } : {}) };
  await fs.writeFile(path.join(config.stateDir, 'collector-state.json'), json(result));
  return result;
}

export async function sync(config, token, dependencies = {}) {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  const provided = await resolveToken(config, token, dependencies);
  token = provided.token;
  if (!token) return recordFailure(config, provided.classification, 'credential provider did not provide a usable credential', runId, startedAt, { status: 'failed', classification: provided.classification });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let authResult = null;
  if (config.auth.preflight) {
    let priorState = null;
    try { priorState = JSON.parse(await fs.readFile(path.join(config.stateDir, 'collector-state.json'), 'utf8')); } catch { /* no prior state */ }
    const auth = await authenticationPreflight(config, token, { ...dependencies, signal: controller.signal, deviceId: priorState?.auth?.device_id });
    authResult = auth;
    if (!auth.ready) {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      return recordFailure(config, auth.classification, 'authentication preflight failed', runId, startedAt, auth);
    }
  }
  let lock;
  try {
    await fs.mkdir(config.stateDir, { recursive: true });
    await rejectSymlinkRoot(config.stateDir, 'state_dir');
    await rejectSymlinkRoot(config.outputDir, 'output_dir');
    lock = await acquireLock(config.stateDir);
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    await recoverPublications(config.stateDir, config.outputDir);
    const runDir = path.join(config.stateDir, 'runs', runId);
    const prior = await exists(path.join(config.stateDir, 'manifest.json')) ? JSON.parse(await fs.readFile(path.join(config.stateDir, 'manifest.json'), 'utf8')) : null;
    const projects = [];
    for (const project of config.projects) {
      const upstreamDir = path.join(config.stateDir, 'upstream-export', project.id);
      const stage = path.join(runDir, project.id);
      await fs.mkdir(stage, { recursive: true });
      await rejectSymlinkRoot(upstreamDir, `upstream export for ${project.id}`);
      if (controller.signal.aborted) throw Object.assign(new Error('sync interrupted'), { classification: 'interrupted' });
      await runExporter(config, project, upstreamDir, token, controller.signal);
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
    const result = { status: 'ok', run_id: runId, started_at: startedAt, completed_at: new Date().toISOString(), upstream: UPSTREAM, configured_projects: config.projects.map(({ id, name, output }) => ({ id, name, output })), projects, publication, auth: { ...(authResult || {}), token_env: config.tokenEnv, mode: config.exporter.supports_token_env ? 'environment' : 'argument', ...(config.exporter.supports_token_env === false ? { warning: 'supports_token_env=false uses the less-safe --token compatibility transport' } : {}) }, errors: [], skipped: publication.skipped, hashes: projects.flatMap((project) => project.files.map((file) => ({ project: project.project, ...file }))), counts: projects.reduce((a, x) => ({ markdown: a.markdown + x.counts.markdown, assets: a.assets + x.counts.assets, total: a.total + x.counts.total }), { markdown: 0, assets: 0, total: 0 }) };
    await fs.writeFile(path.join(config.stateDir, 'manifest.json'), json(result));
    await fs.writeFile(path.join(config.stateDir, 'collector-state.json'), json(result));
    return result;
  } catch (error) {
    const safe = safeError(error, token);
    return recordFailure(config, classify(safe), safe.message, runId, startedAt);
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (lock) await fs.rm(lock, { recursive: true, force: true });
  }
}

export async function verify(config) {
  const manifestFile = path.join(config.stateDir, 'manifest.json');
  if (!(await exists(manifestFile))) return { status: 'invalid', classification: 'missing-manifest' };
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (manifest.upstream?.revision !== UPSTREAM.revision || manifest.upstream?.integrity !== UPSTREAM.integrity) return { status: 'invalid', classification: 'upstream-mismatch', expected: UPSTREAM, actual: manifest.upstream };
  const failures = [];
  await rejectSymlinkRoot(config.outputDir, 'output_dir');
  if (!(await exists(config.outputDir))) return { status: 'invalid', failures: (manifest.projects || []).flatMap((project) => (project.files || []).map((file) => ({ path: file.path, classification: 'missing' }))) };
  await contained(config.outputDir, config.outputDir, 'output', false);
  for (const project of manifest.projects || []) for (const file of project.files || []) {
    const target = path.join(config.outputDir, project.output_prefix, file.path);
    await contained(config.outputDir, target, `manifest file ${file.path}`);
    if (!(await exists(target))) failures.push({ path: file.path, classification: 'missing' });
    else if (sha256(await fs.readFile(target)) !== file.sha256) failures.push({ path: file.path, classification: 'hash-mismatch' });
  }
  return failures.length ? { status: 'invalid', failures } : { status: 'ok', run_id: manifest.run_id, counts: manifest.counts };
}

export async function status(config, token, dependencies = {}) {
  const file = path.join(config.stateDir, 'collector-state.json');
  const collector = (await exists(file)) ? JSON.parse(await fs.readFile(file, 'utf8')) : { status: 'never-run' };
  const age = collector.auth?.checked_at ? Date.now() - Date.parse(collector.auth.checked_at) : Infinity;
  const cached = ['ready', 'rejected'].includes(collector.auth?.status) && age >= 0 && age <= config.auth.status_ttl_ms;
  const provided = await resolveToken(config, token, dependencies);
  const auth = config.auth.preflight
    ? cached ? collector.auth : provided.token ? await authenticationPreflight(config, provided.token, { ...dependencies, deviceId: collector.auth?.device_id }) : { status: 'failed', classification: provided.classification, ready: false }
    : { status: 'not-checked', classification: 'preflight-disabled', ready: null };
  return { ...collector, auth };
}
