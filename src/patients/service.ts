import { linkCallToPatient, lockCall } from '../calls/repository.js';
import { pool, withTransaction } from '../db/pool.js';
import {
  findPatient,
  insertPatient,
  updatePatientFields,
  type Patient,
} from './repository.js';
import { validatePatient, type FieldError } from './validation.js';

// The service layer: validation plus persistence. The REST routes and the voice
// tools both call these functions and only translate the result for their own
// audience, an HTTP status or a sentence for the agent.

export type WriteResult =
  | { kind: 'ok'; patient: Patient; alreadySaved?: boolean }
  | { kind: 'invalid'; errors: FieldError[] }
  | { kind: 'not_found' };

export async function createPatient(input: unknown): Promise<WriteResult> {
  const result = validatePatient(input, 'create');
  if (!result.ok) return { kind: 'invalid', errors: result.errors };
  return { kind: 'ok', patient: await insertPatient(pool, result.value) };
}

export async function updatePatient(id: string, input: unknown): Promise<WriteResult> {
  const result = validatePatient(input, 'update');
  if (!result.ok) return { kind: 'invalid', errors: result.errors };

  // Nothing to change is not an error worth a write. Sending back the current
  // record also confirms whether the ID exists.
  const patient = Object.keys(result.value).length
    ? await updatePatientFields(pool, id, result.value)
    : await findPatient(pool, id);
  return patient ? { kind: 'ok', patient } : { kind: 'not_found' };
}

// A voice registration. Idempotent on the Vapi call ID: if this call already saved
// a patient, a retried webhook gets that patient back and no second row is created.
export async function registerPatientFromCall(
  callId: string,
  callerNumber: string | null,
  input: unknown,
): Promise<WriteResult> {
  const result = validatePatient(input, 'create');
  if (!result.ok) return { kind: 'invalid', errors: result.errors };

  return withTransaction(async (client) => {
    const existingId = await lockCall(client, callId, callerNumber);
    if (existingId) {
      const existing = await findPatient(client, existingId);
      if (existing) return { kind: 'ok', patient: existing, alreadySaved: true };
    }

    const patient = await insertPatient(client, result.value);
    await linkCallToPatient(client, callId, patient.patient_id);
    return { kind: 'ok', patient };
  });
}

// A voice update to an existing record. Linking the call means the transcript shows
// up against the patient, the same as for a new registration.
export async function updatePatientFromCall(
  callId: string,
  callerNumber: string | null,
  patientId: string,
  input: unknown,
): Promise<WriteResult> {
  const result = validatePatient(input, 'update');
  if (!result.ok) return { kind: 'invalid', errors: result.errors };
  if (!Object.keys(result.value).length) {
    return { kind: 'invalid', errors: [{ field: 'fields', message: 'No fields to update were given.' }] };
  }

  return withTransaction(async (client) => {
    await lockCall(client, callId, callerNumber);
    const patient = await updatePatientFields(client, patientId, result.value);
    if (!patient) return { kind: 'not_found' };
    await linkCallToPatient(client, callId, patient.patient_id);
    return { kind: 'ok', patient };
  });
}
