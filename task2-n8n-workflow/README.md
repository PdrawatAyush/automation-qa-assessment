# Task 2 – n8n "Morning Brief" workflow

**Deliverables:** `Task2_Workflow_AyushRawat.json` (exported with n8n's *Download* menu, n8n 2.41.3) · `Task2_ErrorHandler_AyushRawat.json` (the Error Workflow it uses) · `screenshots/1-workflow-canvas.png` and `screenshots/3-execution-output-data.png` (+ extras: `2-successful-execution`, `4-error-path-execution`, `5-error-workflow-canvas`).

**What it does:** every hour – or on demand through a token-protected webhook – it finds the most-starred **new** GitHub repositories for a topic (default `ai-agents`, created in the last 7 days), enriches the breakout ones with their README, and posts one digest to Discord.

`Schedule (1 h) / Webhook → Config → GitHub search → Top 5 (Code) → IF ≥ 500★ → README (true) · compact card (false) → Merge → Build digest → Discord`

## APIs and why
| API | Used for | Why |
|---|---|---|
| **GitHub Search API** `GET /search/repositories?q=topic:<t> created:>DATE&sort=stars` | first request | Free, no key, stable, and relevant to a dev team. GitHub has no official "trending" API; *created in the last 7 days + sorted by stars* is a reliable equivalent. |
| **GitHub README API** `GET /repos/{owner}/{repo}/readme` | enrichment (2nd endpoint of the same API, as the brief suggests) | Adds *what the project actually is* to the digest. Called **only for breakout repos** – that is what the IF decides. |
| **Discord webhook** | output | Free, a team channel, zero setup. The webhook URL is a secret, so it lives in an n8n credential. |

## Transformation (Code node "Top 5 repos")
Drops forks, archived repos and repos without a description → sorts by stars → keeps the top 5 → reshapes each to 8 fields and adds a computed **stars/day** (momentum) and a truncated description. "Breakout card" turns the Base64 README into a one-paragraph teaser (strips HTML, badges, links, language switchers). "Build digest" formats one Discord message: a header + 🔥 Breakout / 📈 Rising embeds, kept inside Discord's size limits.

**Why the threshold is 500 ★ in 7 days:** in the live data the #1–#2 new `ai-agents` repos had ~600–1,100 ★ and the rest of the top 5 ~200–470 ★, so 500 separates "breaking out" from "rising" – and it spends the extra README calls (unauthenticated GitHub limit: 60 / hour) only where they add value. All knobs (topic, days, threshold, top N) live in the **Config** node.

## Error handling – the workflow never fails silently
1. **Retries** on every HTTP/Discord node (3 tries, 2–3 s apart) absorb blips and brief rate limits.
2. **GitHub search fails** → the node's red **error output** builds an outage alert and posts it to Discord; the run ends as "degraded".
3. **A README call fails** → **Continue on fail**: the repo stays in the digest, marked "README unavailable".
4. **Anything unexpected** (0 repos returned, Discord down…) → the execution fails → the **Error Workflow** (Error Trigger) posts 🚨 *workflow · failed node · message · execution link* to Discord. n8n's Executions list keeps every failed run as a durable log. *(Found by testing: in n8n 2.x the Error Workflow must itself be **published**, otherwise n8n logs "…is not active and cannot be executed" and no alert is sent.)*

Tested end-to-end (`test-error-paths.mjs` → `test-results.md`, **5/5 pass**): happy path · GitHub down · one Discord 503 recovered by retry · Discord down → Error Workflow · 0 repos → Error Workflow.

## Credentials – nothing hard-coded
The Discord webhook URL and the webhook token are **n8n Credentials** (`Discord webhook – Morning Brief`, `Local webhook token`). The exported JSON only contains their names/IDs – verified that no secret value is in the file.

## Run it
```
powershell -ExecutionPolicy Bypass -File setup\start-n8n.ps1 -MockDiscord   # n8n on :5678 (+ local Discord stand-in)
node setup\provision-n8n.mjs                                               # owner, credentials, import + publish
powershell -ExecutionPolicy Bypass -File task2-n8n-workflow\test-webhook.ps1   # the curl happy-path test
```
Webhook: `GET /webhook/morning-brief` with header `X-Webhook-Token` · `?topic=n8n` (other topic) · `?simulate=github-down` (error path).
**Going live:** in n8n → *Credentials* → "Discord webhook – Morning Brief", paste your real webhook URL (Discord → channel settings → Integrations → Webhooks). The evidence runs used a local Discord stand-in (`setup/mock-discord.mjs`) that validates payloads against Discord's limits.
