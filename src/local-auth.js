import fs from 'node:fs';
import path from 'node:path';

export const CHATGPT_HOME = 'https://chatgpt.com/';
export const CHATGPT_SESSION = 'https://chatgpt.com/api/auth/session';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function profileError(message) {
  const error = new Error(message);
  error.code = 'ERR_PROFILE_UNAVAILABLE';
  return error;
}

function browserExecutableError(message = 'a valid browser executable is required') {
  const error = new Error(message);
  error.code = 'ERR_BROWSER_EXECUTABLE_UNAVAILABLE';
  return error;
}

export function validateBrowserExecutable(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw browserExecutableError();
  try {
    if (!fs.statSync(value).isFile()) throw browserExecutableError();
    fs.accessSync(value, fs.constants.X_OK);
  } catch {
    throw browserExecutableError();
  }
  return value;
}

export function validateProfilePath(value, cwd = process.cwd()) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw profileError('an explicit absolute --profile path is required');
  }
  const profile = path.resolve(value);
  const repository = path.resolve(cwd);
  const normalProfile = /(^|[/\\])(?:\.mozilla|\.config[/\\](?:google-chrome|chromium|microsoft-edge)|Library[/\\]Application Support[/\\](?:Google[/\\]Chrome|Chromium)|AppData[/\\](?:Local|Roaming)[/\\](?:Google[/\\]Chrome|Microsoft[/\\]Edge)|User Data)(?:[/\\]|$)/i;
  if (isInside(repository, profile)) throw profileError('the local-auth profile must not be inside the repository');
  if (normalProfile.test(profile) || /[/\\](?:Default|Profile \d+)$/.test(profile)) {
    throw profileError('normal browser profiles are not allowed; choose a dedicated local-auth profile');
  }
  if (profile === path.parse(profile).root || profile === path.resolve(process.env.HOME || '/', '.')) {
    throw profileError('the local-auth profile must be a dedicated directory');
  }
  return profile;
}

function parseSession(result) {
  if (!result || result.status === 401 || result.status === 403) return null;
  if (result.status !== 200) {
    throw Object.assign(new Error(`ChatGPT session endpoint returned HTTP ${result.status}`), { code: 'ERR_SESSION_UNAVAILABLE' });
  }
  let body;
  try { body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body; } catch {
    throw Object.assign(new Error('ChatGPT session endpoint returned invalid JSON'), { code: 'ERR_SESSION_UNAVAILABLE' });
  }
  return typeof body?.accessToken === 'string' && body.accessToken ? body.accessToken : null;
}

function browserTimeoutError(message) {
  const error = new Error(message);
  error.code = 'ERR_BROWSER_TIMEOUT';
  return error;
}

function sessionUnavailableError(message) {
  const error = new Error(message);
  error.code = 'ERR_SESSION_UNAVAILABLE';
  return error;
}

async function sessionFromPage(page, timeoutMs) {
  const result = await page.evaluate(async (timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include', signal: controller.signal });
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }, timeoutMs);
  return parseSession(result);
}

async function withContext({ profile, executablePath, headless, timeoutMs, playwright, operation }) {
  const resolvedProfile = validateProfilePath(profile);
  const browserExecutable = validateBrowserExecutable(executablePath);
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const context = await playwright.chromium.launchPersistentContext(resolvedProfile, { headless, executablePath: browserExecutable });
  let timer;
  try {
    const work = (async () => {
      const page = await context.newPage();
      await page.goto(CHATGPT_HOME, { waitUntil: 'domcontentloaded', timeout });
      return operation({ context, page, timeout });
    })();
    const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(browserTimeoutError('local-auth operation timed out')), timeout); });
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
    await context.close();
  }
}

export async function localAuth(command, { profile, executablePath, timeoutMs = DEFAULT_TIMEOUT_MS, playwright }) {
  if (!playwright) throw new Error('Playwright is required');
  if (!['login', 'token', 'status', 'revoke'].includes(command)) throw new Error(`unknown local-auth command: ${command}`);
  const browserExecutable = executablePath || process.env.CHATGPT_BROWSER_EXECUTABLE;
  if (command === 'login') {
    return withContext({ profile, executablePath: browserExecutable, headless: false, timeoutMs, playwright, operation: async ({ page, timeout }) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await sessionFromPage(page, Math.min(timeout, 5000))) return { status: 'ready', classification: 'credential-ready' };
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw browserTimeoutError('login timed out; no password or 2FA was entered by the helper');
    }});
  }
  if (command === 'revoke') {
    return withContext({ profile, executablePath: browserExecutable, headless: true, timeoutMs, playwright, operation: async ({ context, page }) => {
      await context.clearCookies();
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      return { status: 'revoked', classification: 'credential-revoked' };
    }});
  }
  return withContext({ profile, executablePath: browserExecutable, headless: true, timeoutMs, playwright, operation: async ({ page, timeout }) => {
    const token = await sessionFromPage(page, timeout);
    if (command === 'token') {
      if (!token) throw sessionUnavailableError('no active ChatGPT session; run login first');
      return token;
    }
    return token
      ? { status: 'ready', classification: 'credential-ready' }
      : { status: 'unauthenticated', classification: 'no-credential' };
  }});
}
