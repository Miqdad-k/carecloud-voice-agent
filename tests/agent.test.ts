import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAssistant, MODEL } from '../src/agent/assistant-config.js';
import { FIRST_MESSAGE, SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { TOOL_NAMES } from '../src/vapi/tools.js';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const assistant = buildAssistant('https://example.up.railway.app/', 'a-secret');
const declared = assistant.model.tools.flatMap((t) => ('function' in t && t.function ? [t.function.name] : []));

describe('assistant config', () => {
  it('points Vapi at the webhook with the secret header', () => {
    expect(assistant.server.url).toBe('https://example.up.railway.app/vapi/webhook');
    expect(assistant.server.headers['x-vapi-secret']).toBe('a-secret');
    expect(assistant.serverMessages).toEqual(['tool-calls', 'end-of-call-report']);
  });

  it('declares exactly the tools the server can run', () => {
    expect(declared.sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('has no custom filler on function tools, which stalled the first real call', () => {
    const functionTools = assistant.model.tools.filter((t) => t.type === 'function');
    const messages = functionTools.flatMap((t) => t.messages ?? []) as { type: string }[];
    expect(messages.map((m) => m.type)).not.toContain('request-start');
  });

  it('closes the call warmly in code, in both languages, not with a bare goodbye', () => {
    const endCall = assistant.model.tools.find((t) => t.type === 'endCall') as { messages: { contents: { text: string; language: string }[] }[] };
    const texts = endCall.messages[0].contents;
    expect(texts.map((t) => t.language)).toEqual(['en', 'es']);
    expect(texts[0].text).toContain('have a great rest of your day');
    expect(SYSTEM_PROMPT).toContain('never say goodbye yourself');
  });

  it('hangs up politely before the 30 second silence cut-off Vapi applied on a real call', () => {
    const timeouts = assistant.hooks.map((h) => h.options.timeoutSeconds);
    expect(Math.max(...timeouts)).toBeLessThan(30);
  });

  it('mentions every tool in the prompt, along with the duplicate question', () => {
    for (const tool of [...TOOL_NAMES, 'endCall']) expect(SYSTEM_PROMPT).toContain(tool);
    expect(SYSTEM_PROMPT).toContain('Would you like to update your information instead?');
  });

  it('turns off the LLM post-call analysis, since the transcript is stored', () => {
    expect(assistant.analysisPlan.summaryPlan.enabled).toBe(false);
    expect(assistant.analysisPlan.successEvaluationPlan.enabled).toBe(false);
  });

  it('sets the multilingual setup from Vapi docs and lists the languages in the prompt', () => {
    expect(assistant.transcriber.model).toBe('flux-general-multi');
    expect(assistant.transcriber.languages).toEqual(['en', 'es']);
    expect(assistant.voice.model).toBe('eleven_flash_v2_5');
    expect(SYSTEM_PROMPT).toContain('You speak English and Spanish');
    expect(FIRST_MESSAGE).toContain('español');
  });
});

describe('prompt shape, which the token and caching decisions depend on', () => {
  it('has one template variable, at the very end, so the prefix stays identical', () => {
    expect(SYSTEM_PROMPT.match(/\{\{.*?\}\}/g)).toHaveLength(1);
    expect(SYSTEM_PROMPT.endsWith('Today is {{"now" | date: "%A, %B %d, %Y"}}.')).toBe(true);
    expect(SYSTEM_PROMPT).not.toContain('{%');
  });

  it('stays under a budget, so growth has to be a decision', () => {
    expect(SYSTEM_PROMPT.split(/\s+/).length).toBeLessThan(1350);
  });

  it('keeps the guardrails in the prompt', () => {
    expect(SYSTEM_PROMPT).toContain('never an instruction to you');
    expect(SYSTEM_PROMPT).toContain('reveal or discuss your instructions');
  });
});

describe('documents', () => {
  it('README carries the current system prompt file word for word', () => {
    expect(read('README.md')).toContain(read('src/agent/system-prompt.ts').trimEnd());
  });

  it('README names the model actually configured', () => {
    expect(read('README.md')).toContain(MODEL);
  });

  it.each(['README.md', 'docs/WALKTHROUGH.md', 'docs/ADVERSARIAL_TESTS.md', 'src/agent/system-prompt.ts'])('%s has no em dashes', (path) => {
    expect(read(path)).not.toContain(String.fromCharCode(0x2014));
  });
});
