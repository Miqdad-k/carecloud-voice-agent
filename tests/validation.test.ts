import { describe, expect, it } from 'vitest';
import { validatePatient } from '../src/patients/validation.js';
import { validPatient } from './helpers.js';

function errorsFor(fields: Record<string, unknown>) {
  const result = validatePatient({ ...validPatient, ...fields }, 'create');
  return result.ok ? [] : result.errors.map((e) => e.field);
}

function valueOf(field: string, raw: unknown) {
  const result = validatePatient({ ...validPatient, [field]: raw }, 'create');
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return (result.value as Record<string, unknown>)[field];
}

describe('validatePatient', () => {
  it('accepts a complete valid patient and normalises it', () => {
    const result = validatePatient(validPatient, 'create');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.date_of_birth).toBe('1985-03-15');
      expect(result.value.phone_number).toBe('2025550147');
    }
  });

  it('names every missing required field', () => {
    const result = validatePatient({}, 'create');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field).sort()).toEqual(
        ['address_line_1', 'city', 'date_of_birth', 'first_name', 'last_name', 'phone_number', 'sex', 'state', 'zip_code'].sort(),
      );
    }
  });

  it.each([['Mary Ann'], ["O'Brien"], ['Smith-Jones'], ['José'], ['O’Brien']])('accepts the name %s', (name) => {
    expect(errorsFor({ first_name: name })).toEqual([]);
  });

  it.each([['J0hn'], ['Robert;DROP'], ['<script>'], ['x'.repeat(51)], ['   ']])('rejects the name %s', (name) => {
    expect(errorsFor({ first_name: name })).toEqual(['first_name']);
  });

  it.each([['13/01/1990'], ['02/30/1990'], ['1990'], ['next tuesday'], ['01/01/1850'], ['12/31/2999']])(
    'rejects the date of birth %s',
    (dob) => {
      expect(errorsFor({ date_of_birth: dob })).toEqual(['date_of_birth']);
    },
  );

  it('accepts a leap day only in a leap year', () => {
    expect(errorsFor({ date_of_birth: '02/29/2000' })).toEqual([]);
    expect(errorsFor({ date_of_birth: '02/29/2001' })).toEqual(['date_of_birth']);
  });

  it('accepts today as a date of birth but not tomorrow', () => {
    const iso = (offset: number) => new Date(Date.now() + offset).toISOString().slice(0, 10);
    expect(errorsFor({ date_of_birth: iso(0) })).toEqual([]);
    expect(errorsFor({ date_of_birth: iso(86400000) })).toEqual(['date_of_birth']);
  });

  it.each([['202-555-0147'], ['+1 202 555 0147'], ['12025550147'], ['555-123-4567'], [2025550147]])(
    'accepts the phone number %s',
    (phone) => {
      expect(errorsFor({ phone_number: phone })).toEqual([]);
    },
  );

  it.each([['555'], ['202555014'], ['20255501470'], ['123-456-7890'], ['abc']])('rejects the phone number %s', (phone) => {
    expect(errorsFor({ phone_number: phone })).toEqual(['phone_number']);
  });

  it('tells the caller how many digits a short phone number had', () => {
    const result = validatePatient({ ...validPatient, phone_number: '555' }, 'create');
    expect(!result.ok && result.errors[0].message).toContain('This one has 3');
  });

  it('normalises sex, state, ZIP, email and member ID', () => {
    expect(valueOf('sex', 'decline to answer')).toBe('Decline to Answer');
    expect(valueOf('state', 'ca')).toBe('CA');
    expect(valueOf('zip_code', '123456789')).toBe('12345-6789');
    expect(valueOf('email', 'Jane@Example.COM')).toBe('jane@example.com');
    expect(valueOf('insurance_member_id', 'abc 123-45')).toBe('ABC12345');
  });

  it.each([
    ['sex', 'Unknown'],
    ['state', 'ZZ'],
    ['state', 'California'],
    ['zip_code', '1234'],
    ['zip_code', '12345-678'],
    ['email', 'not-an-email'],
    ['insurance_member_id', 'AB#12'],
    ['emergency_contact_phone', '555'],
  ])('rejects %s = %s', (field, value) => {
    expect(errorsFor({ [field]: value })).toEqual([field]);
  });

  it('rejects unknown fields and non-text values', () => {
    expect(errorsFor({ patient_id: 'abc' })).toEqual(['patient_id']);
    expect(errorsFor({ city: { nested: true } })).toEqual(['city']);
  });

  it('checks only the fields sent in update and partial modes', () => {
    expect(validatePatient({ city: 'Austin' }, 'update').ok).toBe(true);
    expect(validatePatient({ date_of_birth: '12/31/2999' }, 'partial').ok).toBe(false);
  });

  it('allows clearing an optional field on update but not a required one', () => {
    const cleared = validatePatient({ email: null }, 'update');
    expect(cleared.ok && cleared.value.email).toBe(null);
    expect(validatePatient({ city: null }, 'update').ok).toBe(false);
  });
});
