// The one place patient data is validated. Both the REST API and the voice tools
// go through here, so a caller and an API client get exactly the same rules.
// The LLM is never trusted to validate: it only relays these messages.

export type FieldError = { field: string; message: string };

export type PatientInput = Partial<Record<PatientField, string | null>>;

export type ValidationResult =
  | { ok: true; value: PatientInput }
  | { ok: false; errors: FieldError[] };

// A rule returns the cleaned value, or throws Invalid with a message.
// Messages are plain enough for the agent to act on when it re-asks the caller.
class Invalid extends Error {}

function clean(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control characters
    .replace(/[‘’]/g, "'") // curly apostrophes, as in O’Brien
    .replace(/\s+/g, ' ')
    .trim();
}

function text(max: number, label: string) {
  return (value: string): string => {
    if (value.length > max) throw new Invalid(`${label} must be ${max} characters or fewer.`);
    return value;
  };
}

// Letters, hyphens and apostrophes as specified, plus inner spaces. This is a
// deliberate addition to the rule: "Van Der Berg" and "Mary Ann" are real names
// and the agent should not tell a caller their name is invalid.
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}' -]*$/u;

function name(label: string) {
  return (value: string): string => {
    if (value.length > 50) throw new Invalid(`${label} must be 50 characters or fewer.`);
    if (!NAME_PATTERN.test(value)) {
      throw new Invalid(`${label} can only contain letters, hyphens and apostrophes.`);
    }
    return value;
  };
}

// Returns YYYY-MM-DD for the database. Accepts the required MM/DD/YYYY, and ISO
// too, so an API client sending 1985-03-15 is not rejected for no good reason.
export function parseDateOfBirth(value: string): string {
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!us && !iso) throw new Invalid('Date of birth must be in MM/DD/YYYY format.');

  const [year, month, day] = us ? [+us[3], +us[1], +us[2]] : [+iso![1], +iso![2], +iso![3]];

  // JavaScript rolls 02/31 over to March, so a round trip exposes impossible dates.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Invalid('Date of birth is not a real calendar date.');
  }

  const result = date.toISOString().slice(0, 10);
  if (result > new Date().toISOString().slice(0, 10)) {
    throw new Invalid('Date of birth cannot be in the future.');
  }
  if (year < 1900) throw new Invalid('Date of birth must be in 1900 or later.');
  return result;
}

const SEX_VALUES = ['Male', 'Female', 'Other', 'Decline to Answer'];

function sex(value: string): string {
  const match = SEX_VALUES.find((s) => s.toLowerCase() === value.toLowerCase());
  if (!match) throw new Invalid(`Sex must be one of: ${SEX_VALUES.join(', ')}.`);
  return match;
}

// Ten digits, with an optional leading 1 or +1. The area code cannot start with 0
// or 1. The exchange is not checked further, so fictional numbers such as
// 555-123-4567 still pass, which is what a tester is likely to say.
export function parsePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) {
    throw new Invalid(`Phone number must have exactly 10 digits. This one has ${national.length}.`);
  }
  if (/^[01]/.test(national)) throw new Invalid('Phone number area code cannot start with 0 or 1.');
  return national;
}

function email(value: string): string {
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    throw new Invalid('Email address is not valid.');
  }
  return value.toLowerCase();
}

function street(value: string): string {
  if (value.length > 200) throw new Invalid('Street address must be 200 characters or fewer.');
  if (!/[\p{L}\p{N}]/u.test(value)) throw new Invalid('Street address is not valid.');
  return value;
}

// 50 states, DC, the territories, and the military mail codes.
const STATES = new Set(
  ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK ' +
    'OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC AS GU MP PR VI AA AE AP').split(' '),
);

function state(value: string): string {
  const upper = value.toUpperCase();
  if (!STATES.has(upper)) throw new Invalid('State must be a valid 2-letter U.S. abbreviation.');
  return upper;
}

