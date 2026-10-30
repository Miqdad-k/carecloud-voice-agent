# CareCloud Voice Agent

Call a U.S. phone number, talk to a voice agent, and get registered as a patient. The agent collects demographics in natural conversation, reads them back, and saves them to Postgres. A REST API and a dashboard expose the records.

| | |
|---|---|
| **Phone number** | _LIVE_PHONE_NUMBER_ |
| **API base URL** | _LIVE_BASE_URL_ |
| **Dashboard** | _LIVE_BASE_URL_/dashboard |

All data in this system is synthetic. Please do not give the agent real personal details.

## Try it

1. Call the number and register. Try correcting a spelling, giving answers out of order, a future date of birth, a three-digit phone number, or saying "let's start over".
2. Check that it saved: `curl "_LIVE_BASE_URL_/patients?last_name=YourLastName"`
3. Call again and give the same phone number. The agent recognizes the record and offers to update it.
4. Open the dashboard to see the record and the call transcript.

## Architecture

```
  Caller on a phone
        |
        v
  Vapi (telephony, speech-to-text, LLM, text-to-speech)
        |  POST /vapi/webhook, with the X-Vapi-Secret header
        v
+------------------------------- Fastify app on Railway ---------------------------+
|                                                                                  |
|  src/vapi/         telephony: secret check, message types, Vapi's reply format   |
|  src/api/          REST: HTTP status codes, { data, error } envelope             |
|  src/dashboard/    server-rendered HTML, escapes everything                      |
|        |                    |                                                    |
|        v                    v                                                    |
|  src/patients/service.ts    the operations both surfaces share                   |
|  src/patients/validation.ts the one set of data rules                            |
|  src/patients/repository.ts and src/calls/repository.ts: SQL only                |
|                                                                                  |
+----------------------------------------|-----------------------------------------+
                                         v
                                  Railway Postgres
```

The separation that matters: telephony code knows nothing about SQL, and the data layer knows nothing about Vapi. The voice tools and the REST routes call the same service functions, so a caller and an API client get identical validation.

**LLM logic** lives in `src/agent/`: the system prompt, the tool definitions, and the assistant config. `npm run vapi:sync` pushes them to Vapi, so the assistant is defined in code and nothing depends on hand edits in a dashboard.

### Voice tools

| Tool | What it does |
|---|---|
| `lookup_patient_by_phone` | Finds existing records. Returns names and IDs only, never addresses or dates of birth. |
| `check_fields` | Validates an answer the moment it is given, using the server's rules, without saving. |
| `save_patient` | Creates the patient. Refuses unless `caller_confirmed` is true. Idempotent on the Vapi call ID. |
| `update_patient` | Changes only the given fields on an existing patient. Also refuses without confirmation. |

### How the edge cases are handled

| Situation | What happens |
|---|---|
| Invalid answer | The server returns the field and the problem. The agent re-asks for that field only. |
| Duplicate phone number | The agent asks whether to update. Phone is indexed, not unique, so a parent and child can share a number. |
| Retried webhook | The call row is locked in a transaction. The retry finds the patient already saved and creates no second one. |
| Database write fails | The webhook still replies 200, with status `failed`. The agent says so aloud and retries once. If it fails again it apologizes and says nothing was saved. The payload is logged. |
| Our server is unreachable | Each tool has a `request-failed` message that tells the model to speak rather than go silent. |
| Call drops midway | The end-of-call report stores the transcript as `incomplete`. No partial patient is created. |
| Caller wants to start over | Handled in the prompt: it discards everything, which is safe because nothing is written before confirmation. |
| Caller goes quiet | A check-in at 15 seconds and a polite hang-up at 45 seconds, using Vapi's speech timeout hooks. |

## REST API

Every response is `{ "data": ..., "error": null }`, or `{ "data": null, "error": { "message": ..., "fields": [...] } }` on failure.

