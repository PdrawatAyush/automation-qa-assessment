# Bonus – Uptime Monitor for the Task 1 app

**Deliverables:** `Bonus_UptimeMonitor_AyushRawat.json` (exported with n8n's *Download* menu) · `screenshots/1-workflow-canvas.png` (+ `2-latest-execution.png`) · `test-outage.ps1` → `test-results.md` (**5/5 pass**).

**What it does:** every 5 minutes it sends `GET` to the Conduit app tested in Task 1 – the **frontend** (`http://localhost:4200/`) and the **API** (`http://localhost:3000/api/tags`). Anything other than **HTTP 200** counts as DOWN, and the alert goes to the **same Discord channel/credential as Task 2**. Failures of the monitor itself go to the shared Error Workflow.

`Schedule (5 min) → Targets → Loop (1 at a time): stamp time → HTTP check → measure → Read state → Decide & alert → Save state → IF alert? → Discord`

## The three bonus points
| Bonus | How |
|---|---|
| **Retry logic** | The HTTP node retries 3× (5 s apart) before a check counts as DOWN, so one-off blips never page anyone. |
| **Response-time tracking** | Each target is checked on its own inside a loop: *stamp start → request → measure*, so every target gets its own time (not the slowest of the batch). Stored per target. |
| **Daily summary** | 09:00 IST: uptime %, avg / p95 / max response time, incidents and minutes down per target, then a new reporting period starts. |

**Alerting without spam:** it alerts on **changes** – 🔴 DOWN once, a reminder every 30 min while still down, 🟢 RECOVERED with the downtime – instead of 12 identical alerts per hour.

## A real bug found (and fixed) by testing
`test-outage.ps1` really stops the Conduit API process, fires **two checks at the same time** (like a manual check overlapping the scheduled one), restarts the API and asks for the report.
1. **First version** kept its state in n8n *workflow static data* → the two overlapping checks **both** sent a DOWN alert (`test-results-before-fix.md`, 3/5).
2. **First fix attempt** – serialize production runs (`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`) – the runs did execute one after the other (20.7 s), **but both still alerted**. Root cause: n8n loads a workflow's static data when the execution is *created*, so the queued run decided on a stale snapshot.
3. **Fix:** the state now lives in an n8n **Data Table** (`uptime_state`), read when the node runs, *and* production runs are serialized. Result: **1 + 0 alerts**, exactly one DOWN and one RECOVERED message (`test-results.md`, 5/5).

## Run it
```
powershell -ExecutionPolicy Bypass -File setup\start-realworld.ps1          # the app being monitored
powershell -ExecutionPolicy Bypass -File setup\start-n8n.ps1 -MockDiscord    # n8n (+ local Discord stand-in)
node setup\provision-n8n.mjs                                                # creates the Data Table, imports + publishes
powershell -ExecutionPolicy Bypass -File bonus-uptime-monitor\test-outage.ps1   # real outage test
```
On-demand hooks (header `X-Webhook-Token`, token in `.local/n8n-local.json`): `GET /webhook/uptime-check`, `GET /webhook/uptime-report`.
