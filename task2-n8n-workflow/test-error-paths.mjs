// End-to-end tests of every path through the Morning Brief workflow, including failures.
// Needs: n8n running + provisioned, and the Discord mock (setup/start-n8n.ps1 -MockDiscord).
//   node task2-n8n-workflow/test-error-paths.mjs
// Writes the results to task2-n8n-workflow/test-results.md
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const secrets = JSON.parse(readFileSync(join(here, '..', '.local', 'n8n-local.json'), 'utf8'));
const N8N = 'http://localhost:5678';
const MOCK = 'http://localhost:5680';
const pause = ms => new Promise(r => setTimeout(r, ms));

async function brief(query = '') {
  const t0 = Date.now();
  const res = await fetch(`${N8N}/webhook/morning-brief${query}`, { headers: { 'X-Webhook-Token': secrets.webhookToken } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, seconds: ((Date.now() - t0) / 1000).toFixed(1) };
}
const mockMessages = async () => (await fetch(`${MOCK}/__messages`)).json();
async function newMessagesAfter(before, waitMs = 0) {
  if (waitMs) await pause(waitMs);
  return (await mockMessages()).slice(before);
}

const results = [];
function check(name, what, pass, evidence) {
  results.push({ name, what, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${evidence}\n`);
}

// 1. Happy path
{
  const before = (await mockMessages()).length;
  const r = await brief();
  const msgs = await newMessagesAfter(before);
  check('1. Happy path', 'GitHub search → top 5 → IF → README for breakout repos → digest to Discord',
    r.status === 200 && r.json.status === 'digest sent' && msgs.some(m => m.content.startsWith('☀️')),
    `HTTP ${r.status} in ${r.seconds}s → ${JSON.stringify(r.json)}; Discord got: "${msgs[0]?.content.slice(0, 90)}…"`);
}
await pause(7000); // stay well inside GitHub's unauthenticated search limit (10/min)

// 2. GitHub search fails (real 404 from GitHub) → error output → outage alert
{
  const before = (await mockMessages()).length;
  const r = await brief('?simulate=github-down');
  const msgs = await newMessagesAfter(before);
  check('2. GitHub API down', 'HTTP node retries 3×, then its error output posts an outage alert (no silent failure)',
    r.status === 200 && r.json.status?.startsWith('github unavailable') && msgs.some(m => m.content.startsWith('⚠️')),
    `HTTP ${r.status} in ${r.seconds}s (includes 2 × 2 s retry waits) → status "${r.json.status}", GitHub said ${r.json.httpStatus} "${r.json.error}"; Discord got: "${msgs[0]?.content.slice(0, 80)}…"`);
}
await pause(7000);

// 3. Discord hiccup (one 503) → node-level retry succeeds, digest still delivered
{
  await fetch(`${MOCK}/__fail?count=1`, { method: 'POST' });
  const before = (await mockMessages()).length;
  const r = await brief();
  const msgs = await newMessagesAfter(before);
  check('3. Discord hiccup', 'first Discord call gets 503; "Retry on fail" re-sends after 3 s',
    r.status === 200 && r.json.status === 'digest sent' && msgs.length === 1,
    `HTTP ${r.status} in ${r.seconds}s → "${r.json.status}" (message ${r.json.discordMessageId}); 1 digest delivered after the injected 503`);
}
await pause(7000);

// 4. Discord down (3 × 503) → workflow fails → Error Workflow alerts
{
  await fetch(`${MOCK}/__fail?count=3`, { method: 'POST' });
  const before = (await mockMessages()).length;
  const r = await brief();
  const msgs = await newMessagesAfter(before, 5000); // error workflow runs asynchronously
  const alert = msgs.find(m => m.content.startsWith('🚨'));
  check('4. Discord down', 'all 3 tries fail → execution fails → Error Workflow posts 🚨 alert with the execution link',
    r.status >= 500 && !!alert && /Discord: send digest/.test(alert.content),
    `webhook HTTP ${r.status} (${typeof r.json === 'string' ? r.json.slice(0, 60) : JSON.stringify(r.json).slice(0, 80)}); Error Workflow alert: "${alert?.content.replace(/\n/g, ' ').slice(0, 150)}…"`);
}
await pause(7000);

// 5. Unexpected data: topic with no repos → Code node throws → Error Workflow alerts
{
  const before = (await mockMessages()).length;
  const r = await brief('?topic=zz-no-such-topic-zz');
  const msgs = await newMessagesAfter(before, 5000);
  const alert = msgs.find(m => m.content.startsWith('🚨'));
  check('5. No data', 'GitHub returns 0 repos → "Top 5 repos" throws on purpose → Error Workflow alert',
    r.status >= 500 && !!alert && /Top 5 repos/.test(alert.content),
    `webhook HTTP ${r.status}; Error Workflow alert: "${alert?.content.replace(/\n/g, ' ').slice(0, 170)}…"`);
}

const passed = results.filter(r => r.pass).length;
const md = [
  '# Task 2 – test results', '',
  `Run: ${new Date().toISOString()} · n8n 2.41.3 (local) · Discord replaced by the local mock (setup/mock-discord.mjs) · **${passed}/${results.length} passed**`, '',
  '| # | Scenario | What it proves | Result | Evidence |', '|---|---|---|---|---|',
  ...results.map(r => `| ${r.name.split('.')[0]} | ${r.name.split('. ')[1]} | ${r.what} | ${r.pass ? '✅ PASS' : '❌ FAIL'} | ${r.evidence.replace(/\|/g, '\\|')} |`),
  '',
].join('\n');
writeFileSync(join(here, 'test-results.md'), md);
console.log(`${passed}/${results.length} passed – written to task2-n8n-workflow/test-results.md`);
process.exit(passed === results.length ? 0 : 1);
