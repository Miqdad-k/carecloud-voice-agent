import { requireEnv } from '../config.js';
import { ASSISTANT_NAME, buildAssistant } from './assistant-config.js';

// Creates or updates the Vapi assistant from code, and makes sure a phone number points
// at it. Safe to run again: it finds the existing assistant by name and number by
// assistant ID. Run with `npm run vapi:sync`.

const API = 'https://api.vapi.ai';
const apiKey = requireEnv('VAPI_API_KEY');

async function vapi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Vapi ${method} ${path} failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

type Assistant = { id: string; name?: string };
type PhoneNumber = { id: string; number?: string; sipUri?: string; assistantId?: string };

const assistantConfig = buildAssistant(requireEnv('PUBLIC_BASE_URL'), requireEnv('VAPI_WEBHOOK_SECRET'));

const existing = (await vapi<Assistant[]>('GET', '/assistant')).find((a) => a.name === ASSISTANT_NAME);
const assistant = existing
  ? await vapi<Assistant>('PATCH', `/assistant/${existing.id}`, assistantConfig)
  : await vapi<Assistant>('POST', '/assistant', assistantConfig);
console.log(`${existing ? 'Updated' : 'Created'} assistant ${assistant.id}`);

// Vapi requires an area code, and any one of them can be out of stock.
const AREA_CODES = ['415', '628', '206', '503', '512', '312'];

async function createNumber(): Promise<PhoneNumber> {
  let lastError: unknown;
  for (const numberDesiredAreaCode of AREA_CODES) {
    try {
      return await vapi<PhoneNumber>('POST', '/phone-number', {
        provider: 'vapi',
        name: ASSISTANT_NAME,
        assistantId: assistant.id,
        numberDesiredAreaCode,
      });
    } catch (err) {
      lastError = err;
      console.log(`No number from area code ${numberDesiredAreaCode}: ${(err as Error).message}`);
    }
  }
  throw lastError;
}

const numbers = await vapi<PhoneNumber[]>('GET', '/phone-number');
const phone = numbers.find((n) => n.assistantId === assistant.id) ?? (await createNumber());

console.log(`Phone number: ${phone.number ?? '(still activating, check the Vapi dashboard)'}`);
