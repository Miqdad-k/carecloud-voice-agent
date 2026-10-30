import type { Db } from '../db/pool.js';

export type Call = {
  vapi_call_id: string;
  patient_id: string | null;
  status: string;
  caller_number: string | null;
  transcript: string | null;
  summary: string | null;
  ended_reason: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
};

// What this call has earned so far. The model never holds a patient ID: this row is
// the only source of what the call may touch.
export type CallState = {
  patient_id: string | null;
  verified_patient_id: string | null;
  matched_patient_ids: string[];
  lookup_count: number;
  verify_failures: number;
};

// Creates the call row if needed, then locks it until the transaction ends. Two
// retries of the same save arrive one after the other, so the second one sees the
// patient the first one created.
export async function lockCall(db: Db, callId: string, callerNumber: string | null): Promise<CallState> {
  await db.query(
    `INSERT INTO calls (vapi_call_id, caller_number) VALUES ($1, $2)
     ON CONFLICT (vapi_call_id) DO NOTHING`,
    [callId, callerNumber],
  );
  const { rows } = await db.query(
    `SELECT patient_id, verified_patient_id, matched_patient_ids, lookup_count, verify_failures
     FROM calls WHERE vapi_call_id = $1 FOR UPDATE`,
    [callId],
  );
  return rows[0];
}

export async function linkCallToPatient(db: Db, callId: string, patientId: string): Promise<void> {
  // Completed now, not at the end-of-call report, so the status stays true even if
  // that report never arrives.
  await db.query(`UPDATE calls SET patient_id = $2, status = 'completed' WHERE vapi_call_id = $1`, [callId, patientId]);
}

export async function recordLookup(db: Db, callId: string, patientIds: string[]): Promise<void> {
  await db.query(
    'UPDATE calls SET matched_patient_ids = $2::uuid[], lookup_count = lookup_count + 1 WHERE vapi_call_id = $1',
    [callId, patientIds],
  );
}

export async function recordVerified(db: Db, callId: string, patientId: string): Promise<void> {
  await db.query('UPDATE calls SET verified_patient_id = $2 WHERE vapi_call_id = $1', [callId, patientId]);
}

export async function recordVerifyFailure(db: Db, callId: string): Promise<void> {
  await db.query('UPDATE calls SET verify_failures = verify_failures + 1 WHERE vapi_call_id = $1', [callId]);
}

export type CallReport = {
  callId: string;
  callerNumber: string | null;
  transcript: string | null;
  summary: string | null;
  endedReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
  costUsd: number | null;
};

// Upsert, because a call that never reached a tool has no row yet, and a retried
// report must not change the result. No patient linked means the caller never
// finished: the transcript is kept and marked incomplete.
export async function saveCallReport(db: Db, report: CallReport): Promise<void> {
  await db.query(
    `INSERT INTO calls (vapi_call_id, caller_number, transcript, summary, ended_reason, started_at, ended_at,
                        prompt_tokens, completion_tokens, cached_prompt_tokens, cost_usd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'incomplete')
     ON CONFLICT (vapi_call_id) DO UPDATE SET
       caller_number = COALESCE(calls.caller_number, EXCLUDED.caller_number),
       transcript    = EXCLUDED.transcript,
       summary       = EXCLUDED.summary,
       ended_reason  = EXCLUDED.ended_reason,
       started_at    = EXCLUDED.started_at,
       ended_at      = EXCLUDED.ended_at,
       prompt_tokens        = EXCLUDED.prompt_tokens,
       completion_tokens    = EXCLUDED.completion_tokens,
       cached_prompt_tokens = EXCLUDED.cached_prompt_tokens,
       cost_usd             = EXCLUDED.cost_usd,
       status        = CASE WHEN calls.patient_id IS NULL THEN 'incomplete' ELSE 'completed' END`,
    [
      report.callId,
      report.callerNumber,
      report.transcript,
      report.summary,
      report.endedReason,
      report.startedAt,
      report.endedAt,
      report.promptTokens,
      report.completionTokens,
      report.cachedPromptTokens,
      report.costUsd,
    ],
  );
}

export async function listCallsForPatient(db: Db, patientId: string): Promise<Call[]> {
  const { rows } = await db.query(
    `SELECT vapi_call_id, patient_id, status, caller_number, transcript, summary, ended_reason,
            started_at, ended_at, created_at
     FROM calls WHERE patient_id = $1 ORDER BY created_at DESC`,
    [patientId],
  );
  return rows;
}

export async function listAllCalls(db: Db): Promise<Call[]> {
  const { rows } = await db.query('SELECT * FROM calls ORDER BY created_at DESC');
  return rows;
}
