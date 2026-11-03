<!-- Version :031126 13:30 -->
# Avatar Vouching Agentic AI — Intake + AI Review

Intake page → 6-digit email code → file upload → Google Drive (`agentic.avai@gmail.com`)
→ **"Hi" health check → ChatGPT + Gemini in parallel → Claude final decision**
→ client gets a short **Google Doc** + a **Google Sheet workpaper**; admin gets cost & usage separately.

## Drive layout
```
Vouching/
├── _data/                                 ← ADMIN ONLY
│   ├── companies.json                     master registry: every firm, customer, contact, submission + status
│   ├── cost_ledger.json                   one row per AI run (source of truth)
│   └── Vouching_Cost_Ledger               (Google Sheet) same rows; type Billed (SGD) / Invoice no. here — kept on rebuild
└── SPN/                                   ← first word of Accounting Company
    └── CONTINENTAL/                       ← first word of Customer Company
        ├── company_profile.json
        └── 2026-11-02_1500_AV-6BD99D/     ← one folder per submission
            ├── Ledger_Files/
            ├── Output_Format_Sample/      (if provided)
            ├── Linked_Files/              (copied from the client's shared link)
            ├── submission_info.json
            ├── AI_Review/                 ← CLIENT-SHARED (view) when the review completes
            │   ├── 01_Final_Decision_AV-6BD99D        (Google Doc — narrative, ~2 pages, links to the Sheet)
            │   └── 02_Vouching_Workpaper_AV-6BD99D    (Google Sheet — all tables)
            └── _internal/                 ← ADMIN ONLY, never shared
                ├── Usage_Cost_AV-6BD99D               (Google Sheet — tokens + USD per model)
                └── json/  input_manifest, prompt, health_check, chatgpt_response,
                           gemini_response, claude_decision, pipeline_result
```

### Workpaper Sheet tabs (client)
| Tab | Contents |
|---|---|
| Summary | Engagement, risk, findings count, materiality, decision, models, run times |
| Final Findings | Claude's consolidated findings + **Client response / Status / Cleared by / Date cleared** columns for the auditor |
| Working Paper | Client-format table (follows the uploaded output format sample when given) |
| Reviewer Comparison | What each reviewer found, quality, agreements, disagreements + resolutions |
| ChatGPT Findings / Gemini Findings | Raw reviewer findings (audit trail) |
| Rejected Findings | Reviewer findings Claude rejected, with reasons |
| Questions & Review | Questions for client, human-review items, limitations — with a Done column |

**Cost and token usage never appear in client files or emails** — only in `_internal/`, `_data/` and the admin email.

## AI review stage (`lib/avatar-vouching.js`)
| Step | What happens | File |
|---|---|---|
| 1 | Collect stored files; spreadsheets/CSV → text with `#row|` markers; DOCX/PDF → text; scanned PDFs + images sent natively | `lib/extract.js` |
| 2 | Notes → structured instructions + directives; build engineered prompt | `lib/prompt-builder.js` |
| 2b | "Hi" health check to all 3 models. Any failure → alert to admin, "system unavailable" email to client, stop | `lib/llm.js` `preflight()` |
| 3 | **ChatGPT + Gemini in parallel** (no output-token cap, no time limit) | `lib/llm.js` |
| 4 | Problem + both solutions → **Claude** final decision | `buildJudgePrompt()` |
| 5 | Workpaper Sheet + Final Doc (`AI_Review/`); Usage_Cost Sheet + JSON (`_internal/`); ledger row (`_data/`) | `lib/report.js`, `lib/pricing.js`, `lib/ledger.js` |
| 6 | Share `AI_Review/` with requester, email Doc + Sheet links, update registry, admin email with cost | |

- Live progress page with 3 pendulums: `/progress?ref=AV-XXXXXX` (link in the "Files received" email).
- Client is emailed results **only** when Claude's final decision succeeded. Otherwise admin gets "NEEDS ATTENTION".
- Jobs run one at a time; the service pings itself during a job so Render's free tier doesn't sleep mid-run.

## Cost estimates (`lib/pricing.js`)
List prices, USD per 1M tokens (input / output; reasoning billed as output):
`gpt-5.4` 2.50 / 15 · `gemini-3.1-pro-preview` 2 / 12 · `claude-opus-5-5` 4 / 20.
Override without a code change: `PRICE_GPT_5_4="2.5,15"` (model id upper-cased, non-alphanumerics → `_`).
Provider dashboards remain the final authority.

## Environment variables
| Key | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | — | Missing key → health check fails → client told "unavailable" |
| `OPENAI_MODEL` / `GEMINI_MODEL` / `CLAUDE_MODEL` | `gpt-5.4` / `gemini-3.1-pro-preview` / `claude-opus-5-5` | Verify at `/healthz/ai` |
| `OPENAI_REASONING_EFFORT` | `high` | `low` / `medium` / `high` |
| `*_MAX_OUTPUT_TOKENS`, `CLAUDE_MAX_TOKENS`, `OPENAI_TIMEOUT_MIN` | unset = no cap | Leave unset |
| `PRICE_<MODEL>` | list price | `"in,out"` USD per 1M tokens |
| `ALERT_EMAIL` / `SUPPORT_CONTACT` | `agentic.avai@gmail.com` / `Krish +6597890305` | Health-check failure messages |
| `SHARE_RESULTS_WITH_REQUESTER` | `true` | Shares `AI_Review/` (view only) |
| `ADMIN_TOKEN` | — | For `/admin/rerun` |

## Admin endpoints
- `GET /healthz` — version + queue · `GET /healthz/google` · `GET /healthz/ai`
- `GET /progress?ref=…` / `GET /api/progress/:ref` — live pendulum page / its JSON
- `POST /admin/rerun` — creates `AI_Review_rerun_<ts>/` and `_internal_rerun_<ts>/` beside the originals:
  ```bash
  curl -X POST https://avatar-vouching.onrender.com/admin/rerun \
    -H "x-admin-token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \
    -d '{"reference":"AV-6BD99D"}'
  ```

## Local test (no Google, no AI keys)
```bash
npm install
npm run dev:mock      # files in ./_dev_drive; Docs as .html, Sheets as .xlsx; emails in console
AI_MOCK_DELAY_SEC=60 npm run dev:mock   # slow mock models, to watch the pendulums
```

## Google setup
Unchanged — `/admin/connect` (`lib/connect.js`). Scopes: `drive`, `gmail.send`.
Google Sheets are created by uploading `.xlsx` and letting Drive convert it — no Sheets API and no new consent needed.

## Pending (by decision)
- PDPA & data confidentiality review: documents stay on Drive; OpenAI request uses `store: true` (needed for background mode).
