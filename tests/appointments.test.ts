import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allSlots, matchesPreference } from '../src/appointments/slots.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { SECRET_HEADER, toolCallsPayload, validPatient } from './helpers.js';

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

async function callTool(name: string, args: Record<string, unknown>, callId = randomUUID()) {
  const { body } = toolCallsPayload(name, args, callId);
  const res = await app.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload: body });
  return JSON.parse(res.json().results[0].result);
}

async function registerOnCall(callId: string, firstName = 'Jane') {
  await callTool('save_patient', { ...validPatient, first_name: firstName, caller_confirmed: true }, callId);
}

describe('the mock calendar', () => {
  // Friday 2026-10-30, so tomorrow is a Saturday.
  const friday = new Date('2026-10-30T12:00:00Z');
  const slots = allSlots(friday);

  it('skips weekends and starts on the next business day', () => {
    expect(slots[0]).toEqual({ slot: '2026-11-02T09:00', spoken: 'Monday, November 2 at 9:00 AM' });
    expect(slots.every((s) => !/Saturday|Sunday/.test(s.spoken))).toBe(true);
  });

  it('says afternoon times in 12-hour form', () => {
    expect(slots[2].spoken).toBe('Monday, November 2 at 1:00 PM');
  });

  it('filters by date and time of day', () => {
    const tuesdayAfternoon = slots.filter((s) => matchesPreference(s, { date: '11/03/2026', time_of_day: 'afternoon' }));
    expect(tuesdayAfternoon.map((s) => s.slot)).toEqual(['2026-11-03T13:00', '2026-11-03T15:30']);
  });

  it('filters by an exact date, and reaches about four weeks out', () => {
    expect(slots.filter((s) => matchesPreference(s, { date: '11/19/2026' }))).toHaveLength(4);
    expect(slots.filter((s) => matchesPreference(s, { date: '10/31/2026' }))).toEqual([]);
    expect(slots.filter((s) => matchesPreference(s, { date: 'tomorrow' }))).toEqual([]);
  });
});

describe('get_appointment_slots', () => {
  it('offers three, and falls back to the earliest if nothing fits', async () => {
    const outcome = await callTool('get_appointment_slots', {});
    expect(outcome.slots).toHaveLength(3);
    expect(outcome.next).toContain('Do not end the call');

    const nonsense = await callTool('get_appointment_slots', { date: 'someday' });
    expect(nonsense.slots).toEqual(outcome.slots);
    expect(outcome.requested_time_unavailable).toBeUndefined();
    expect(nonsense.requested_time_unavailable).toBe(true);
  });

  it('no longer offers a slot once it is booked', async () => {
    const callId = randomUUID();
    await registerOnCall(callId);
    const { slots } = await callTool('get_appointment_slots', {});
    await callTool('book_appointment', { slot: slots[0].slot, caller_confirmed: true }, callId);
    const after = await callTool('get_appointment_slots', {});
    expect(after.slots.map((s: { slot: string }) => s.slot)).not.toContain(slots[0].slot);
  });
});

describe('book_appointment', () => {
  const firstSlot = () => allSlots()[0];

  it('books for the patient on this call, and shows up on the API and dashboard', async () => {
    const callId = randomUUID();
    await registerOnCall(callId);
    const outcome = await callTool('book_appointment', { slot: firstSlot().slot, caller_confirmed: true }, callId);
    expect(outcome).toEqual({ status: 'booked', spoken: firstSlot().spoken });

    const { rows } = await pool.query('SELECT patient_id FROM patients');
    const api = await app.inject({ method: 'GET', url: `/patients/${rows[0].patient_id}/appointments` });
    expect(api.json().data).toHaveLength(1);
    expect(api.json().data[0].time).toBe('09:00');

    const dashboard = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(dashboard.body).toContain('at 09:00 (mock)');
  });

  it('refuses a call with no registered or verified patient', async () => {
    const outcome = await callTool('book_appointment', { slot: firstSlot().slot, caller_confirmed: true });
    expect(outcome.status).toBe('no_patient');
  });

  it('refuses without confirmation, and any slot not on the calendar', async () => {
    const callId = randomUUID();
    await registerOnCall(callId);
    expect((await callTool('book_appointment', { slot: firstSlot().slot }, callId)).status).toBe('not_confirmed');
    for (const slot of ['2020-01-01T09:00', 'tomorrow', firstSlot().slot.replace('09:00', '03:00'), 42]) {
      expect((await callTool('book_appointment', { slot, caller_confirmed: true }, callId)).status).toBe('invalid_slot');
    }
  });

  it('is idempotent per call: a retry returns the same booking', async () => {
    const callId = randomUUID();
    await registerOnCall(callId);
    const args = { slot: firstSlot().slot, caller_confirmed: true };
    await callTool('book_appointment', args, callId);
    expect((await callTool('book_appointment', args, callId)).status).toBe('already_booked');
    expect((await pool.query('SELECT count(*)::int AS n FROM appointments')).rows[0].n).toBe(1);
  });

  it('gives a slot to exactly one of two callers racing for it, and offers the loser others', async () => {
    const [callA, callB] = [randomUUID(), randomUUID()];
    await registerOnCall(callA, 'Ann');
    await registerOnCall(callB, 'Bob');
    const args = { slot: firstSlot().slot, caller_confirmed: true };

    const outcomes = await Promise.all([callTool('book_appointment', args, callA), callTool('book_appointment', args, callB)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['booked', 'slot_taken']);

    const loser = outcomes.find((o) => o.status === 'slot_taken');
    expect(loser.slots).toHaveLength(3);
    expect(loser.slots.map((s: { slot: string }) => s.slot)).not.toContain(args.slot);
  });

  it('lets a verified returning patient book', async () => {
    const callId = randomUUID();
    await registerOnCall(randomUUID());
    await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number }, callId);
    await callTool('verify_identity', { date_of_birth: validPatient.date_of_birth }, callId);
    expect((await callTool('book_appointment', { slot: firstSlot().slot, caller_confirmed: true }, callId)).status).toBe('booked');
  });
});
