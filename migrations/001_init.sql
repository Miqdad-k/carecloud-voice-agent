-- Patients and the calls that created or changed them.
-- The application validates every field first (src/patients/validation.ts).
-- These constraints are the second line: bad data cannot get in even through a
-- code bug or a manual INSERT.

CREATE TYPE patient_sex AS ENUM ('Male', 'Female', 'Other', 'Decline to Answer');

CREATE TABLE patients (
  patient_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name              VARCHAR(50)  NOT NULL CHECK (char_length(first_name) >= 1),
  last_name               VARCHAR(50)  NOT NULL CHECK (char_length(last_name) >= 1),
  -- "Not in the future" is enforced in the validator, because a CHECK using
  -- current_date is not stable across a dump and restore.
  date_of_birth           DATE         NOT NULL CHECK (date_of_birth >= DATE '1900-01-01'),
  sex                     patient_sex  NOT NULL,
  phone_number            CHAR(10)     NOT NULL CHECK (phone_number ~ '^[2-9][0-9]{9}$'),
  email                   VARCHAR(254) CHECK (email LIKE '%_@_%.__%'),
  address_line_1          VARCHAR(200) NOT NULL CHECK (char_length(address_line_1) >= 1),
  address_line_2          VARCHAR(100),
  city                    VARCHAR(100) NOT NULL CHECK (char_length(city) >= 1),
  state                   CHAR(2)      NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  zip_code                VARCHAR(10)  NOT NULL CHECK (zip_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  insurance_provider      VARCHAR(100),
  insurance_member_id     VARCHAR(50)  CHECK (insurance_member_id ~ '^[A-Za-z0-9]+$'),
  preferred_language      VARCHAR(50)  NOT NULL DEFAULT 'English',
  emergency_contact_name  VARCHAR(100),
  emergency_contact_phone CHAR(10)     CHECK (emergency_contact_phone ~ '^[2-9][0-9]{9}$'),
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ
);

-- Phone is indexed, not unique: a parent and child can share a number.
-- Partial indexes, because every read excludes soft-deleted rows.
CREATE INDEX patients_phone_idx ON patients (phone_number) WHERE deleted_at IS NULL;
CREATE INDEX patients_last_name_idx ON patients (lower(last_name)) WHERE deleted_at IS NULL;
CREATE INDEX patients_dob_idx ON patients (date_of_birth) WHERE deleted_at IS NULL;

-- One row per phone call. The primary key is Vapi's call ID, which is what makes
-- the voice save idempotent: a retried webhook finds this row and its patient.
-- patient_id stays NULL when the call ended before anything was saved, so a
-- dropped call keeps its transcript without creating a partial patient.
CREATE TABLE calls (
  vapi_call_id  TEXT PRIMARY KEY,
  patient_id    UUID REFERENCES patients (patient_id),
  status        TEXT NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress', 'completed', 'incomplete')),
  caller_number TEXT,
  transcript    TEXT,
  summary       TEXT,
  ended_reason  TEXT,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calls_patient_idx ON calls (patient_id);

-- updated_at is set by the database so no code path can forget it.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER patients_updated_at BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER calls_updated_at BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
