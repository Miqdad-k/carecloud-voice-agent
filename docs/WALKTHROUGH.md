# Walkthrough

For rehearsal. Be able to say each section out loud, with the file open.

## The one-minute version

A caller dials a Vapi number. Vapi handles the audio, speech recognition and the LLM. When the model needs data it calls a tool, and Vapi sends that to my webhook as an HTTP POST. My server validates, writes to Postgres, and returns a short JSON status. The model turns the status into speech. When the call ends, Vapi posts the transcript, which I store against the patient. A REST API and a dashboard read the same tables, through the same service layer.

Three decisions are worth volunteering:

1. **One validation module.** The LLM is never trusted with the rules.
2. **Nothing is written until the caller confirms.** So "start over" and dropped calls are simple: there is nothing to undo.
3. **The save is idempotent on the call ID.** A retried webhook cannot create a second patient.

## Request path: one save, start to finish

Open these in order.

1. **`src/agent/assistant-config.ts`.** Declares the tools the model can call, and sets `server.url` and the secret header. `npm run vapi:sync` sends this to Vapi.
2. **`src/vapi/webhook-routes.ts`.** The POST arrives.
   - `onRequest` checks `x-vapi-secret` with `timingSafeEqual` before the body is even parsed. Wrong secret: 401.
   - The handler switches on `message.type`. Tool calls and end-of-call reports are handled, and everything else gets a 200.
3. **`src/vapi/tools.ts`.** `runTool` finds the handler and parses the arguments, which can be an object or a string, because Vapi's docs and its OpenAPI file disagree. It catches everything, because a thrown error would mean silence on the phone.
   - `savePatient` pulls out `caller_confirmed`. Anything but the boolean `true` returns `not_confirmed`.
4. **`src/patients/service.ts`, `registerPatientFromCall`.** Validates first, then opens a transaction.
   - `lockCall` inserts the call row if it is new, then `SELECT ... FOR UPDATE`.
   - If that row already has a `patient_id`, this is a retry: return that patient as `already_saved`.
   - Otherwise insert the patient and link the call. Both commit together.
5. **`src/patients/repository.ts`.** The SQL, parameterized. Column names come from validated keys, never from user input.
6. **Back out.** The outcome becomes `{ results: [{ name, toolCallId, result }] }`, where `result` is a JSON string on one line, and the status is always 200. Vapi's rules: any other status is ignored.
7. **The prompt** says what to say for each status: "You're all set, Jane", then `endCall`.
8. **Later, the end-of-call report.** `saveCallReport` upserts the transcript. If no patient is linked, the status becomes `incomplete`.

**Why the row lock?** Without it, two simultaneous retries could both see "no patient yet" and both insert. With it, the second one waits at the `SELECT ... FOR UPDATE`, then sees the first one's patient. A test fires three at once.

## Validation

`src/patients/validation.ts`. The table called `RULES` is the whole data model. Each field says whether it is required and which function checks it.

- **Three modes.** `create` needs all required fields. `update` checks only what was sent and allows `null` to clear an optional field. `partial` is for `check_fields`, which checks one answer during the call.
- **Rules clean as well as check.** `(202) 555-0147` becomes `2025550147`, `ca` becomes `CA`, and MM/DD/YYYY becomes an ISO date for the database. The API returns MM/DD/YYYY again.
- **Date of birth:** JavaScript rolls February 31st into March, so I build the date and check it round-trips. Then not in the future, and not before 1900.
- **Second line of defense:** the database has an enum, CHECK constraints and NOT NULL. A test bypasses the validator and proves the database still rejects bad data.
- **Not in the database:** "not in the future", because a CHECK using `current_date` can break a dump and restore. That one is in the validator only.
- **400 or 422?** 400: I could not understand the request. 422: I understood it, and a field breaks a rule.

## Prompt choices

`src/agent/system-prompt.ts`. Each section has its reason beside it.

- **Written for the ear.** One or two sentences, one question at a time, and no lists. Digits and dates are spelled out because the text goes straight to speech.
- **A checklist, not a script.** Out-of-order answers work because the model tracks what is missing rather than following steps.
- **Phone number early.** A returning caller finds out at once, not after ten questions.
- **`check_fields` during the call.** Otherwise a future date of birth would only surface at the save, after the caller already confirmed. I added this as a fourth tool for that reason.
- **Corrections re-read only what changed.** Reading the whole record again after a one-letter fix is what makes bots maddening.
- **A sentence for every failure status.** The worst thing a voice agent can do is go quiet.
- **The prompt never contains data rules.** It says "ask the server, then act on the answer". Rules change in one place.

Other choices in `assistant-config.ts`:

- `onNumberSeconds: 1.5` waits longer after digits, so the agent does not cut in while someone dictates a phone number.
- Temperature 0.3, because tool arguments should be accurate more than varied.
- Lookup returns names only. Anyone can say a phone number, so the model is never given an address to read out. If it does not have the data, it cannot leak it.

## Questions they may ask

**Why not let the LLM validate?** It is probabilistic, and the rules must hold every time. It is good at turning "March fifteenth" into `03/15/1985`, and bad at being a guarantee.

**How do you know the caller really confirmed?** Honestly, I rely on the model setting the flag after the read-back. The server enforces that the flag is there, not that it is true. Checking the live transcript in the webhook payload is the next improvement. It is in the README.

**What if the database dies mid-call?** Short timeouts, so it fails in about 5 seconds rather than hanging. The webhook still returns 200 with status `failed`, the agent says so and tries once more. If that fails, it apologizes and says nothing was saved. The payload is in the logs. A test renames the table to cause a real failure.

**What if the call drops?** Nothing has been written, so there is no partial patient. The end-of-call report stores the transcript as `incomplete`, and it shows on the dashboard.

**Why is phone not unique?** A parent and child can share a number. A match triggers a question, not a block.

**Why is the REST API open?** So reviewers can use it. It is the first thing I would change, and it is documented.

**Why is the webhook reply not in the envelope?** Vapi dictates that shape. The envelope is the contract for API clients.

**Why not an ORM?** I want every query visible. Entity Framework would be my default in .NET for a bigger model, but for two tables plain SQL is shorter and easier to defend.

**Why does the system prompt say "Today's date is {{date}}"?** A model does not know today's date. Vapi fills that in, in UTC.

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
