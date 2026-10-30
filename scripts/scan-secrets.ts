import { execFileSync } from 'node:child_process';
import { buildAssistant } from '../src/agent/assistant-config.js';

// Run before any push: `npm run scan:secrets`. Searches every commit on every branch, plus
// the tracked files as they stand. It reports where something matched, never the value.

const PATTERNS: [string, RegExp][] = [
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI or Anthropic key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['Railway or Vapi key assigned a value', /\b(VAPI_API_KEY|RAILWAY_TOKEN|VAPI_WEBHOOK_SECRET)\s*[=:]\s*['"]?(?!test-secret\b)[A-Za-z0-9_-]{8,}/],
  ['Vapi secret header with a value', /x-vapi-secret['"]?\s*:\s*['"][A-Za-z0-9_-]{16,}/i],
  ['Database URL with a real password', /postgres(ql)?:\/\/[^:\s]+:(?!postgres@)[^@\s$<]+@/],
];

// Files that must never be in the history, whatever they contain.
const FORBIDDEN_FILE = /(^|\/)(\.env(\.(?!example)[^/]*)?|.*\.pdf|.*\.pem|.*\.key)$/;

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
}

const findings: string[] = [];

function scan(source: string, text: string) {
  text.split('\n').forEach((line, index) => {
    for (const [label, pattern] of PATTERNS) {
      if (pattern.test(line)) findings.push(`${label}: ${source}, line ${index + 1}`);
    }
  });
}

const commits = git('rev-list', '--all').trim().split('\n').filter(Boolean);
for (const commit of commits) {
  scan(`commit ${commit.slice(0, 7)}`, git('show', '--format=%B', '--no-color', commit));
}

const everyFileEver = new Set(git('log', '--all', '--name-only', '--format=').split('\n').filter(Boolean));
for (const file of everyFileEver) {
  if (FORBIDDEN_FILE.test(file)) findings.push(`Forbidden file in history: ${file}`);
}

const tracked = git('ls-files').trim().split('\n');
for (const file of tracked) {
  scan(file, git('show', `HEAD:${file}`));
}

// The prompt and tool definitions are public by design, so neither may hold the secret.
const marker = 'SCAN-MARKER-SECRET-VALUE';
const { model } = buildAssistant('https://example.test', marker);
if (JSON.stringify(model).includes(marker)) findings.push('Webhook secret reaches the model context');

const authors = [...new Set(git('log', '--all', '--format=%an <%ae>').trim().split('\n'))];

console.log(`Scanned ${commits.length} commits and ${tracked.length} tracked files.`);
console.log(`Commit authors, which become public on push: ${authors.join(', ')}`);

if (findings.length) {
  console.log(`\nFOUND ${findings.length} possible secrets:`);
  for (const finding of findings) console.log(`  ${finding}`);
  process.exit(1);
}
console.log('No secrets found.');
