# Bonus – uptime monitor test results

Run: 2026-09-29 23:50 IST · real outage (the Conduit API process was stopped and restarted) · Discord replaced by the local mock · **5/5 passed**

| Step | Result | Evidence |
|---|---|---|
| 1. Baseline: both targets up | ✅ PASS | Conduit web (frontend): UP (29 ms) \| Conduit API: UP (24 ms) |
| 2. API stopped, 2 overlapping checks -> exactly 1 DOWN alert | ✅ PASS | both checks done in 20.6s; alerts sent by the checks: 1 + 0; DOWN alerts received: 1; alert: 🔴 **Conduit API is DOWN** — ECONNREFUSED (confirmed after 3 attempts) http://localhost:3000/api/tags |
| 3. Still down -> no duplicate alert | ✅ PASS | alerts sent by this check: 0; DOWN alerts in total: 1 |
| 4. API back -> RECOVERED alert | ✅ PASS | Conduit web (frontend): UP (21 ms) \| Conduit API: UP (25 ms); alert: 🟢 **Conduit API recovered** — HTTP 200 in 25 ms after 1 min down |
| 5. Daily summary on demand | ✅ PASS | 📊 **Daily uptime report — Conduit** (since 29 Sep 23:35 IST) / 🟢 **Conduit web (frontend)** — 87.50% up (7/8 checks) · avg 22 ms · p95 29 ms · max 29 ms · 1 incident(s), 5 min down / 🟢 **Conduit API** — 50.00% up (4/8 checks) · avg 27 ms · p95 30 ms · max 30 ms · 1 incident(s), 1 min down |
