import { lockCall } from '../calls/repository.js';
import { pool, withTransaction } from '../db/pool.js';
import { findAppointmentForCall, insertAppointment, listBookedSlots } from './repository.js';
import { allSlots, matchesPreference, type Slot, type SlotPreference } from './slots.js';

const SLOTS_TO_OFFER = 3;

// A few choices are easier to take in by ear than a full calendar. If nothing fits the
// caller's preference, the earliest open slots are offered instead.
export async function findOpenSlots(preference: SlotPreference = {}): Promise<{ slots: Slot[]; preferenceMet: boolean }> {
  const booked = await listBookedSlots(pool);
  const open = allSlots().filter((s) => !booked.has(s.slot));
  const preferred = open.filter((s) => matchesPreference(s, preference));
  return { slots: (preferred.length ? preferred : open).slice(0, SLOTS_TO_OFFER), preferenceMet: preferred.length > 0 };
}

export type BookResult =
  | { kind: 'booked'; spoken: string; alreadyBooked?: boolean }
  | { kind: 'no_patient' }
  | { kind: 'invalid_slot' }
  | { kind: 'slot_taken'; alternatives: Slot[] };

// The patient comes from this call's own record, never from the model. A call can only
// book for the patient it just registered or verified, and only once.
export async function bookAppointmentForCall(callId: string, callerNumber: string | null, slot: unknown): Promise<BookResult> {
  const chosen = allSlots().find((s) => s.slot === slot);
  if (!chosen) return { kind: 'invalid_slot' };

  const result = await withTransaction<BookResult>(async (client) => {
    const call = await lockCall(client, callId, callerNumber);
    const patientId = call.patient_id ?? call.verified_patient_id;
    if (!patientId) return { kind: 'no_patient' };

    const existing = await findAppointmentForCall(client, callId);
    if (existing) {
      const spoken = allSlots().find((s) => s.slot === `${existing.date}T${existing.time}`)?.spoken ?? chosen.spoken;
      return { kind: 'booked', spoken, alreadyBooked: true };
    }

    const booked = await insertAppointment(client, patientId, callId, chosen.slot);
    return booked ? { kind: 'booked', spoken: chosen.spoken } : { kind: 'slot_taken', alternatives: [] };
  });

  // Read after the transaction, so the alternatives reflect the slot that was just lost.
  return result.kind === 'slot_taken' ? { kind: 'slot_taken', alternatives: (await findOpenSlots()).slots } : result;
}
