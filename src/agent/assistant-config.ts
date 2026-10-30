import { FIRST_MESSAGE, SYSTEM_PROMPT } from './system-prompt.js';

// The Vapi assistant, defined in code so it can be reviewed, versioned and recreated.
// Field names checked against Vapi's OpenAPI document on 2026-10-30.

// Tool schemas are sent to the model on every turn, so descriptions are short and each
// field is described once. Formats are a hint: src/patients/validation.ts enforces them
// and rejects any field not in its table.
const PATIENT_PROPERTIES = {
  first_name: { type: 'string' },
  last_name: { type: 'string' },
  date_of_birth: { type: 'string', description: 'MM/DD/YYYY' },
  sex: { type: 'string', enum: ['Male', 'Female', 'Other', 'Decline to Answer'] },
  phone_number: { type: 'string', description: '10 digits' },
  email: { type: 'string' },
  address_line_1: { type: 'string' },
  address_line_2: { type: 'string' },
  city: { type: 'string' },
  state: { type: 'string', description: '2 letters' },
  zip_code: { type: 'string' },
  insurance_provider: { type: 'string' },
  insurance_member_id: { type: 'string' },
  preferred_language: { type: 'string' },
  emergency_contact_name: { type: 'string' },
  emergency_contact_phone: { type: 'string', description: '10 digits' },
};

const CALLER_CONFIRMED = { type: 'boolean', description: 'True only after a clear yes from the caller' };

// Only the answers worth checking the moment they're given. The rest wait for the save,
// so this schema stays short.
const { date_of_birth, phone_number, state, zip_code, email, insurance_member_id, emergency_contact_phone } = PATIENT_PROPERTIES;
const CHECKABLE_FIELDS = { date_of_birth, phone_number, state, zip_code, email, insurance_member_id, emergency_contact_phone };

// Spoken while a write is running, in the language of the call. Reads and checks stay
// silent, since they normally return faster than a caller would notice.
function fillers(english: string, spanish: string) {
  const speak = (en: string, es: string) => [
    { type: 'text', text: en, language: 'en' },
    { type: 'text', text: es, language: 'es' },
  ];
  return [
    { type: 'request-start', contents: speak(english, spanish) },
    {
      type: 'request-response-delayed',
      timingMilliseconds: 5000,
      contents: speak('Still working on it, thanks for your patience.', 'Sigo en ello, gracias por su paciencia.'),
    },
  ];
}

// Sent if our server cannot be reached at all, which is the one failure the server itself
// cannot report. Passed to the model as an instruction, so it speaks instead of going quiet.
const WRITE_UNREACHABLE = {
  type: 'request-failed',
  role: 'system',
  content: 'That failed and nothing was saved. Treat it as status failed.',
};

const READ_UNREACHABLE = {
  type: 'request-failed',
  role: 'system',
  content: 'That failed. Do not mention it. Carry on.',
};

function tool(name: string, description: string, parameters: object, messages: object[]) {
  return { type: 'function', function: { name, description, parameters }, messages };
}

