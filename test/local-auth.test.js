import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localAuth, validateBrowserExecutable, validateProfilePath } from '../src/local-auth.js';

const profile = '/tmp/chatgpt-local-auth-test-profile';
const browserExecutable = process.execPath;

function fakePlaywright({ accessToken = 'token', evaluateError, launchError } = {}) {
  const calls = [];
  const page = {
    async goto(url, options) { calls.push(['goto', url, options]); },
    async evaluate(fn, timeoutMs) {
      calls.push(['evaluate', ...Array.from(arguments)]);
      if (evaluateError) throw evaluateError;
      const source = String(fn);
      if (source.includes('localStorage.clear')) return undefined;
      return { status: accessToken ? 200 : 401, body: JSON.stringify(accessToken ? { accessToken } : {}) };
    },
  };
  const context = {
    async newPage() { calls.push(['newPage']); return page; },
    async clearCookies() { calls.push(['clearCookies']); },
    async close() { calls.push(['close']); },
  };
  return {
    calls,
    context,
    chromium: {
      async launchPersistentContext(path, options) {
        calls.push(['launch', path, options]);
        if (launchError) throw launchError;
        return context;
      },
    },
  };
}

function cliStdout(result) {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

test('requires a dedicated absolute profile and rejects repository or normal browser paths', () => {
  assert.equal(validateProfilePath(profile, '/repo'), profile);
  assert.throws(() => validateProfilePath('relative', '/repo'), /absolute/);
  assert.throws(() => validateProfilePath('/repo/auth', '/repo'), /repository/);
  assert.throws(() => validateProfilePath('/home/me/.config/google-chrome', '/repo'), /normal browser/);
  assert.throws(() => validateProfilePath('/home/me/.config/google-chrome/Default', '/repo'), /normal browser/);
  assert.throws(() => validateProfilePath('/home/me/.mozilla', '/repo'), /normal browser/);
  assert.throws(() => validateProfilePath('/', '/repo'), /dedicated/);
});

test('requires an absolute existing executable browser path', () => {
  assert.equal(validateBrowserExecutable(browserExecutable), browserExecutable);
  assert.throws(() => validateBrowserExecutable(undefined), /browser executable/);
  assert.throws(() => validateBrowserExecutable('relative/browser'), /browser executable/);
  assert.throws(() => validateBrowserExecutable('/path/that/does/not/exist'), /browser executable/);
});

test('token and status use headless official ChatGPT session only', async () => {
  const playwright = fakePlaywright({ accessToken: 'jwt-value' });
  assert.equal(await localAuth('token', { profile, executablePath: browserExecutable, playwright }), 'jwt-value');
  assert.equal(playwright.calls[0][0], 'launch');
  assert.equal(playwright.calls[0][2].headless, true);
  assert.equal(playwright.calls[0][2].executablePath, browserExecutable);
  const gotoCall = playwright.calls.find(([name]) => name === 'goto');
  assert.ok(gotoCall);
  assert.equal(gotoCall[1], 'https://chatgpt.com/');
  const evaluateCall = playwright.calls.find(([name]) => name === 'evaluate');
  assert.ok(evaluateCall);
  assert.equal(evaluateCall.length, 3, 'session evaluate receives exactly two arguments');
  assert.equal(typeof evaluateCall[1], 'function');
  assert.equal(typeof evaluateCall[2], 'number');
  assert.deepEqual(await localAuth('status', { profile, executablePath: browserExecutable, playwright: fakePlaywright({ accessToken: null }) }), { status: 'unauthenticated', classification: 'no-credential' });
});

test('token stdout protocol returns raw token and JSON status', async () => {
  const tokenPlaywright = fakePlaywright({ accessToken: 'jwt-value' });
  assert.equal(cliStdout(await localAuth('token', { profile, executablePath: browserExecutable, playwright: tokenPlaywright })), 'jwt-value');
  const statusPlaywright = fakePlaywright({ accessToken: null });
  assert.equal(cliStdout(await localAuth('status', { profile, executablePath: browserExecutable, playwright: statusPlaywright })), JSON.stringify({ status: 'unauthenticated', classification: 'no-credential' }));
});

test('login is headful and revoke clears the dedicated session', async () => {
  const login = fakePlaywright({ accessToken: 'jwt-value' });
  assert.deepEqual(await localAuth('login', { profile, executablePath: browserExecutable, playwright: login }), { status: 'ready', classification: 'credential-ready' });
  assert.equal(login.calls[0][2].headless, false);
  const revoke = fakePlaywright({ accessToken: null });
  assert.deepEqual(await localAuth('revoke', { profile, executablePath: browserExecutable, playwright: revoke }), { status: 'revoked', classification: 'credential-revoked' });
  assert.ok(revoke.calls.some(([name]) => name === 'clearCookies'));
  const revokeEvaluate = revoke.calls.find(([name]) => name === 'evaluate');
  assert.ok(revokeEvaluate);
  assert.equal(revokeEvaluate.length, 2, 'storage clear evaluate receives one argument');
});

test('context closes on evaluate failure', async () => {
  const playwright = fakePlaywright({ evaluateError: new Error('evaluate failed') });
  await assert.rejects(() => localAuth('token', { profile, executablePath: browserExecutable, playwright }), /evaluate failed/);
  assert.ok(playwright.calls.some(([name]) => name === 'close'));
});

test('context closes on session failure and outer timeout', async () => {
  const sessionPlaywright = fakePlaywright({ accessToken: null });
  await assert.rejects(() => localAuth('token', { profile, executablePath: browserExecutable, playwright: sessionPlaywright }), /no active ChatGPT session/);
  assert.ok(sessionPlaywright.calls.some(([name]) => name === 'close'));
  const timeoutPlaywright = fakePlaywright({ accessToken: null });
  await assert.rejects(() => localAuth('login', { profile, executablePath: browserExecutable, timeoutMs: 1, playwright: timeoutPlaywright }), /timed out/);
  assert.ok(timeoutPlaywright.calls.some(([name]) => name === 'close'));
});
