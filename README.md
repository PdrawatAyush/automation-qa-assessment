# Automation & QA assessment – Ayush Rawat

Everything here runs on my own Windows machine (Node 24, n8n 2.41.3).

## What's in the repo

| Folder | What it is |
|---|---|
| `task1-qa-report/` | QA report on the RealWorld "Conduit" app: the PDF, screenshots, and the tests that reproduce every bug |
| `task2-n8n-workflow/` | n8n workflow that posts an hourly GitHub digest to Discord, plus its README and tests |
| `bonus-uptime-monitor/` | n8n workflow that checks the Task 1 app every 5 minutes and alerts on downtime |
| `setup/` | Scripts to install and start everything |

## Task 1 – QA report
I tested Conduit (Angular frontend + Nitro/Prisma/SQLite backend). The live demo in the brief is offline (404), so I ran the same app locally. The only change I made was pointing the frontend at the local API.

I found **13 issues** (5 High, 6 Medium, 2 Low). Every one has an automated test, and the full run passes 16/16. The root-cause write-up is for issue #2: editing an article changes its URL, so old links break. I tried a small fix locally and confirmed it works.

Report: `task1-qa-report/Task1_QA_Report_AyushRawat.pdf`

## Task 2 – n8n workflow
Every hour (or through a token-protected webhook) it:
1. searches GitHub for the newest repos on a topic (`ai-agents`),
2. keeps the top 5,
3. for repos with 500+ stars, fetches the README,
4. posts one digest to Discord.

If something fails, it retries, falls back to an alert, or hands over to an error workflow. All 5 failure scenarios I tried pass. Secrets are in n8n credentials only. Details: `task2-n8n-workflow/README.md`.

## Bonus – uptime monitor
Checks the Conduit frontend and API every 5 minutes, retries 3 times before calling something down, tracks response times and sends a daily summary. I tested it by really stopping the API. That test found a bug where two overlapping checks both sent an alert; I fixed it (see the bonus README).

## Running it
```
powershell -ExecutionPolicy Bypass -File setup\setup-realworld.ps1
powershell -ExecutionPolicy Bypass -File setup\setup-n8n.ps1
powershell -ExecutionPolicy Bypass -File setup\start-realworld.ps1 -ResetDb
powershell -ExecutionPolicy Bypass -File setup\start-n8n.ps1 -MockDiscord
node setup\provision-n8n.mjs
```
The app runs on http://localhost:4200 and n8n on http://localhost:5678.

## Notes
- The recorded test runs used a small local stand-in for Discord (`setup/mock-discord.mjs`). To use real Discord, paste a webhook URL into the "Discord webhook – Morning Brief" credential in n8n.
- I used an AI assistant while working on this, as the brief allows, and I can explain every choice.
- No secrets are committed. Local ones are generated into `.local/`, which is git-ignored.
