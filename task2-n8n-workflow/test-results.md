# Task 2 – test results

Run: 2026-09-29T18:19:57.500Z · n8n 2.41.3 (local) · Discord replaced by the local mock (setup/mock-discord.mjs) · **5/5 passed**

| # | Scenario | What it proves | Result | Evidence |
|---|---|---|---|---|
| 1 | Happy path | GitHub search → top 5 → IF → README for breakout repos → digest to Discord | ✅ PASS | HTTP 200 in 1.6s → {"status":"digest sent","discordMessageId":"1300000000000000001","topic":"ai-agents","repos":5,"breakout":2,"rising":3,"executionId":"88"}; Discord got: "☀️ **Morning brief** — top 5 new GitHub repos tagged `ai-agents` (created in the last 7 da…" |
| 2 | GitHub API down | HTTP node retries 3×, then its error output posts an outage alert (no silent failure) | ✅ PASS | HTTP 200 in 4.5s (includes 2 × 2 s retry waits) → status "github unavailable – alert sent", GitHub said 403 "API rate limit exceeded for 103.203.255.82. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)"; Discord got: "⚠️ **Morning brief unavailable** — the GitHub search request failed after 3 atte…" |
| 3 | Discord hiccup | first Discord call gets 503; "Retry on fail" re-sends after 3 s | ✅ PASS | HTTP 200 in 4.7s → "digest sent" (message 1300000000000000003); 1 digest delivered after the injected 503 |
| 4 | Discord down | all 3 tries fail → execution fails → Error Workflow posts 🚨 alert with the execution link | ✅ PASS | webhook HTTP 500 ({"message":"Error in workflow"}); Error Workflow alert: "🚨 **Workflow failed: Morning Brief – trending GitHub repos** Node: **Discord: send digest** · mode: webhook · execution 91 > Service Unavailable (inj…" |
| 5 | No data | GitHub returns 0 repos → "Top 5 repos" throws on purpose → Error Workflow alert | ✅ PASS | webhook HTTP 500; Error Workflow alert: "🚨 **Workflow failed: Morning Brief – trending GitHub repos** Node: **Top 5 repos** · mode: webhook · execution 93 > GitHub returned no usable repositories for topic "zz-…" |
