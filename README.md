# Training Drill Generator

A trainer-facing system for customer-service training drills.

**Trainer = dashboard. Trainee = Google Form.** Trainees never log in to, see, or use the
dashboard. They get a Google Form link, answer it, and submit.

```text
Trainer ─► Training Drill Desk (claude.ai Artifact)
             create drill ─► generate scenarios (Claude, grounded in approved sources)
             review / edit / regenerate ─► approve (answer key stays in the dashboard)
             Create Google Form ─► request file in private Drive folder
                                        │
                     Form Bridge (Apps Script, trainer's Google account)
                     builds the Form + linked response Sheet, writes result
                                        │
Trainer shares the form link ─► Trainee completes Google Form ─► responses
                                        │
                     Form Bridge exports responses every 5 minutes
                                        │
Dashboard: Sync responses ─► map by form item ID ─► auto score + trainer score ─► coaching
```

## Pieces

| Path | What it is |
| --- | --- |
| `src/core/` | Drill lifecycle, IDs, scenario schema, source grounding, form spec, response mapping, scoring, coaching, and the drill service. Plain JS shared by the dashboard and the tests. |
| `src/drills/` | Drill type definitions: `approveDeny.js`, `triage.js`, and `registry.js`. |
| `src/artifact/` | The dashboard page (`page.html`, `app.js`) and adapters to the Artifact runtime (`adapters.js`). |
| `src/bridge/` | The Google Apps Script Form Bridge (`Code.js`, `appsscript.json`). |
| `scripts/build.js` | Inlines everything into `dist/trainer-dashboard.html`, the file published as the Artifact. |
| `test/` | Node tests (`npm test`) covering the full workflow with fakes for the database, bridge and Claude. |
| `docs/E2E_TEST_PLAN.md` | The live end-to-end check to run in Google once the bridge is installed. |

## Why there is a bridge

The dashboard is a claude.ai Artifact. Artifact pages can use their own database, ask Claude,
and call the viewer's connectors (Google Drive, Slack), but they cannot call the Google Forms
API. The Google Drive connector can create and read files, but it cannot build a Form.
So a small Apps Script runs in a trainer's Google account and does the Forms and Sheets work.
The two sides exchange JSON files in one private Drive folder:

| File | Written by | Contents |
| --- | --- | --- |
| `drillform-request__<drillId>__<specHash>.json` | Dashboard | Trainee-safe form spec only |
| `drillform-result__<drillId>.json` | Bridge | Form ID, trainee link, editor link, response sheet, item IDs |
| `drillform-responses__<drillId>.json` | Bridge | Every submission with item IDs (sheet fallback if the form can't be read) |
| `drill-sources-request__<ts>.json` | Dashboard | Asks for a fresh Knowledge Library export |
| `drill-sources__index.json`, `drill-sources__part-NNN.json` | Bridge | The Care Knowledge Library split into heading-level sections |

## Data layers (kept separate)

1. **Scenario data** (`scenarios` collection): the canonical scenario with a `trainee` part and
   a `trainer` part (correct answer, deciding account detail, rationale, sources, scoring rules,
   common mistakes, coaching notes). Only the trainee part is ever turned into a form.
2. **Google Form data**: derived on demand by `buildFormSpec()` from the approved trainee
   parts. It is scanned for trainer-only text before it is sent, and the bridge refuses specs
   that contain answer-key fields.
3. **Response data** (`responses` collection): one document per submission, with answers and
   scores. The sync never writes to `scenarios`.

## IDs and mapping

- Drill: `APPROVE-DENY-2026-10-01-001`, `TRIAGE-2026-10-01-001` (per type and day).
- Scenario: `AD-001`, `TR-001` (unique in the drill, never reused after removal).
- Every form question title starts with a tag such as `AD-003 · Q2`.
- Responses map by **form item ID** first (stable even if a question is renamed in Forms),
  then by the `AD-003 · Q2` tag (sheet headers), never by column position.
- A trainee is identified by verified Google email (default), else by the required name question.

## Lifecycle

`DRAFT → GENERATED → TRAINER_REVIEW → APPROVED → FORM_CREATING → FORM_CREATED → SENT →
RESPONSES_RECEIVED → UNDER_REVIEW → COMPLETED`

Generated scenarios are never approved automatically. Any edit to trainee-facing content after
approval withdraws the approval. After the form exists, trainee content is locked; answer-key
corrections are still allowed and rescore existing responses.

## Duplicate prevention

- The drill moves to `FORM_CREATING` before anything external happens.
- The request file name carries drill ID + spec hash; the dashboard looks it up before writing.
- The bridge keeps one form per drill ID (Script Properties, then a Drive title + description
  marker search) and records the form ID right after `FormApp.create()`.
- A half-built form is finished on the next run (items matched by title); items that already
  have answers are never deleted.
- The dashboard marks `FORM_CREATED` only after reading a bridge result with the same spec hash.
- Response sync is keyed by form response ID, so re-syncing never duplicates submissions.

## Source grounding

- Scenarios are generated only from imported Knowledge Library sections and trainer-approved
  CSQ Slack snippets. With no matching sections, generation refuses instead of guessing.
- Every answer key cites quotes; each quote is checked verbatim (whitespace and quote style
  normalized) against the sources. Unverified quotes, "sources insufficient" answers and manual
  scenarios raise blocking flags that a trainer must resolve with a note before approval.
- Triage answer choices (process, tag, checklist) come only from the approved process catalog,
  whose entries are themselves extracted from the sources and approved by a trainer.

## Scoring

- Objective questions (action set, process, tag, checklist) are auto-scored.
- Written answers are trainer-scored; the dashboard shows a keyword-overlap hint only.
- `autoScore` and the trainer's `finalScore` are stored separately; trainers can override.
- Gap tags (incorrect decision/process/tag/checklist, missing account detail, weak reasoning,
  policy misread) feed the Coaching view.

## Adding a drill type

Write a definition like `src/drills/approveDeny.js` (IDs, defaults, source keywords, form
instructions, question template with scoring rules, prompt guidance, model output schema,
`buildAnswerKey`, optional `validate`) and add it to `getDrillTypes()` in `registry.js`.
No other code changes are needed for generation, forms, mapping, scoring or coaching.

## Setup

1. **Dashboard**: published at https://claude.ai/artifact/HAuvHtN65cr1Z9REMxLcZZ from
   `dist/trainer-dashboard.html` (rebuild with `npm run build` and republish after changes). Share it with trainers only, as
   Contributor or Editor. Do not turn on organization-wide or public access.
2. **Form Bridge**: create an Apps Script project, paste `src/bridge/Code.js` and
   `src/bridge/appsscript.json`, run `setupBridge()`, and accept the permissions. Copy the
   logged folder ID into the dashboard's Settings. Share that folder with trainers (Editor) only.
3. **Sources**: in the dashboard, Sources → "Ask the bridge for a fresh export", wait for the
   next bridge run, then "Import latest export". Add CSQ channel IDs in Settings to review and
   approve Slack snippets.
4. **Triage**: Sources → "Propose entries from sources", check each entry, approve at least two.

## Development

```bash
npm test          # 36 tests: lifecycle, grounding, idempotency, mapping, scoring, coaching
npm run build     # writes dist/trainer-dashboard.html
```

## Daily drill

Today → "Start today's drill" creates the Approve or Deny drill, generates 5 scenarios, and
opens the review. Automatic daily generation is not built in. If it's wanted later, a scheduled
routine could create the draft, but it would still stop at trainer review.