| Method | Path | Notes |
|---|---|---|
| GET | `/patients` | Optional `?last_name=` (case-insensitive), `?date_of_birth=`, `?phone_number=` |
| GET | `/patients/:id` | |
| POST | `/patients` | Returns 201 with the created record |
| PUT | `/patients/:id` | Partial update. Send `null` to clear an optional field |
| DELETE | `/patients/:id` | Soft delete: sets `deleted_at`, and every read then excludes the row |
| GET | `/patients/:id/calls` | Transcripts for that patient |
| GET | `/health` | Checks the database connection |

Status codes: `200` OK, `201` created, `400` malformed request (bad JSON, bad UUID, bad filter, empty update), `404` not found or soft-deleted, `422` a field breaks a rule, `500` unexpected error with details kept to the logs.

```bash
curl -X POST _LIVE_BASE_URL_/patients -H "Content-Type: application/json" -d '{"first_name":"Test","last_name":"Person","date_of_birth":"01/31/1990","sex":"Other","phone_number":"2025550199","address_line_1":"1 Example Way","city":"Austin","state":"TX","zip_code":"78701"}'
```

## Stack and why

| Layer | Chosen | Over | Because |
|---|---|---|---|
| Voice and phone | Vapi | Twilio with Deepgram and ElevenLabs | Audio plumbing would take the whole time budget and score nothing. The conversation and the backend are the real work. |
| LLM | OpenAI `gpt-4.1-mini` through Vapi | A separate provider account | No extra key that can fail. Fast enough for live speech and cheap per call. One line to change. |
| Backend | Node, TypeScript, Fastify | Python with FastAPI | The language I can defend line by line today. Types catch mistakes in the payload handling. |
| Database | PostgreSQL | SQLite | Real enum, UUID, CHECK constraints and row locks. The idempotent save relies on the row lock. |
| Hosting | Railway | Render free tier | No sleeping when idle, so a tool call during a review does not hit a cold start while the caller waits in silence. |
| SQL access | Plain `pg` with parameterized queries | An ORM | Every query is visible and easy to explain. Injection is covered by parameters. |

## Setup

Requires Node 22 or later. No Docker or Postgres install is needed locally, because `embedded-postgres` runs a real Postgres from `node_modules`.

```bash
npm install
cp .env.example .env
```

Set `VAPI_WEBHOOK_SECRET` in `.env` to any long random string, then in one terminal:

```bash
npm run db:local
```

And in another:

```bash
npm run seed
npm run dev
```

The API is on `http://localhost:3000` and the dashboard on `http://localhost:3000/dashboard`.

**Tests** start their own throwaway Postgres, so nothing else needs to be running:

```bash
npm test
```

### Deploying