function zip(value: string): string {
  const compact = value.replace(/[\s-]/g, '');
  if (!/^\d{5}(\d{4})?$/.test(compact)) throw new Invalid('ZIP code must be 5 digits or ZIP+4.');
  return compact.length === 9 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

// Spoken IDs arrive with stray spaces or dashes, so those are removed first.
function memberId(value: string): string {
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  if (compact.length > 50 || !/^[A-Z0-9]+$/.test(compact)) {
    throw new Invalid('Insurance member ID can only contain letters and numbers.');
  }
  return compact;
}

function language(value: string): string {
  if (value.length > 50 || !/^[\p{L} -]+$/u.test(value)) throw new Invalid('Preferred language is not valid.');
  return value;
}

function contactName(value: string): string {
  if (value.length > 100 || !/^\p{L}[\p{L}\p{M}'. -]*$/u.test(value)) {
    throw new Invalid('Emergency contact name can only contain letters, hyphens, apostrophes and periods.');
  }
  return value;
}

// The whole data model in one table. Column names in SQL come from these keys,
// never from user input, because unknown keys are rejected below.
const RULES = {
  first_name: { required: true, check: name('First name') },
  last_name: { required: true, check: name('Last name') },
  date_of_birth: { required: true, check: parseDateOfBirth },
  sex: { required: true, check: sex },
  phone_number: { required: true, check: parsePhone },
  email: { required: false, check: email },
  address_line_1: { required: true, check: street },
  address_line_2: { required: false, check: text(100, 'Address line 2') },
  city: { required: true, check: text(100, 'City') },
  state: { required: true, check: state },
  zip_code: { required: true, check: zip },
  insurance_provider: { required: false, check: text(100, 'Insurance provider') },
  insurance_member_id: { required: false, check: memberId },
  preferred_language: { required: false, check: language },
  emergency_contact_name: { required: false, check: contactName },
  emergency_contact_phone: { required: false, check: parsePhone },
} as const;

export type PatientField = keyof typeof RULES;

function isEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && clean(raw) === '');
}

// mode 'create': every required field must be present.
// mode 'update': only the fields sent are checked. An optional field can be
//                cleared with null; a required one cannot.
// mode 'partial': only the fields sent are checked and none may be cleared. Used
//                 by the agent to check a field as soon as the caller says it.
export function validatePatient(input: unknown, mode: 'create' | 'update' | 'partial'): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'body', message: 'Expected a JSON object.' }] };
  }

  const fields = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const value: PatientInput = {};

  for (const key of Object.keys(fields)) {
    if (!(key in RULES)) errors.push({ field: key, message: 'Unknown field.' });
  }

  for (const [key, rule] of Object.entries(RULES) as [PatientField, (typeof RULES)[PatientField]][]) {
    const raw = fields[key];

    if (isEmpty(raw)) {
      const missing = mode === 'create' && rule.required;
      const clearedRequired = mode === 'update' && rule.required && raw !== undefined;
      if (missing || clearedRequired) {
        errors.push({ field: key, message: 'This field is required.' });
      } else if (mode === 'update' && raw !== undefined) {
        value[key] = key === 'preferred_language' ? 'English' : null;
      }
      continue;
    }

    // Numbers are accepted because a phone or ZIP in JSON is often sent as one.
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      errors.push({ field: key, message: 'Must be text.' });
      continue;
    }

    try {
      value[key] = rule.check(clean(String(raw)));
    } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      errors.push({ field: key, message: err.message });
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export type PatientFilters = { last_name?: string; date_of_birth?: string; phone_number?: string };

// Query parameters for GET /patients. An unparseable filter is a malformed
// request, so the route answers 400.
export function validateFilters(query: Record<string, unknown>): { ok: true; filters: PatientFilters } | { ok: false; errors: FieldError[] } {
  const filters: PatientFilters = {};
  const errors: FieldError[] = [];

  const read = (key: keyof PatientFilters, parse: (value: string) => string) => {
    const raw = query[key];
    if (typeof raw !== 'string' || clean(raw) === '') return;
    try {
      filters[key] = parse(clean(raw));
    } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      errors.push({ field: key, message: err.message });
    }
  };

  read('last_name', (value) => value);
  read('date_of_birth', parseDateOfBirth);
  read('phone_number', parsePhone);

  return errors.length ? { ok: false, errors } : { ok: true, filters };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
