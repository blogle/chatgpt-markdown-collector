import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_STDOUT_BYTES = 64 * 1024;

// Credential providers are deliberately transport-only: browser/session
// acquisition belongs in a separate integration, not in the collector core.
export function configuredTokenCommand(command) {
  return Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string' && part.length > 0)
    ? command
    : null;
}

export function validateProviderToken(token) {
  if (typeof token !== 'string' || !token.trim()) return 'credential-provider-empty';
  const parts = token.trim().split('.');
  if (parts.length !== 3) return 'credential-provider-malformed';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Number.isFinite(payload.exp)) return 'credential-provider-malformed';
  } catch {
    return 'credential-provider-malformed';
  }
  return null;
}

export function runTokenCommand(command, timeoutMs = 15000) {
  const argv = configuredTokenCommand(command);
  if (!argv) return Promise.resolve({ token: null, classification: 'credential-provider-malformed' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch {
      resolve({ token: null, classification: 'credential-provider-nonzero' });
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let timedOut = false;
    let oversized = false;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    child.stdout.on('data', (chunk) => {
      if (oversized) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        oversized = true;
        child.kill('SIGTERM');
        return;
      }
      stdout += chunk;
    });
    // Consume diagnostics, but never retain or report them.
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 100).unref();
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    child.on('error', () => { clearTimeout(timer); finish({ token: null, classification: 'credential-provider-nonzero' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return finish({ token: null, classification: 'credential-provider-timeout' });
      if (oversized) return finish({ token: null, classification: 'credential-provider-malformed' });
      if (code !== 0) return finish({ token: null, classification: 'credential-provider-nonzero' });
      const token = stdout.trim();
      const classification = validateProviderToken(token);
      finish(classification ? { token: null, classification } : { token, classification: 'credential-provider-success' });
    });
  });
}
