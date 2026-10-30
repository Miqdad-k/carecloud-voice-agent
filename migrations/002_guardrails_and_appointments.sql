-- Server-side state for each call. The model never holds a patient ID, so what it
-- may touch is decided here, from what actually happened on this call.
ALTER TABLE calls
  ADD COLUMN matched_patient_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN verified_patient_id UUID REFERENCES patients (patient_id),
  ADD COLUMN lookup_count        INT NOT NULL DEFAULT 0,
  ADD COLUMN verify_failures     INT NOT NULL DEFAULT 0,
  -- From Vapi's end-of-call report, so token use and caching are measured, not guessed.
  ADD COLUMN prompt_tokens        INT,
  ADD COLUMN completion_tokens    INT,
  ADD COLUMN cached_prompt_tokens INT,
  ADD COLUMN cost_usd             NUMERIC(10, 4);

-- A mock calendar with one provider, in clinic local time. Date and time are stored
-- separately on purpose: no time zone arithmetic to get wrong for mock data.
CREATE TABLE appointments (
  appointment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       UUID NOT NULL REFERENCES patients (patient_id),
  -- Unique, so a retried webhook cannot book twice for one call.
  vapi_call_id     TEXT UNIQUE REFERENCES calls (vapi_call_id),
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Two callers cannot take the same slot, even at the same moment.
  UNIQUE (appointment_date, appointment_time)
);

CREATE INDEX appointments_patient_idx ON appointments (patient_id);
