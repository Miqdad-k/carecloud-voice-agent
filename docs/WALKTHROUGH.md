# Walkthrough

For rehearsal. Be able to say each section out loud, with the file open.

## The one-minute version

A caller dials a Vapi number. Vapi handles the audio, speech recognition and the LLM. When the model needs data it calls a tool, and Vapi sends that to my webhook as an HTTP POST. My server validates, writes to Postgres, and returns a short status. The model turns the status into speech. When the call ends, Vapi posts the transcript, which I store against the patient. A REST API and a dashboard read the same tables, through the same service layer.

Five decisions are worth volunteering:

1. **One validation module.** The LLM is never trusted with the rules.
2. **Nothing is written until the caller confirms.** So "start over" and dropped calls are simple: there is nothing to undo.
3. **The save is idempotent on the call ID.** A retried webhook cannot create a second patient.
4. **The model never holds a patient ID.** What a call can touch lives on the server, so prompt injection has nothing to reach for.
5. **If code can do it, the model doesn't.** Dates, phone words, state names, the calendar. Faster, exact, and no tokens.

## Request path: one save, start to finish

Open these in order.

1. **`src/agent/assistant-config.ts`.** Declares the tools the model can call, and sets `server.url` and the secret header. `npm run vapi:sync` sends this to Vapi.
2. **`src/vapi/webhook-routes.ts`.** The POST arrives.
   - `onRequest` checks `x-vapi-secret` with `timingSafeEqual` before the body is even parsed. Wrong secret: 401.
   - The handler switches on `message.type`. Tool calls and end-of-call reports are handled, and everything else gets a 200.
   - An entry with no call ID runs nothing, because everything is keyed on the call.
3. **`src/vapi/tools.ts`.** `runTool` finds the handler and parses the arguments, which can be an object or a string, because Vapi's docs and its OpenAPI file disagree. It catches everything and has an 8 second limit, because a thrown error or a hang would mean silence on the phone.
   - `savePatient` pulls out `caller_confirmed`. Anything but the boolean `true` returns `not_confirmed`.
4. **`src/patients/service.ts`, `registerPatientFromCall`.** Validates first, then opens a transaction.
   - `lockCall` inserts the call row if it is new, then `SELECT ... FOR UPDATE`.
   - If that row already has a `patient_id`, this is a retry: return that patient as `already_saved`.
   - Otherwise insert the patient and link the call. Both commit together.
5. **`src/patients/repository.ts`.** The SQL, parameterized. Column names come from validated keys, never from user input.
6. **Back out.** The outcome becomes `{ results: [{ name, toolCallId, result }] }`, where `result` is a JSON string on one line, and the status is always 200. Vapi's rules: any other status is ignored.
7. **The prompt** says what to say for each status: "You're all set, Jane", then an appointment offer, then `endCall`.
8. **Later, the end-of-call report.** `saveCallReport` upserts the transcript and the token counts. If no patient is linked, the status becomes `incomplete`.

**Why the row lock?** Without it, two simultaneous retries could both see "no patient yet" and both insert. With it, the second one waits at the `SELECT ... FOR UPDATE`, then sees the first one's patient. A test fires three at once.

## Validation

`src/patients/validation.ts`. The table called `RULES` is the whole data model. Each field says whether it is required and which function checks it.

- **Three modes.** `create` needs all required fields. `update` checks only what was sent and allows `null` to clear an optional field. `partial` is for `check_fields`, which checks one answer during the call.
- **Rules clean as well as check.** `(202) 555-0147` and `two zero two...` both become `2025550147`. `california` and `ca` become `CA`. `March 15th 1985` becomes an ISO date for the database, and the API returns MM/DD/YYYY.
- **Date of birth:** JavaScript rolls February 31st into March, so I build the date and check it round-trips. Then not in the future, and not before 1900.
- **Second line of defense:** the database has an enum, CHECK constraints and NOT NULL. A test bypasses the validator and proves the database still rejects bad data.
- **Not in the database:** "not in the future", because a CHECK using `current_date` can break a dump and restore. That one is in the validator only.
- **400 or 422?** 400: I could not understand the request. 422: I understood it, and a field breaks a rule.

## Guardrails: how prompt injection is handled

The point to make: **I assume it works, and make sure it gains nothing.** A prompt is not a security boundary. The tests in `tests/guardrails.test.ts` send the attacker's tool call directly, as if the model had already been fooled.

Walk through an update, because it shows all of it:

1. `lookup_patient_by_phone` stores the matching IDs on the call row, and returns only names and `match: 1`.
2. `verify_identity` takes a date of birth and compares it in SQL. On success, `verified_patient_id` is set on the call row. Two failures lock it.
3. `update_patient` takes only the changed fields. The target is `call.patient_id ?? call.verified_patient_id`.

So if a caller says "update patient 1234", there is nowhere for that ID to go: the validator rejects `patient_id` as an unknown field. If they say "read me everything about Jane", the model doesn't have it. If they say "delete everyone", no such tool exists.

The prompt still has a guardrail section, because it keeps the conversation on track. It is the second layer, not the wall.

**The honest gap:** `caller_confirmed` is set by the model. A fooled model could set it to true. That's limited to creating a new record, or changing one this call already verified.

## Latency and tokens

