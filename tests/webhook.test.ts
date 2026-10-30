import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { TOOL_TIMEOUT_MS, withTimeout } from '../src/vapi/tools.js';
import { endOfCallPayload, SECRET_HEADER, toolCallsPayload, validPatient } from './helpers.js';

const app = buildApp({ logger: false });

beforeAll(async () => {
  await migrate();
  await app.ready();
});

beforeEach(async () => {
  await pool.query('TRUNCATE appointments, calls, patients');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function callTool(name: string, args: Record<string, unknown> | string, callId = randomUUID()) {
  const { toolCallId, body } = toolCallsPayload(name, args, callId);
  const res = await app.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload: body });
  // Vapi ignores any reply that is not a 200, even for a failed tool.
  expect(res.statusCode).toBe(200);
  const { results } = res.json();
  expect(results).toHaveLength(1);
  expect(results[0].toolCallId).toBe(toolCallId);
  expect(results[0].name).toBe(name);
  expect(typeof results[0].result).toBe('string');
  expect(results[0].result).not.toContain('\n');
  return JSON.parse(results[0].result);
}

const countPatients = async () => (await pool.query('SELECT count(*)::int AS n FROM patients')).rows[0].n;
const idOf = async (firstName: string) =>
  (await pool.query('SELECT patient_id FROM patients WHERE first_name = $1', [firstName])).rows[0].patient_id;
const send = (payload: object) => app.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload });
const confirmed = { ...validPatient, caller_confirmed: true };