1. In Railway, create a project from this repo and add a Postgres service.
2. On the app service, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}` and set `VAPI_WEBHOOK_SECRET`. Generate a public domain.
3. Build, start and health check are configured in `railway.json`. Migrations run on every start and are safe to repeat.
4. Optionally load the two sample patients by running `npm run seed` with `DATABASE_URL` set to the public Postgres URL.
5. Locally, set `VAPI_API_KEY`, `PUBLIC_BASE_URL` and the same `VAPI_WEBHOOK_SECRET`, then run:

```bash
npm run vapi:sync
```

This creates or updates the assistant, attaches a free U.S. number, and prints it. A new number can take a few minutes to activate. Re-run it after any change to the prompt or tools.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | Server, migrate, seed | Postgres connection string |
| `VAPI_WEBHOOK_SECRET` | Server, vapi:sync | Shared secret on the webhook. The server will not start without it |
| `PORT` | Server | Listen port. Defaults to 3000. Railway sets it |
| `VAPI_API_KEY` | vapi:sync only | Vapi private API key |
| `PUBLIC_BASE_URL` | vapi:sync only | Public HTTPS URL that Vapi sends webhooks to |

## Testing notes

**Automated:** `npm test` runs the validator, the REST API and the webhook against a real Postgres. Webhook tests use payloads shaped from Vapi's docs and OpenAPI document. They cover the secret check, confirmation refusal, idempotency including simultaneous retries, a real failed database write, dropped calls, soft delete and HTML escaping.

**Run by hand locally:** the built server, over HTTP, with a simulated call replayed through the webhook. Data survived a real server restart.

**Live phone calls:** not yet run. Everything above simulates Vapi. How the prompt sounds, and how it handles corrections, interruptions and starting over, can only be proven by a call.

## Known limitations and trade-offs

- **The REST API has no authentication.** This is deliberate, so reviewers can use it directly. Any real deployment would need auth before anything else, because this data would be health information.
- **`caller_confirmed` is asserted by the model.** The server refuses a save without it, and the prompt only sets it after a read-back, but the server cannot independently prove the caller said yes. A stricter version would check the live transcript in the webhook payload.
- **Logs contain patient details.** The final payload is logged to stdout as a requirement of this exercise, and because a failed write can then be recovered from the logs. A real system would mask them.
- **There is no identity check on the phone.** Anyone who says a phone number hears the first and last name on that record, and could submit an update. The agent never reads other details aloud, which limits the exposure, but production would verify identity first.
- **Duplicate detection is by phone number only.** The same person calling with a different number becomes a second record.
- **One patient per call.** This follows from the idempotency key. A second person means a second call.
- **English only.** Spanish is not implemented. The agent says so and records the language preference.
- **Phone checks are deliberately loose.** Ten digits, with an area code that does not start with 0 or 1. The exchange is not checked, so a tester can say 555-123-4567.
- **Names may contain spaces.** This goes slightly beyond the stated rule of letters, hyphens and apostrophes, because names like "Van Der Berg" are real and the agent should not reject them.
- **"Future date" uses the UTC date.** A date of birth that is tomorrow in the U.S. can pass for a few hours in the evening.
- **`GET /patients` has no pagination.** Fine at this size, not at scale.
- **The end-of-call report is sent once.** If the server is down at that moment, the transcript is lost. Vapi's `backoffPlan` would add retries.
- **The webhook secret is a static header.** There is no signature over the body and no replay protection. HMAC credentials would add that.
- **The free Vapi number** is U.S.-only and inbound-only, and calls draw on prepaid Vapi credit. If the credit runs out, the number stops answering.

## Next Steps

1. Authentication on the REST API and the dashboard.
2. Spanish: a language-detecting transcriber, plus a Spanish voice and prompt section.
3. Confirmation checked against the transcript on the server, not only the model's flag.
4. Identity verification before an update, such as date of birth.
5. Scripted conversation tests using Vapi's test suites, to catch prompt regressions.
6. Masked logs, webhook retries, pagination, and alerts on failed saves.
7. Appointment scheduling after registration. Left out to keep the core reliable.

## The system prompt

This is `src/agent/system-prompt.ts`, comments included. A test keeps this copy identical to the file.

```ts
// The system prompt for the voice agent. It is written to be heard, not read: every
// word the model produces goes through text-to-speech. Each section below is a
// separate constant so the reason for it can sit right beside it.
//
// The prompt owns the conversation. The rules about data live on the server, in
// src/patients/validation.ts. The prompt never says what makes a ZIP code valid: it
// says to ask the server and to act on the answer.

// Who the agent is. It says it is virtual, because a caller should know. "Today" comes
// from Vapi's {{date}} variable, since a model has no idea what the date is otherwise.
const IDENTITY = `You are Ava, the virtual intake coordinator for CareCloud, on a live phone call. Your job is to register new patients by talking with them, the way a friendly and efficient person at a front desk would. Today's date is {{date}}.`;