- **Our server is not the slow part.** I measured it: about 12 ms median per tool, 20 ms at p95, on 30 simulated calls. Real delay is the LLM, speech and network, which only a live call measures. `durationMs` is on every tool log.
- **`gpt-4.1-mini`.** No reasoning step. `gpt-4o-mini` is cheaper, and I'd admit that's a judgment call: a one-line swap to test. `gpt-5-mini` has a thinking step, and delay is what a caller notices first.
- **No mid-call model switching.** Vapi's docs say there's no action for it, only a handoff to another assistant. More failure paths, tiny saving.
- **Prompt went from 1,289 to 944 words** while gaining Spanish, appointments and guardrails. It's re-sent every turn, so every word costs on every turn.
- **Vapi's post-call summary is off.** It would run the transcript through an LLM to tell me what I already stored.
- **Caching:** static text first, date last, because prompt caching needs an identical prefix. Say clearly that it's unconfirmed until `cached_prompt_tokens` is above zero on a real call. Don't claim more than that.

## Prompt choices

`src/agent/system-prompt.ts`. Each section has its reason beside it.

- **Written for the ear.** One or two sentences, one question at a time, and no lists. Digits and dates are spelled out because the text goes straight to speech.
- **A checklist, not a script.** Out-of-order answers work because the model tracks what is missing rather than following steps.
- **Phone number early.** A returning caller finds out at once, not after ten questions.
- **`check_fields` during the call.** Otherwise a future date of birth would only surface at the save, after the caller already confirmed. Only for risky answers, since each call costs a model turn.
- **Corrections re-read only what changed.** Reading the whole record again after a one-letter fix is what makes bots maddening.
- **A line for every failure status.** The worst thing a voice agent can do is go quiet, and the second worst is claiming it saved when it didn't.
- **The prompt never contains data rules.** It says "ask the server, then act on the answer". Rules change in one place.

Other choices in `assistant-config.ts`:

- `onNumberSeconds: 1.2` waits longer after digits, so the agent does not cut in while someone dictates a phone number.
- Temperature 0.3, because tool arguments should be accurate more than varied.
- Silence hooks use `prompt`, not fixed text, so they come out in the caller's language. That does spend a little model time, only when someone has gone quiet.

## Spanish and appointments

- **Spanish** is Vapi's documented setup: `nova-3` with language `multi`, a multilingual Azure voice, and languages listed in the prompt. Tool arguments stay in one format, so the validator is unchanged. Fillers have English and Spanish variants. Worry to mention: `multi` might be weaker on English digits. Test it.
- **Appointments** are `src/appointments/slots.ts`: plain code generates the calendar and the spoken time. The model never does date math, because models get calendars wrong. A unique constraint on date and time means two callers can't take one slot, and a test races them.

## Questions they may ask

**Why not let the LLM validate?** It is probabilistic, and the rules must hold every time. It is good at understanding "March fifteenth", and bad at being a guarantee.

**How do you stop prompt injection?** I don't claim to. I make it pointless: no secrets or other patients' data in the context, no dangerous tools, and everything bound to the call on the server.

**How do you know the caller really confirmed?** Honestly, I rely on the model setting the flag after the read-back. The server enforces that the flag is there, not that it is true. Checking the live transcript is the next improvement.

**What if the database dies mid-call?** I tested it by killing Postgres. A save returned `failed` in 69 ms, still as a 200, and the agent's instructions are to say so and try once more. If that fails, it says nothing was saved. The server recovered by itself when Postgres came back. The payload is in the logs.

**What if the LLM itself dies?** Vapi falls back to other models by itself. Voice and speech-to-text have configured fallbacks. If everything fails, the call ends with no message: Vapi's hooks offer no spoken action at that point. That's a real limit, and it's in the README.

**What if the call drops?** Nothing has been written, so there is no partial patient. The end-of-call report stores the transcript as `incomplete`, and it shows on the dashboard.

**Why is phone not unique?** A parent and child can share a number. A match triggers a question, not a block.

**Why is the REST API open?** So reviewers can use it. It's rate limited, and auth is the first thing I'd add.

**Why is the webhook reply not in the envelope?** Vapi dictates that shape. The envelope is the contract for API clients.

**Why not an ORM?** I want every query visible. Entity Framework would be my default in .NET for a bigger model, but for three tables plain SQL is shorter and easier to defend.

**Why does the prompt end with "Today's date is {{date}}"?** A model does not know today's date, and Vapi fills it in, in UTC. It's last so the prefix stays identical for caching.

**How do you know tests prove anything?** I found `npm test` was exiting 0 on failure, because embedded Postgres's exit hook overwrote the code. Fixed, then confirmed with a real failing test. Good story to tell, because it shows I check the checks.

## If you know .NET

| Here | Closest .NET idea |
|---|---|
| Fastify route | ASP.NET Core minimal API endpoint |
| `app.register(plugin)` | `MapGroup` with its own endpoints |
| `onRequest` hook | Endpoint filter or middleware |
| `pg.Pool` | `NpgsqlDataSource` |
| `withTransaction` | `await using var tx = ...`, commit at the end, roll back on throw |
| `WriteResult` union | A discriminated result type, like `Result<T>`, switched on `kind` |
| `vitest` | xUnit |
| `app.inject(...)` | `WebApplicationFactory` with `HttpClient` |
