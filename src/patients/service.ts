import {
  linkCallToPatient,
  lockCall,
  recordLookup,
  recordVerified,
  recordVerifyFailure,
} from '../calls/repository.js';
import { pool, withTransaction } from '../db/pool.js';
import {
  dateOfBirthMatches,
  findPatient,
  insertPatient,
  listPatients,
  updatePatientFields,
  type Patient,
} from './repository.js';
import { validatePatient, type FieldError } from './validation.js';

// The service layer: validation plus persistence. The REST routes and the voice tools
// both call these functions and only translate the result for their own audience, an
// HTTP status or a short status for the agent.

// Without a limit, a caller could talk the agent into trying number after number to
// harvest names. Two wrong dates of birth end identity checks for the call.
const MAX_LOOKUPS_PER_CALL = 3;
const MAX_VERIFY_FAILURES_PER_CALL = 2;

export type WriteResult =
  | { kind: 'ok'; patient: Patient; alreadySaved?: boolean }
  | { kind: 'invalid'; errors: FieldError[] }
  | { kind: 'not_found' }
  | { kind: 'not_verified' };

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
    const call = await lockCall(client, callId, callerNumber);
    if (call.patient_id) {
      const existing = await findPatient(client, call.patient_id);
      if (existing) return { kind: 'ok', patient: existing, alreadySaved: true };
    }

    const patient = await insertPatient(client, result.value);
    await linkCallToPatient(client, callId, patient.patient_id);
    return { kind: 'ok', patient };
  });
}

export type LookupResult = { kind: 'ok'; patients: Patient[] } | { kind: 'limit' };

// Remembers the matches on the call row. Later steps refer to "match 1" or "match 2",
// so a patient ID never reaches the model.
export async function lookupPatientsForCall(callId: string, callerNumber: string | null, phone: string): Promise<LookupResult> {
  return withTransaction(async (client) => {
    const call = await lockCall(client, callId, callerNumber);
    if (call.lookup_count >= MAX_LOOKUPS_PER_CALL) return { kind: 'limit' };

    const patients = await listPatients(client, { phone_number: phone });
    await recordLookup(client, callId, patients.map((p) => p.patient_id));
    return { kind: 'ok', patients };
  });
}

export type VerifyResult =
  | { kind: 'verified'; firstName: string }
  | { kind: 'not_verified' }
  | { kind: 'locked' }
  | { kind: 'no_lookup' }
  | { kind: 'which_match' }
  | { kind: 'invalid'; errors: FieldError[] };

// A phone number is easy to know, so changing a record needs its date of birth too.
// On success the patient is bound to this call on the server.
export async function verifyIdentityForCall(
  callId: string,
  callerNumber: string | null,
  dateOfBirth: unknown,
  match: unknown,
): Promise<VerifyResult> {
  const result = validatePatient({ date_of_birth: dateOfBirth }, 'partial');
  if (!result.ok) return { kind: 'invalid', errors: result.errors };
  if (!result.value.date_of_birth) {
    return { kind: 'invalid', errors: [{ field: 'date_of_birth', message: 'This field is required.' }] };
  }
  const isoDate = result.value.date_of_birth;

  return withTransaction(async (client) => {
    const call = await lockCall(client, callId, callerNumber);
    if (call.verify_failures >= MAX_VERIFY_FAILURES_PER_CALL) return { kind: 'locked' };

    const matches = call.matched_patient_ids;
    if (matches.length === 0) return { kind: 'no_lookup' };
    if (matches.length > 1 && typeof match !== 'number') return { kind: 'which_match' };

    const patientId = matches.length === 1 ? matches[0] : matches[Number(match) - 1];
    if (!patientId) return { kind: 'which_match' };

    const patient = await findPatient(client, patientId);
    if (!patient || !(await dateOfBirthMatches(client, patientId, isoDate))) {
      await recordVerifyFailure(client, callId);
      return { kind: 'not_verified' };
    }

    await recordVerified(client, callId, patientId);
    return { kind: 'verified', firstName: patient.first_name };
  });
}

// A voice update. The target is never chosen by the model: it is the patient this call
// registered, or the one it verified. A call with neither can change nothing.
export async function updatePatientFromCall(
  callId: string,
  callerNumber: string | null,
  input: unknown,
): Promise<WriteResult> {
  const result = validatePatient(input, 'update');
  if (!result.ok) return { kind: 'invalid', errors: result.errors };
  if (!Object.keys(result.value).length) {
    return { kind: 'invalid', errors: [{ field: 'fields', message: 'No fields to update were given.' }] };
  }

  return withTransaction(async (client) => {
    const call = await lockCall(client, callId, callerNumber);
    const patientId = call.patient_id ?? call.verified_patient_id;
    if (!patientId) return { kind: 'not_verified' };

    const patient = await updatePatientFields(client, patientId, result.value);
    if (!patient) return { kind: 'not_found' };
    await linkCallToPatient(client, callId, patient.patient_id);
    return { kind: 'ok', patient };
  });
}
