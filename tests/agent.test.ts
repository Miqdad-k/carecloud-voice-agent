import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/agent/assistant-config.js';
import { SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { runTool } from '../src/vapi/tools.js';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const assistant = buildAssistant('https://example.up.railway.app/', 'a-secret');

describe('assistant config', () => {
  it('points Vapi at the webhook with the secret header', () => {
    expect(assistant.server.url).toBe('https://example.up.railway.app/vapi/webhook');
    expect(assistant.server.headers['x-vapi-secret']).toBe('a-secret');
    expect(assistant.serverMessages).toEqual(['tool-calls', 'end-of-call-report']);
  });

  it('only declares tools the server can actually run', async () => {
    const log = { info: () => {}, error: () => {} };
    const names = assistant.model.tools.flatMap((t) => ('function' in t && t.function ? [t.function.name] : []));
    expect(names).toEqual(['lookup_patient_by_phone', 'check_fields', 'save_patient', 'update_patient']);

    for (const name of names) {
      // Empty arguments get a validation or confirmation answer, never "not available".
      const outcome = await runTool(name, {}, { callId: 'config-check', callerNumber: null }, log);
      expect(outcome.message).not.toBe('That action is not available.');
    }
  });

  it('mentions every tool in the prompt, along with the update question', () => {
    for (const tool of ['lookup_patient_by_phone', 'check_fields', 'save_patient', 'update_patient', 'endCall']) {
      expect(SYSTEM_PROMPT).toContain(tool);
    }
    expect(SYSTEM_PROMPT).toContain('Would you like to update your information instead?');
  });

  it('uses only the one Vapi template variable it means to', () => {
    expect(SYSTEM_PROMPT.match(/\{\{.*?\}\}/g)).toEqual(['{{date}}']);
    expect(SYSTEM_PROMPT).not.toContain('{%');
  });
});

describe('documents', () => {
  it('README carries the current system prompt file word for word', () => {
    expect(read('README.md')).toContain(read('src/agent/system-prompt.ts').trimEnd());
  });

  it.each(['README.md', 'docs/WALKTHROUGH.md', 'src/agent/system-prompt.ts'])('%s has no em dashes', (path) => {
    expect(read(path)).not.toContain(String.fromCharCode(0x2014));
  });
});
