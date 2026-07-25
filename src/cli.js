#!/usr/bin/env node
import { loadConfig, status, sync, verify } from './collector.js';

const [command, ...args] = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1] || './config.yaml';
const interventionRequired = new Set(['no-credential', 'credential-malformed', 'credential-apparently-expired', 'credential-rejected-401', 'credential-rejected-403', 'upstream-endpoint-changed', 'auth']);

if (!['sync', 'verify', 'status'].includes(command)) {
  console.error('usage: chatgpt-markdown-collector <sync|verify|status> [--config file]');
  process.exitCode = 2;
} else try {
  const config = await loadConfig(configPath);
  const result = command === 'sync' ? await sync(config) : command === 'verify' ? await verify(config) : await status(config);
  console.log(JSON.stringify(result, null, 2));
  const classification = result.auth?.classification || result.classification;
  if (interventionRequired.has(classification)) process.exitCode = 3;
  else if (result.status === 'failed' || result.status === 'invalid' || result.auth?.ready === false) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