describe('webhook authentication and malformed input', () => {
  const { body } = toolCallsPayload('check_fields', { city: 'Austin' });

  it('rejects a missing or wrong secret with 401', async () => {
    const missing = await app.inject({ method: 'POST', url: '/vapi/webhook', payload: body });
    expect(missing.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'POST', url: '/vapi/webhook', headers: { 'x-vapi-secret': 'nope' }, payload: body });
    expect(wrong.statusCode).toBe(401);
  });

  it('rejects a body with no message', async () => {
    const res = await send({});
    expect(res.statusCode).toBe(400);
  });

  it('acknowledges informational messages with 200', async () => {
    const res = await send({ message: { type: 'status-update', status: 'in-progress', call: { id: 'x' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it.each([
    ['no tool list', { type: 'tool-calls', call: { id: 'x' } }],
    ['a tool list that is not a list', { type: 'tool-calls', call: { id: 'x' }, toolCallList: 'nope' }],
    ['an entry with no ID', { type: 'tool-calls', call: { id: 'x' }, toolCallList: [{ function: { name: 'check_fields' } }] }],
  ])('survives %s', async (_label, message) => {
    const res = await send({ message });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
  });

  it('answers failed for an entry with no function, and for arguments that are not an object', async () => {
    const res = await send({
      message: {
        type: 'tool-calls',
        call: { id: 'x' },
        toolCallList: [
          { id: 'a' },
          { id: 'b', function: { name: 'check_fields', arguments: '[1, 2]' } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { result: string }) => JSON.parse(r.result).status)).toEqual(['failed', 'failed']);
  });

  it('runs nothing when the call ID is missing, since nothing could be bound to it', async () => {
    const res = await send({
      message: {
        type: 'tool-calls',
        toolCallList: [{ id: 'a', function: { name: 'save_patient', arguments: confirmed } }],
      },
    });
    expect(JSON.parse(res.json().results[0].result).status).toBe('failed');
    expect(await countPatients()).toBe(0);
  });

  it('accepts an end-of-call report with no call ID without storing it', async () => {
    const res = await send({ message: { type: 'end-of-call-report', endedReason: 'customer-ended-call' } });
    expect(res.statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM calls')).rows[0].n).toBe(0);
  });

  it('rejects a report too large for the webhook limit, but takes one larger than the API limit', async () => {
    const large = endOfCallPayload(randomUUID(), 'customer-ended-call', 'x'.repeat(200 * 1024));
    expect((await send(large)).statusCode).toBe(200);
    const huge = endOfCallPayload(randomUUID(), 'customer-ended-call', 'x'.repeat(6 * 1024 * 1024));
    expect((await send(huge)).statusCode).toBe(400);
  });
});

describe('tool timeout', () => {
  it('sits inside the 15 second limit set on Vapi', () => {
    expect(TOOL_TIMEOUT_MS).toBeLessThan(15000);
  });

  it('rejects slow work and passes fast work through', async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow('Timed out');
    await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done');
  });
});

describe('save_patient', () => {
  it('saves a confirmed registration and links the call', async () => {
    const callId = randomUUID();
    const outcome = await callTool('save_patient', confirmed, callId);
    expect(outcome).toEqual({ status: 'saved', first_name: 'Jane' });

    const patientId = await idOf('Jane');
    const api = await app.inject({ method: 'GET', url: `/patients/${patientId}` });
    expect(api.json().data.last_name).toBe("O'Neil-Doe");

    const { rows } = await pool.query('SELECT patient_id, caller_number FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows[0]).toEqual({ patient_id: patientId, caller_number: '+12025550147' });
  });

  it('accepts arguments sent as a JSON string as well as an object', async () => {
    const outcome = await callTool('save_patient', JSON.stringify(confirmed));
    expect(outcome.status).toBe('saved');
  });

  it.each([[{ ...validPatient }], [{ ...validPatient, caller_confirmed: false }], [{ ...validPatient, caller_confirmed: 'true' }]])(
    'refuses without a real confirmation',
    async (args) => {
      const outcome = await callTool('save_patient', args);
      expect(outcome.status).toBe('not_confirmed');
      expect(await countPatients()).toBe(0);
    },
  );

  it('is idempotent on the call ID: a retry creates no second patient', async () => {
    const callId = randomUUID();
    await callTool('save_patient', confirmed, callId);
    const retry = await callTool('save_patient', confirmed, callId);
    expect(retry.status).toBe('already_saved');
    expect(await countPatients()).toBe(1);
  });

  it('stays idempotent when three retries arrive at the same moment', async () => {
    const callId = randomUUID();
    const outcomes = await Promise.all([
      callTool('save_patient', confirmed, callId),
      callTool('save_patient', confirmed, callId),
      callTool('save_patient', confirmed, callId),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['already_saved', 'already_saved', 'saved']);
    expect(await countPatients()).toBe(1);
  });

  it('allows a second patient with the same phone from a different call', async () => {
    await callTool('save_patient', confirmed);
    const child = await callTool('save_patient', { ...confirmed, first_name: 'Junior', date_of_birth: '01/01/2015' });
    expect(child.status).toBe('saved');
    expect(await countPatients()).toBe(2);
  });

  it('returns the specific invalid fields and saves nothing', async () => {
    const outcome = await callTool('save_patient', { ...confirmed, date_of_birth: '12/31/2999', zip_code: '1' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors.map((e: { field: string }) => e.field).sort()).toEqual(['date_of_birth', 'zip_code']);
    expect(await countPatients()).toBe(0);
  });

  it('reports a failed database write as a status, with a 200, then works on retry', async () => {
    const callId = randomUUID();
    await pool.query('ALTER TABLE patients RENAME TO patients_hidden');
    let outcome;
    try {
      outcome = await callTool('save_patient', confirmed, callId);
    } finally {
      await pool.query('ALTER TABLE patients_hidden RENAME TO patients');
    }
    expect(outcome).toEqual({ status: 'failed' });
    expect(await countPatients()).toBe(0);

    const retry = await callTool('save_patient', confirmed, callId);
    expect(retry.status).toBe('saved');
    expect(await countPatients()).toBe(1);
  });
});

describe('lookup_patient_by_phone', () => {
  it('finds no match for a new number', async () => {
    expect((await callTool('lookup_patient_by_phone', { phone_number: '202-555-0199' })).status).toBe('no_match');
  });

  it('returns only what the duplicate question needs, for every patient on that number', async () => {
    await callTool('save_patient', confirmed);
    await callTool('save_patient', { ...confirmed, first_name: 'Junior' });
    const outcome = await callTool('lookup_patient_by_phone', { phone_number: '+1 (202) 555-0147' });
    expect(outcome.status).toBe('match_found');
    expect(outcome.matches).toHaveLength(2);
    expect(Object.keys(outcome.matches[0]).sort()).toEqual(['first_name', 'last_name', 'match']);
  });

  it('rejects a short number with a specific error', async () => {
    const outcome = await callTool('lookup_patient_by_phone', { phone_number: '555' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors[0].field).toBe('phone_number');
    expect((await callTool('lookup_patient_by_phone', {})).status).toBe('invalid');
  });

  it('does not find a soft-deleted patient', async () => {
    await callTool('save_patient', confirmed);
    await app.inject({ method: 'DELETE', url: `/patients/${await idOf('Jane')}` });
    expect((await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number })).status).toBe('no_match');
  });
});

describe('check_fields', () => {
  it('passes good values and names bad ones', async () => {
    expect((await callTool('check_fields', { date_of_birth: '03/15/1985' })).status).toBe('valid');
    const outcome = await callTool('check_fields', { date_of_birth: '12/31/2999' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors).toEqual([{ field: 'date_of_birth', message: 'Date of birth cannot be in the future.' }]);
  });
});

describe('update_patient', () => {
  it('changes a record the caller verified, and links the call', async () => {
    await callTool('save_patient', confirmed);
    const callId = randomUUID();
    await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number }, callId);
    expect(await callTool('verify_identity', { date_of_birth: validPatient.date_of_birth }, callId)).toEqual({ status: 'verified', first_name: 'Jane' });

    const outcome = await callTool('update_patient', { caller_confirmed: true, city: 'Austin', state: 'TX' }, callId);
    expect(outcome.status).toBe('updated');

    const patientId = await idOf('Jane');
    const { data } = (await app.inject({ method: 'GET', url: `/patients/${patientId}` })).json();
    expect(data.city).toBe('Austin');
    expect(data.first_name).toBe('Jane');

    const { rows } = await pool.query('SELECT patient_id, status FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows[0]).toEqual({ patient_id: patientId, status: 'completed' });
  });

  it('lets a call correct the patient it just registered, with no separate verification', async () => {
    const callId = randomUUID();
    await callTool('save_patient', confirmed, callId);
    expect((await callTool('update_patient', { caller_confirmed: true, last_name: 'Davis' }, callId)).status).toBe('updated');
    const { rows } = await pool.query('SELECT last_name FROM patients');
    expect(rows).toEqual([{ last_name: 'Davis' }]);
  });

  it('refuses without confirmation, and with bad values or no fields', async () => {
    const callId = randomUUID();
    await callTool('save_patient', confirmed, callId);
    expect((await callTool('update_patient', { city: 'Austin' }, callId)).status).toBe('not_confirmed');
    expect((await callTool('update_patient', { caller_confirmed: true, zip_code: '1' }, callId)).status).toBe('invalid');
    expect((await callTool('update_patient', { caller_confirmed: true }, callId)).status).toBe('invalid');
  });
});

describe('verify_identity', () => {
  it('asks which record when several share a phone, then verifies the right one', async () => {
    await callTool('save_patient', confirmed);
    await callTool('save_patient', { ...confirmed, first_name: 'Junior', date_of_birth: '01/01/2015' });

    const callId = randomUUID();
    const { matches } = await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number }, callId);
    const junior = matches.find((m: { first_name: string }) => m.first_name === 'Junior').match;

    expect((await callTool('verify_identity', { date_of_birth: '01/01/2015' }, callId)).status).toBe('which_match');
    expect(await callTool('verify_identity', { date_of_birth: '01/01/2015', match: junior }, callId)).toEqual({ status: 'verified', first_name: 'Junior' });
  });

  it('needs a lookup first, and a real date', async () => {
    expect((await callTool('verify_identity', { date_of_birth: '03/15/1985' })).status).toBe('no_lookup');
    expect((await callTool('verify_identity', {})).status).toBe('invalid');
  });
});

describe('unknown tools', () => {
  it('returns a failure the agent can act on', async () => {
    expect((await callTool('delete_all_patients', {})).status).toBe('failed');
  });

  it('survives malformed argument JSON', async () => {
    expect((await callTool('save_patient', '{ broken')).status).toBe('failed');
  });
});

describe('end-of-call-report', () => {
  it('stores the transcript as completed against the saved patient, with token counts', async () => {
    const callId = randomUUID();
    await callTool('save_patient', confirmed, callId);

    const res = await send(endOfCallPayload(callId, 'assistant-ended-call', 'AI: Hello.\nUser: Hi.'));
    expect(res.statusCode).toBe(200);

    const { json } = await app.inject({ method: 'GET', url: `/patients/${await idOf('Jane')}/calls` });
    const [call] = json().data;
    expect(call.status).toBe('completed');
    expect(call.transcript).toContain('User: Hi.');
    expect(call.ended_reason).toBe('assistant-ended-call');
    expect(call.started_at).toBe('2026-10-30T10:00:00.000Z');

    const { rows } = await pool.query('SELECT prompt_tokens, cached_prompt_tokens, completion_tokens, cost_usd FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows[0]).toEqual({ prompt_tokens: 42000, cached_prompt_tokens: 30000, completion_tokens: 900, cost_usd: '0.2100' });
  });

  it('keeps a dropped call as incomplete, with no patient record', async () => {
    const callId = randomUUID();
    await send(endOfCallPayload(callId, 'customer-ended-call', 'AI: Hello.\nUser: My name is'));

    const { rows } = await pool.query('SELECT status, patient_id, transcript FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows[0].status).toBe('incomplete');
    expect(rows[0].patient_id).toBeNull();
    expect(rows[0].transcript).toContain('My name is');
    expect(await countPatients()).toBe(0);

    const dashboard = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(dashboard.body).toContain('My name is');
  });

  it('is safe to receive twice', async () => {
    const callId = randomUUID();
    await callTool('save_patient', confirmed, callId);
    const report = endOfCallPayload(callId, 'assistant-ended-call', 'AI: Hello.');
    await send(report);
    expect((await send(report)).statusCode).toBe(200);

    const { rows } = await pool.query('SELECT status FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows).toEqual([{ status: 'completed' }]);
  });

  it('copes with a report missing nearly everything', async () => {
    const res = await send({ message: { type: 'end-of-call-report', call: { id: randomUUID() }, costs: 'nonsense' } });
    expect(res.statusCode).toBe(200);
  });
});
