<!-- Version :021126 14:50 -->
# Avatar Vouching Agentic AI — Intake + AI Review

Intake page → 6-digit email code → file upload → Google Drive (`agentic.avai@gmail.com`)
→ **AI review: ChatGPT + Gemini in parallel → Claude final decision** → Google Docs → link emailed to the requester.

## Drive layout
```
Vouching/
├── _data/
│   └── companies.json                     ← master registry: every firm, customer, contact, submission + status
└── SPN/                                   ← first word of Accounting Company
    └── CONTINENTAL/                       ← first word of Customer Company
        ├── company_profile.json           ← this customer's slice of the registry
        └── 2026-11-02_1500_AV-6BD99D/     ← one folder per submission
            ├── Ledger_Files/
            ├── Output_Format_Sample/      (if provided)
            ├── Linked_Files/              (copied from the client's shared link)
            ├── submission_info.json       ← raw web-form data
            └── AI_Review/                 ← shared (view) with the requester when complete
                ├── 01_ChatGPT_Findings_AV-6BD99D        (Google Doc)
                ├── 02_Gemini_Findings_AV-6BD99D         (Google Doc)
                ├── 03_Claude_Final_Decision_AV-6BD99D   (Google Doc) ← link emailed to requester
                └── json/
                    ├── input_manifest.json    files analysed, truncation, skipped files
                    ├── prompt.json            refined Notes + full engineered prompt
                    ├── chatgpt_response.json
                    ├── gemini_response.json
                    ├── claude_decision.json
                    └── pipeline_result.json   status, models, timings, links
```

## AI review stage (`lib/avatar-vouching.js`)
| Step | What happens | File |
|---|---|---|
| 1 | Collect stored files; spreadsheets/CSV → text with `#row|` markers; DOCX/PDF → text; scanned PDFs + images sent natively | `lib/extract.js` |
| 2 | Notes → structured instructions (period, threshold, sampling, focus areas, output preference) + directives | `lib/prompt-builder.js` `refineNotes()` |
| 3 | Engineered reviewer prompt (SSA 500/530/330, Singapore GST, strict JSON schema) → **ChatGPT + Gemini in parallel** | `buildReviewerPrompt()`, `lib/llm.js` |
| 4 | Problem + both solutions → **Claude**: verifies each finding against data, resolves disagreements, adds missed issues → final decision | `buildJudgePrompt()` |
| 5 | Three Google Docs + JSON files in `AI_Review/` | `lib/report.js` |
| 6 | Share `AI_Review/` with requester, email the final-decision link, update registry, notify admin | |

- Client is emailed **only** when Claude's final decision succeeded. Otherwise admin gets a "NEEDS ATTENTION" email.
- If one reviewer fails, Claude still decides with the other. If both fail, Claude does the full review alone.
- Jobs run one at a time; the service pings itself during a job so Render's free tier doesn't sleep mid-run.

## Environment variables (new)
| Key | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | — | Missing key → that model is skipped |
| `OPENAI_MODEL` | `gpt-5.4` | Model IDs change often — verify at `/healthz/ai` |
| `OPENAI_REASONING_EFFORT` | `high` | `low` / `medium` / `high` |
| `GEMINI_MODEL` | `gemini-3.1-pro-preview` | |
| `CLAUDE_MODEL` | `claude-opus-5-5` | |
| `MAX_AI_TEXT_CHARS` | `400000` | Text budget per prompt, split fairly across files |
| `MAX_AI_ATTACH_MB` | `12` | Native PDFs/images (Gemini inline limit ≈ 20 MB after base64) |
| `SHARE_RESULTS_WITH_REQUESTER` | `true` | Shares `AI_Review/` (view only) |
| `ADMIN_TOKEN` | auto (blueprint) | For `/admin/rerun` |

## Admin endpoints
- `GET /healthz` — version + queue
- `GET /healthz/google` — Google auth check
- `GET /healthz/ai` — keys present + each model ID exists
- `POST /admin/rerun` — re-run a submission's AI review:
  ```bash
  curl -X POST https://avatar-vouching.onrender.com/admin/rerun \
    -H "x-admin-token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \
    -d '{"reference":"AV-6BD99D"}'
  ```
  Creates `AI_Review_rerun_<timestamp>/` beside the original.

## Local test (no Google, no AI keys)
```bash
npm install
npm run dev:mock      # DEV_MODE + AI_MOCK → files in ./_dev_drive, Docs as .html, emails in console
```
`npm run dev` with real AI keys set calls the real models but still writes locally.

## Google setup, refresh token, deploy
Unchanged — see `/admin/connect` (`lib/connect.js`) or `get-refresh-token.js`. Scopes: `drive`, `gmail.send`.
After deploying: **delete `package-lock.json` once** (new dependencies), push, then check `/healthz/ai`.

## Pending (by decision)
- PDPA & data confidentiality review: documents stay on Drive; OpenAI request uses `store: true` (needed for background mode); prompts contain client ledger data.
