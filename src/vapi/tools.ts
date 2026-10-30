import { bookAppointmentForCall, findOpenSlots } from '../appointments/service.js';
import {
  lookupPatientsForCall,
  registerPatientFromCall,
  updatePatientFromCall,
  verifyIdentityForCall,
  type WriteResult,
} from '../patients/service.js';
import { validateFilters, validatePatient } from '../patients/validation.js';

// What each tool does when the agent calls it. Every outcome is a small object with a
// status, kept short because it goes back into the model's context on every later turn.
// The system prompt says what to tell the caller for each status.
//
// Treat everything returned here as public. Prompt injection can make a model repeat
// anything it was given, so these results never contain a patient ID, another patient's
// details, or anything internal. The defense is having nothing to leak.

export type ToolContext = { callId: string; callerNumber: string | null };
type ToolOutcome = { status: string; [key: string]: unknown };
type Args = Record<string, unknown>;
type Logger = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

// Under Vapi's 15 second webhook timeout (see assistant-config.ts), so the agent gets a
// status it can speak rather than a timeout it can't. If a save is slow and still
// commits after this, the retry is safe because the save is idempotent.
export const TOOL_TIMEOUT_MS = 8000;

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function lookupPatientByPhone(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = validateFilters({ phone_number: String(args.phone_number ?? '') });
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  if (!parsed.filters.phone_number) {
    return { status: 'invalid', errors: [{ field: 'phone_number', message: 'Phone number is required.' }] };
  }

  const result = await lookupPatientsForCall(ctx.callId, ctx.callerNumber, parsed.filters.phone_number);
  if (result.kind === 'limit') return { status: 'lookup_limit' };
  if (result.patients.length === 0) return { status: 'no_match' };
  return {
    status: 'match_found',
    // The names the duplicate question needs, and nothing else.
    matches: result.patients.map((p, i) => ({ match: i + 1, first_name: p.first_name, last_name: p.last_name })),
  };
}

// Lets the agent check an answer the moment the caller gives it, using the same rules
// as the save, instead of finding out after the read-back.
function checkFields(args: Args): ToolOutcome {
  const result = validatePatient(args, 'partial');
  return result.ok ? { status: 'valid' } : { status: 'invalid', errors: result.errors };
}

function describeWrite(result: WriteResult, successStatus: string): ToolOutcome {
  if (result.kind === 'invalid') return { status: 'invalid', errors: result.errors };
  if (result.kind === 'not_found' || result.kind === 'not_verified') return { status: 'not_verified' };
  return { status: result.alreadySaved ? 'already_saved' : successStatus, first_name: result.patient.first_name };
}

const NOT_CONFIRMED: ToolOutcome = { status: 'not_confirmed' };

// caller_confirmed is not a patient field, so it is removed before validation. Only
// the boolean true counts: not "true", not a missing value.
async function savePatient(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const { caller_confirmed, ...fields } = args;
  if (caller_confirmed !== true) return NOT_CONFIRMED;
  return describeWrite(await registerPatientFromCall(ctx.callId, ctx.callerNumber, fields), 'saved');
}

async function verifyIdentity(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const result = await verifyIdentityForCall(ctx.callId, ctx.callerNumber, args.date_of_birth, args.match);
  if (result.kind === 'invalid') return { status: 'invalid', errors: result.errors };
  if (result.kind === 'verified') return { status: 'verified', first_name: result.firstName };
  return { status: result.kind };
}

// A patient_id sent by the model counts as an unknown field and is rejected. The target
// always comes from the call's own record.
async function updatePatientTool(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const { caller_confirmed, ...fields } = args;
  if (caller_confirmed !== true) return NOT_CONFIRMED;
  return describeWrite(await updatePatientFromCall(ctx.callId, ctx.callerNumber, fields), 'updated');
}

async function getAppointmentSlots(args: Args): Promise<ToolOutcome> {
  const { slots, preferenceMet } = await findOpenSlots({ date: args.date, time_of_day: args.time_of_day });
  return { status: 'ok', slots, ...(!preferenceMet && { requested_time_unavailable: true }) };
}

async function bookAppointment(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  if (args.caller_confirmed !== true) return NOT_CONFIRMED;
  const result = await bookAppointmentForCall(ctx.callId, ctx.callerNumber, args.slot);
  if (result.kind === 'booked') return { status: result.alreadyBooked ? 'already_booked' : 'booked', spoken: result.spoken };
  if (result.kind === 'slot_taken') return { status: 'slot_taken', slots: result.alternatives };
  return { status: result.kind };
}

const TOOLS: Record<string, (args: Args, ctx: ToolContext) => ToolOutcome | Promise<ToolOutcome>> = {
  lookup_patient_by_phone: lookupPatientByPhone,
  check_fields: checkFields,
  save_patient: savePatient,
  verify_identity: verifyIdentity,
  update_patient: updatePatientTool,
  get_appointment_slots: getAppointmentSlots,
  book_appointment: bookAppointment,
};

export const TOOL_NAMES = Object.keys(TOOLS);

// Only these write the record the caller confirmed, so only these log its contents.
const LOGS_PAYLOAD = new Set(['save_patient', 'update_patient']);
const MASKED_FIELDS = new Set(['date_of_birth', 'phone_number', 'email', 'address_line_1', 'address_line_2', 'insurance_member_id', 'emergency_contact_phone']);

// Enough to see what was collected without keeping a copy of the identifiers in the logs.
export function maskPayload(args: Args): Args {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, MASKED_FIELDS.has(key) && value ? '***' : value]),
  );
}

function parseArguments(raw: unknown): Args {
  const args = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Tool arguments must be an object');
  }
  return args as Args;
}

const FAILED: ToolOutcome = { status: 'failed' };

// Never throws. A failure here must become something the agent can say out loud, because
// an unhandled error would leave the caller listening to silence. Duration is logged so
// latency is measured rather than guessed. A failed write logs the full payload, since
// that is the only copy left of what the caller said. Database error details stay out of
// the logs because they can quote the row.
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext, log: Logger): Promise<ToolOutcome> {
  const startedAt = performance.now();
  const durationMs = () => Math.round(performance.now() - startedAt);
  let args: Args = {};

  try {
    const tool = TOOLS[name];
    if (!tool) {
      log.error({ callId: ctx.callId, tool: name }, 'Unknown tool called');
      return FAILED;
    }
    args = parseArguments(rawArgs);
    const outcome = await withTimeout(Promise.resolve(tool(args, ctx)), TOOL_TIMEOUT_MS);
    log.info(
      {
        callId: ctx.callId,
        tool: name,
        status: outcome.status,
        durationMs: durationMs(),
        ...(LOGS_PAYLOAD.has(name) && { payload: maskPayload(args) }),
      },
      'Voice tool call',
    );
    return outcome;
  } catch (err) {
    const { message, code } = err as { message?: string; code?: string };
    log.error(
      { callId: ctx.callId, tool: name, durationMs: durationMs(), error: { message, code }, ...(LOGS_PAYLOAD.has(name) && { payload: args }) },
      'Voice tool call failed',
    );
    return FAILED;
  }
}