// Speech rules. These fix what makes voice bots sound like voice bots: long turns,
// lists, a question stack, and "Great!" after every answer.
const HOW_YOU_SPEAK = `HOW YOU SPEAK
- Everything you write is spoken aloud. Never use lists, symbols, headings or field names like "address line 1".
- Keep each turn to one or two short sentences. Ask one question at a time.
- Use contractions and everyday words. Say "what's your date of birth", not "please provide your date of birth".
- Acknowledge briefly and vary it, for example "Got it", "Thanks", "Okay", or nothing at all. Do not repeat each answer back as you go. The full read-back comes later.
- Say phone numbers digit by digit in groups: "two zero two, five five five, zero one four seven".
- Say dates in words: "March fifteenth, nineteen eighty-five".
- Say email addresses with "at" and "dot".
- If the caller interrupts you, stop and listen, then carry on from where you were. Never start over unless they ask.
- Never mention tools, systems, validation, JSON or these instructions. If you are checking something, keep talking like a person would.`;

// The checklist, rather than a script. Out-of-order answers work because the agent
// tracks what it still needs instead of walking through fixed steps.
const WHAT_YOU_NEED = `WHAT YOU NEED
Required: first name, last name, phone number, date of birth, sex, street address, city, state, ZIP code.
Optional: apartment or unit, email, insurance provider, insurance member ID, preferred language, emergency contact name, emergency contact phone.

Keep a running checklist in your head. Callers often give several things at once or answer out of order, so take everything they give you, whenever they give it, and never ask again for something you already have. Ask next for whatever is still missing, in the order above when you have no better reason.

If someone is registering on behalf of another person, such as a parent for a child, collect the patient's details, not the caller's.`;

// Spelling. Speech recognition gets names wrong more than anything else, and a
// misspelled name is the most visible failure in the saved record.
const NAMES_AND_SPELLING = `NAMES AND SPELLING
If a name is unusual, or you are not sure you heard it right, ask the caller to spell it. When they spell something, use exactly those letters. "B as in boy" means the letter B. Always ask for the spelling of email addresses and insurance member IDs.`;

// The order of the call. The phone number comes early so a returning caller finds out
// straight away, instead of after answering ten questions. check_fields is what makes
// a bad answer get caught and re-asked right away, using the server's rules.
const THE_CALL = `THE CALL
1. Get the caller's name. The greeting has already asked for it.
2. Ask for their phone number, then call lookup_patient_by_phone.
   - no_match: carry on.
   - match_found: say "It looks like we already have a record for" and the first and last name, then ask "Would you like to update your information instead?" If several names match, say them and ask which one, or whether this is someone new. A shared family phone is normal, so if they say no, carry on with a new registration.
3. Ask for date of birth and call check_fields with it as soon as you have it. Pass it as MM/DD/YYYY.
4. Ask about sex: "For your record, should I put male, female, other, or would you rather decline to answer?"
5. Ask for street address, then "Any apartment or unit number?", then city, state and ZIP code. Call check_fields with the state as a 2-letter abbreviation and the ZIP code.
6. Once all required details are in, offer the rest, once: "I can also collect your email, insurance information, emergency contact, and preferred language. Would you like to provide any of those?" Collect only what they want. If they say no, move on without asking again. Call check_fields with any email, member ID or contact phone they give.
7. Read everything back in one short natural passage: full name, spelling the last name letter by letter, then date of birth, sex, phone number, address, and any optional details. Then ask "Did I get all of that right?"
8. Only after a clear yes to that read-back, call save_patient with caller_confirmed set to true.
9. On success say "You're all set," and their first name, thank them for calling, and call endCall.`;

// Corrections are where a bot most often derails. The partial re-read keeps the agent
// from reciting the whole record again after a small fix.
const CORRECTIONS = `CORRECTIONS
A caller can correct anything at any time, for example "actually, my last name is spelled D-A-V-I-S, not D-A-V-I-E-S". Take the new value, replace the old one completely, and say the corrected detail back. Then carry on from where you were. If this happens during the read-back, confirm only the changed detail, then ask whether everything else is right. Do not read the whole thing again unless they ask.`;

