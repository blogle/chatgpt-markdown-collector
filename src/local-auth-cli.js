#!/usr/bin/env node
import { localAuth } from './local-auth.js';

function usage() {
  console.error('usage: chatgpt-local-auth <login|token|status|revoke> --profile /absolute/dedicated/path --browser-executable /absolute/path [--timeout-ms N]');
}

function profileError(message) {
  const error = new Error(message);
  error.code = 'ERR_PROFILE_UNAVAILABLE';
  return error;
}

function options(args) {
  const profileIndex = args.indexOf('--profile');
  const browserIndex = args.indexOf('--browser-executable');
  const timeoutIndex = args.indexOf('--timeout-ms');
  if (profileIndex < 0 || !args[profileIndex + 1]) throw profileError('an explicit --profile path is required');
  if (args.some((arg, index) => (arg === '--profile' || arg === '--browser-executable' || arg === '--timeout-ms') && index === args.length - 1)) throw profileError('an option value is required');
  return { profile: args[profileIndex + 1], executablePath: browserIndex < 0 ? process.env.CHATGPT_BROWSER_EXECUTABLE : args[browserIndex + 1], timeoutMs: timeoutIndex < 0 ? undefined : Number(args[timeoutIndex + 1]) };
}

function safeMessage(error) {
  switch (error?.code) {
    case 'ERR_SESSION_UNAVAILABLE': return 'session unavailable';
    case 'ERR_BROWSER_TIMEOUT': return 'browser timeout';
    case 'ERR_PROFILE_UNAVAILABLE': return 'profile unavailable';
    case 'ERR_BROWSER_EXECUTABLE_UNAVAILABLE': return 'browser unavailable';
    default: return 'generic failure';
  }
}

const commands = ['login', 'token', 'status', 'revoke'];
const [command, ...args] = process.argv.slice(2);

if (!commands.includes(command)) {
  usage();
  process.exitCode = 2;
} else {
  try {
    const result = await localAuth(command, { ...options(args), playwright: await import('playwright-core') });
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
  } catch (error) {
    console.error(safeMessage(error));
    process.exitCode = 1;
  }
}