// No list, search or delete tools exist, and no tool takes a patient ID, so no amount of
// persuasion can make the model reach another record: the capability isn't there.
const TOOLS = [
  tool(
    'lookup_patient_by_phone',
    'Find existing records by phone, as soon as the caller gives it.',
    {
      type: 'object',
      properties: { phone_number: PATIENT_PROPERTIES.phone_number },
      required: ['phone_number'],
      additionalProperties: false,
    },
    [READ_UNREACHABLE],
  ),
  tool(
    'check_fields',
    'Validate answers without saving. Send only the fields to check.',
    { type: 'object', properties: CHECKABLE_FIELDS, additionalProperties: false },
    [READ_UNREACHABLE],
  ),
  tool(
    'save_patient',
    'Save a new patient, only after the read-back and a clear yes.',
    {
      type: 'object',
      properties: { ...PATIENT_PROPERTIES, caller_confirmed: CALLER_CONFIRMED },
      required: [
        'first_name', 'last_name', 'date_of_birth', 'sex', 'phone_number',
        'address_line_1', 'city', 'state', 'zip_code', 'caller_confirmed',
      ],
      additionalProperties: false,
    },
    [...fillers('One moment while I save that.', 'Un momento mientras lo guardo.'), WRITE_UNREACHABLE],
  ),
  tool(
    'verify_identity',
    'Confirm the caller knows the date of birth on a matched record, before updating it.',
    {
      type: 'object',
      properties: {
        date_of_birth: PATIENT_PROPERTIES.date_of_birth,
        match: { type: 'integer', description: 'Which match, if there were several' },
      },
      required: ['date_of_birth'],
      additionalProperties: false,
    },
    [READ_UNREACHABLE],
  ),
  tool(
    'update_patient',
    'Change fields on the record saved or verified on this call. Send only changed fields and caller_confirmed.',
    {
      type: 'object',
      properties: { ...PATIENT_PROPERTIES, caller_confirmed: CALLER_CONFIRMED },
      required: ['caller_confirmed'],
      additionalProperties: false,
    },
    [...fillers('One moment while I update that.', 'Un momento mientras lo actualizo.'), WRITE_UNREACHABLE],
  ),
  tool(
    'get_appointment_slots',
    'Get open appointment times, optionally near a preference.',
    {
      type: 'object',
      properties: {
        day: { type: 'string', enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
        time_of_day: { type: 'string', enum: ['morning', 'afternoon'] },
      },
      additionalProperties: false,
    },
    [READ_UNREACHABLE],
  ),
  tool(
    'book_appointment',
    'Book a slot for the patient on this call, after they agree.',
    {
      type: 'object',
      properties: {
        slot: { type: 'string', description: 'A slot value from get_appointment_slots' },
        caller_confirmed: CALLER_CONFIRMED,
      },
      required: ['slot', 'caller_confirmed'],
      additionalProperties: false,
    },
    [...fillers('One moment while I book that.', 'Un momento mientras lo reservo.'), WRITE_UNREACHABLE],
  ),
  // Vapi's built-in hang-up tool. The agent says goodbye itself, then calls it.
  { type: 'endCall' },
];

export const ASSISTANT_NAME = 'CareCloud Patient Intake';
export const MODEL = 'gpt-4.1-mini';

export function buildAssistant(publicBaseUrl: string, webhookSecret: string) {
  return {
    name: ASSISTANT_NAME,
    firstMessage: FIRST_MESSAGE,
    firstMessageMode: 'assistant-speaks-first',
    // A registration with every optional field and a booking fits well inside this.
    maxDurationSeconds: 900,
    // Vapi's default for phone calls is office noise, which only makes speech harder to hear.
    backgroundSound: 'off',
    voicemailDetection: 'off',

    // Chosen and justified in the README. Billed through Vapi, so no separate provider key.
    // Vapi picks its own fallback models if this one fails, and its schema advises against
    // setting them by hand.
    model: {
      provider: 'openai',
      model: MODEL,
      // Low, because tool arguments should be accurate more than they should be varied.
      temperature: 0.3,
      // The default of 250 tokens can cut off a long read-back.
      maxTokens: 350,
      // A fixed key groups every call's identical prefix for OpenAI's automatic prompt
      // cache. It holds no call data. Whether it helps is measured: see cached_prompt_tokens.
      promptCacheKey: 'carecloud-intake-v1',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }],
      tools: TOOLS,
    },

    // An Azure multilingual voice, which speaks whichever language the text is in. Azure
    // rather than a Vapi voice, because Vapi's own voices have no fallback option in the
    // schema. Vapi's docs show the ID "multilingual-auto", but its API rejects that.
    voice: {
      provider: 'azure',
      voiceId: 'en-US-EmmaMultilingualNeural',
      fallbackPlan: { voices: [{ provider: 'vapi', voiceId: 'Elliot' }] },
    },

    // "multi" is the setup Vapi's docs recommend for language switching on one assistant.
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'multi',
      fallbackPlan: { transcribers: [{ provider: 'deepgram', model: 'nova-2', language: 'multi' }] },
    },

    // Respond quickly in general, but wait longer after a number, so the agent doesn't
    // jump in while someone is pausing halfway through a phone number or ZIP code.
    startSpeakingPlan: {
      waitSeconds: 0.4,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.1,
        onNoPunctuationSeconds: 1.5,
        onNumberSeconds: 1.2,
      },
    },

    hooks: [
      // Never sit in silence. A gentle check first, since the caller may be finding an
      // insurance card, then a polite hang-up. "prompt" rather than fixed text, so it
      // comes out in the language of the call.
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 15, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
        do: [{ type: 'say', prompt: 'In one short sentence, in the language of this call, check the caller is still there and say to take their time.' }],
      },
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 45, triggerMaxCount: 1, triggerResetMode: 'onUserSpeech' },
        do: [
          { type: 'say', prompt: 'In one short sentence, in the language of this call, say you will hang up because they seem to have stepped away, and that anything not yet confirmed was not saved.' },
          { type: 'tool', tool: { type: 'endCall' } },
        ],
      },
    ],

    // Only what the app uses. Everything else would just be webhook noise.
    serverMessages: ['tool-calls', 'end-of-call-report'],

    // A custom header, not a Vapi credential, so the whole setup stays in this one file with
    // no dashboard step. The inline server.secret field is gone from Vapi's current schema,
    // and server.headers is the documented alternative.
    server: {
      url: `${publicBaseUrl.replace(/\/+$/, '')}/vapi/webhook`,
      timeoutSeconds: 15,
      headers: { 'x-vapi-secret': webhookSecret },
    },

    // Audio recordings add storage and sensitivity for no gain here.
    artifactPlan: { recordingEnabled: false },

    // Vapi runs a summary and a success evaluation through an LLM by default. The transcript
    // is already stored, so those would be tokens spent re-reading it.
    analysisPlan: {
      summaryPlan: { enabled: false },
      successEvaluationPlan: { enabled: false },
    },
  };
}