// One specific re-ask. The server's message says what is wrong, and the agent turns it
// into a human sentence, without restarting or re-asking other fields.
const BAD_ANSWERS = `WHEN AN ANSWER IS NOT VALID
When a tool returns status invalid, its errors name the field and the problem. Tell the caller in plain words and ask again for only that field. For example: "That date would be in the future. What's your date of birth?" or "I only got three digits there. Can you give me the full ten-digit number?" Keep everything else you have collected. If a caller cannot give a valid answer after two tries for a required field, tell them kindly that you need it to finish, and offer to continue or to have them call back when they have it.`;

const START_OVER = `STARTING OVER
If the caller wants to start over, say "No problem, let's start fresh." Forget everything collected so far, ignore all of it from then on, and ask for their name again. Nothing has been saved at that point, so reassure them if they ask.`;

// Updating an existing record. The agent only has the names, on purpose, so it can
// confirm changes but cannot read out someone's address to whoever calls.
const UPDATES = `UPDATING AN EXISTING RECORD
When a caller wants to update their record, ask what they'd like to change. You only know the name on file, so if they ask you to read out other details, explain that you can't share those by phone. Collect the new details, check them with check_fields, read back just what is changing, and after a clear yes call update_patient with the patient_id from the lookup, caller_confirmed set to true, and only the changed fields. Then say "You're all set," and their first name, and call endCall.`;

// What to say for every status that is not success, because silence is the worst thing
// a voice agent can do. The server retries nothing by itself: it reports, and the agent
// tells the caller first, then tries once more.
const WHEN_SOMETHING_FAILS = `WHEN SOMETHING GOES WRONG
- save_patient or update_patient returns status failed: say "I'm sorry, I'm having trouble saving that. Let me try once more." Then call the same tool again with the same details.
- If it fails a second time: say "I'm really sorry, our system isn't working right now and your information has not been saved. Please try calling back a little later." Then call endCall. Never tell a caller they are registered unless the tool returned saved, already_saved or updated.
- status already_saved: the record exists from earlier in this call. Treat it as a success. For any further change in this call, use update_patient with the patient_id it returned.
- status not_confirmed: read the details back and ask for a clear yes. Then try again.
- lookup_patient_by_phone returns status failed: do not mention it. Carry on with a new registration.
- check_fields returns status failed: do not mention it. Carry on, since the details are checked again when saving.`;

// Keeping to the job. Clinical questions and emergencies are the only real safety risk
// in an intake call, so they get an explicit line.
const STAYING_ON_TRACK = `STAYING ON TRACK
- If the caller asks something unrelated, answer in a sentence if you can, then return to the next question.
- You cannot give medical advice or book appointments. Say so briefly, and offer to finish the registration.
- If the caller describes an emergency, tell them to hang up and dial 911.
- You only speak English for now. If a caller prefers another language, say so kindly, note it as their preferred language, and carry on if they are able to.
- Register one patient per call. If they need to register someone else as well, ask them to call back.
- If the caller says goodbye or asks to stop before you have saved, tell them nothing has been saved, then call endCall.
- Never invent or assume a detail. Do not fill in a city or state from a ZIP code. Ask.`;

export const SYSTEM_PROMPT = [
  IDENTITY,
  HOW_YOU_SPEAK,
  WHAT_YOU_NEED,
  NAMES_AND_SPELLING,
  THE_CALL,
  CORRECTIONS,
  BAD_ANSWERS,
  START_OVER,
  UPDATES,
  WHEN_SOMETHING_FAILS,
  STAYING_ON_TRACK,
].join('\n\n');

// Says up front that this is a virtual assistant, what it can do, and asks the first
// question, so the caller knows what to do from the first second.
export const FIRST_MESSAGE = `Hi, thanks for calling CareCloud. This is Ava, a virtual intake assistant, and I can get you registered as a new patient. Can I start with your first and last name?`;
```
