import { FIRST_MESSAGE, SYSTEM_PROMPT } from './system-prompt.js';

// The Vapi assistant, defined in code so it can be reviewed, versioned and recreated.
// Field names checked against Vapi's OpenAPI document on 2026-10-30.

const string = (description: string) => ({ type: 'string', description });

// Formats are described for the model, but enforced by src/patients/validation.ts.
const PATIENT_PROPERTIES = {
  first_name: string('First name, using the exact spelling the caller gave.'),
  last_name: string('Last name, using the exact spelling the caller gave.'),
  date_of_birth: string('Date of birth as MM/DD/YYYY.'),
  sex: { type: 'string', enum: ['Male', 'Female', 'Other', 'Decline to Answer'] },
  phone_number: string('10-digit U.S. phone number, digits only.'),
  email: string('Email address.'),
  address_line_1: string('Street number and street name.'),
  address_line_2: string('Apartment, suite or unit, if any.'),
  city: string('City.'),
  state: string('2-letter U.S. state abbreviation, such as CA.'),
  zip_code: string('5-digit ZIP code or ZIP+4.'),
  insurance_provider: string('Name of the insurance company.'),
  insurance_member_id: string('Insurance member or subscriber ID, letters and numbers only.'),
  preferred_language: string('Preferred language. Leave out if not mentioned.'),
  emergency_contact_name: string('Full name of the emergency contact.'),
  emergency_contact_phone: string('Emergency contact 10-digit U.S. phone number, digits only.'),
};

const CALLER_CONFIRMED = {
  type: 'boolean',
  description: 'True only if the caller clearly said yes after hearing the details read back.',
};

// Spoken if our server cannot be reached at all, which is the one failure the server
// itself cannot report. Passed to the model as an instruction so the conversation can
// continue rather than going silent.
const WRITE_FAILED = {
  type: 'request-failed',
  role: 'system',
  content: 'That request failed and nothing was saved. Follow the WHEN SOMETHING GOES WRONG instructions as if the status was failed.',
};

const CARRY_ON_IF_FAILED = {
  type: 'request-failed',
  role: 'system',
  content: 'That check failed. Do not mention it to the caller. Carry on with the next question.',
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup_patient_by_phone',
      description: 'Find existing patients by phone number. Call this once, as soon as the caller gives their phone number.',
      parameters: {
        type: 'object',
        properties: { phone_number: PATIENT_PROPERTIES.phone_number },
        required: ['phone_number'],
      },
    },
    messages: [CARRY_ON_IF_FAILED],
  },
  {
    type: 'function',
    function: {
      name: 'check_fields',
      description: 'Check one or more answers right after the caller gives them, without saving anything. Send only the fields you want to check.',
      parameters: { type: 'object', properties: PATIENT_PROPERTIES },
    },
    messages: [CARRY_ON_IF_FAILED],
  },
  {
    type: 'function',
    function: {
      name: 'save_patient',
      description: 'Save a new patient. Only call this after reading everything back and hearing a clear yes.',
      parameters: {
        type: 'object',
        properties: { ...PATIENT_PROPERTIES, caller_confirmed: CALLER_CONFIRMED },
        required: [
          'first_name', 'last_name', 'date_of_birth', 'sex', 'phone_number',
          'address_line_1', 'city', 'state', 'zip_code', 'caller_confirmed',
        ],
      },
    },
    messages: [
      { type: 'request-start', content: 'One moment while I save that.' },
      { type: 'request-response-delayed', timingMilliseconds: 5000, content: "Still working on it. Thanks for your patience." },
      WRITE_FAILED,
    ],
  },
  {
    type: 'function',
    function: {
      name: 'update_patient',
      description: 'Change fields on an existing patient found by lookup_patient_by_phone. Send only the changed fields. Only call this after reading the changes back and hearing a clear yes.',
      parameters: {
        type: 'object',
        properties: {
          patient_id: string('The patient_id returned by lookup_patient_by_phone.'),
          ...PATIENT_PROPERTIES,
          caller_confirmed: CALLER_CONFIRMED,
        },
        required: ['patient_id', 'caller_confirmed'],
      },
    },
    messages: [
      { type: 'request-start', content: 'One moment while I update that.' },
      { type: 'request-response-delayed', timingMilliseconds: 5000, content: "Still working on it. Thanks for your patience." },
      WRITE_FAILED,
    ],
  },
  // Vapi's built-in hang-up tool. The agent says goodbye itself, then calls it.
  { type: 'endCall' },
];

export const ASSISTANT_NAME = 'CareCloud Patient Intake';

export function buildAssistant(publicBaseUrl: string, webhookSecret: string) {
  return {
    name: ASSISTANT_NAME,
    firstMessage: FIRST_MESSAGE,
    firstMessageMode: 'assistant-speaks-first',
    // A registration with every optional field can run long, so the default of
    // 10 minutes is raised.
    maxDurationSeconds: 1200,
    backgroundSound: 'off',
    voicemailDetection: 'off',

    model: {
      provider: 'openai',
      // Fast enough for live conversation and cheap enough that test calls do not
      // run down the Vapi credit. Billed through Vapi, so no separate provider key.
      model: 'gpt-4.1-mini',
      // Low, because tool arguments should be accurate more than they should be varied.
      temperature: 0.3,
      // The default of 250 tokens can cut off a long read-back.
      maxTokens: 500,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }],
      tools: TOOLS,
    },

    voice: { provider: 'vapi', voiceId: 'Clara' },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },

    // Callers pause in the middle of dictating phone numbers and ZIP codes. Waiting
    // longer after a number stops the agent from jumping in halfway through.
    startSpeakingPlan: {
      waitSeconds: 0.5,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.2,
        onNoPunctuationSeconds: 1.5,
        onNumberSeconds: 1.5,
      },
    },

    // Never sit in silence. A gentle check first, because the caller may be finding an
    // insurance card, then a polite hang-up.
    hooks: [
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 15, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
        do: [{ type: 'say', exact: "Are you still there? Take your time, I'm happy to wait." }],
      },
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 45, triggerMaxCount: 1, triggerResetMode: 'onUserSpeech' },
        do: [
          { type: 'say', exact: "It sounds like you may have stepped away, so I'll end the call here. Nothing has been saved. Please call back any time." },
          { type: 'tool', tool: { type: 'endCall' } },
        ],
      },
    ],

    // Only what the app uses. Everything else would just be webhook noise.
    serverMessages: ['tool-calls', 'end-of-call-report'],

    // A custom header, not a Vapi credential, so the whole setup stays in this one
    // file with no dashboard step. The inline server.secret field is gone from Vapi's
    // current schema, and server.headers is the documented alternative.
    server: {
      url: `${publicBaseUrl.replace(/\/+$/, '')}/vapi/webhook`,
      timeoutSeconds: 15,
      headers: { 'x-vapi-secret': webhookSecret },
    },

    // The transcript is what the task needs. Audio recordings add storage and
    // sensitivity for no gain here.
    artifactPlan: { recordingEnabled: false },
  };
}
