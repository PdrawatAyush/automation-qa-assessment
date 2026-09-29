# Bonus – uptime monitor test results — BEFORE the fix (kept as evidence)

> First version: the up/down state lived in workflow static data. Two overlapping checks both sent a DOWN alert (step 2), and that duplicate also failed step 3. See README → "A real bug found (and fixed) by testing". Current results: test-results.md

Run: 2026-09-29 23:24 IST · real outage (the Conduit API process was stopped and restarted) · Discord replaced by the local mock · **3/5 passed**

| Step | Result | Evidence |
|---|---|---|
| 1. Baseline: both targets up | ✅ PASS | Conduit web (frontend): UP (26 ms) \| Conduit API: UP (26 ms) |
| 2. API stopped, 2 overlapping checks -> exactly 1 DOWN alert | ❌ FAIL | both checks done in 10.6s; alerts sent by the checks: 1 + 1; DOWN alerts received: 2; alert: 🔴 **Conduit API is DOWN** — ECONNREFUSED (confirmed after 3 attempts) http://localhost:3000/api/tags |
| 3. Still down -> no duplicate alert | ❌ FAIL | alerts sent by this check: 0; DOWN alerts in total: 2 |
| 4. API back -> RECOVERED alert | ✅ PASS | Conduit web (frontend): UP (22 ms) \| Conduit API: UP (25 ms); alert: 🟢 **Conduit API recovered** — HTTP 200 in 25 ms after under a minute down |
| 5. Daily summary on demand | ✅ PASS | 📊 **Daily uptime report — Conduit** (since 29 Sep 23:20 IST) / 🟢 **Conduit web (frontend)** — 100.00% up (4/4 checks) · avg 28 ms · p95 40 ms · max 40 ms · 0 incident(s), 0 min down / 🟢 **Conduit API** — 50.00% up (2/4 checks) · avg 26 ms · p95 26 ms · max 26 ms · 1 incident(s), 0 min down |
