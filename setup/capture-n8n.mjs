// Captures the n8n evidence for the submission: screenshots + workflow exports made through
// n8n's own "Download" menu (as the brief asks). Re-run it any time, e.g. after connecting a real
// Discord webhook, to refresh the evidence.
//
//   node setup/capture-n8n.mjs            # everything
//   node setup/capture-n8n.mjs task2      # Task 2 only   |   bonus = uptime monitor only
//
// Needs: n8n running + provisioned (setup/start-n8n.ps1, setup/provision-n8n.mjs).
// Uses the Playwright install from task1-qa-report/qa-tests (npm install there first).
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'task1-qa-report', 'qa-tests', 'package.json'));
const { chromium } = require('@playwright/test');
const secrets = JSON.parse(readFileSync(join(root, '.local', 'n8n-local.json'), 'utf8'));
const N8N = 'http://localhost:5678';
const what = process.argv[2] ?? 'all';

// ---------------------------------------------------------------- REST (to look up ids / executions)
let cookie = '';
async function rest(method, path, body) {
  const res = await fetch(`${N8N}/rest${path}`, { method, headers: { 'content-type': 'application/json', 'browser-id': secrets.browserId, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const c = (res.headers.getSetCookie?.() ?? []).find(x => x.startsWith('n8n-auth=')); if (c) cookie = c.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return json.data ?? json;
}
await rest('POST', '/login', { emailOrLdapLoginId: secrets.owner.email, password: secrets.owner.password });
const workflows = await rest('GET', '/workflows');
const idOf = name => workflows.find(w => w.name === name)?.id;

// ---------------------------------------------------------------- browser helpers
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
const page = await context.newPage();
await page.goto(`${N8N}/signin`);
await page.locator('input[type="email"], input[name="emailOrLdapLoginId"]').first().fill(secrets.owner.email);
await page.locator('input[type="password"]').first().fill(secrets.owner.password);
await page.locator('button:has-text("Sign in")').first().click();
await page.waitForURL(u => !u.pathname.startsWith('/signin'));

async function open(url) {
  await page.goto(url);
  await page.waitForTimeout(3500);
  const close = page.locator('[data-test-id="suggested-actions-close"]');
  if (await close.isVisible().catch(() => false)) { await close.click(); await page.waitForTimeout(500); }
}
async function shot(file) {
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  console.log('screenshot:', file.replace(root, '.'));
}
async function download(workflowId, file) {
  await open(`${N8N}/workflow/${workflowId}`);
  await page.locator('[data-test-id="workflow-menu"]').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('li:has-text("Download"), [data-test-id="workflow-menu-item-download"]').first().click()]);
  await dl.saveAs(file);
  console.log(`exported via n8n "Download" menu: ${file.replace(root, '.')}`);
}
async function openNode(name) {
  await page.locator('.vue-flow__node', { hasText: name }).first().dblclick();
  await page.waitForTimeout(1500);
}
async function webhook(query = '') {
  const res = await fetch(`${N8N}/webhook/morning-brief${query}`, { headers: { 'X-Webhook-Token': secrets.webhookToken } });
  return res.json();
}

// ---------------------------------------------------------------- Task 2
if (what === 'all' || what === 'task2') {
  const dir = join(root, 'task2-n8n-workflow');
  const mainId = idOf('Morning Brief – trending GitHub repos');
  const errId = idOf('Error Handler – alerts for failed workflows');
  const ok = await webhook();                          // fresh successful production run
  if (ok.status !== 'digest sent') throw new Error('happy-path run failed: ' + JSON.stringify(ok));
  await new Promise(r => setTimeout(r, 7000));         // be gentle with GitHub's search rate limit
  const degraded = await webhook('?simulate=github-down');

  await open(`${N8N}/workflow/${mainId}`);
  await shot(join(dir, 'screenshots', '1-workflow-canvas.png'));

  await open(`${N8N}/workflow/${mainId}/executions/${ok.executionId}`);
  await shot(join(dir, 'screenshots', '2-successful-execution.png'));
  await openNode('Build digest');
  const json = page.locator('[data-test-id="ndv-output-panel"] :text-is("JSON"), [data-test-id="ndv-output-panel"] label:has-text("JSON")').first();
  if (await json.isVisible().catch(() => false)) { await json.click(); await page.waitForTimeout(800); }
  await shot(join(dir, 'screenshots', '3-execution-output-data.png'));

  await open(`${N8N}/workflow/${mainId}/executions/${degraded.executionId}`);
  await shot(join(dir, 'screenshots', '4-error-path-execution.png'));

  await open(`${N8N}/workflow/${errId}`);
  await shot(join(dir, 'screenshots', '5-error-workflow-canvas.png'));

  await download(mainId, join(dir, 'Task2_Workflow_AyushRawat.json'));
  await download(errId, join(dir, 'Task2_ErrorHandler_AyushRawat.json'));
}

// ---------------------------------------------------------------- Bonus
if (what === 'all' || what === 'bonus') {
  const dir = join(root, 'bonus-uptime-monitor');
  const monId = idOf('Bonus – Uptime Monitor (Conduit)');
  if (!monId) console.log('bonus workflow not provisioned yet - skipped');
  else {
    await open(`${N8N}/workflow/${monId}`);
    await shot(join(dir, 'screenshots', '1-workflow-canvas.png'));
    const execs = await rest('GET', `/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId: monId }))}&limit=20`);
    const list = execs.results ?? execs;
    const last = list.find(e => e.status === 'success');
    if (last) { await open(`${N8N}/workflow/${monId}/executions/${last.id}`); await shot(join(dir, 'screenshots', '2-latest-execution.png')); }
    await download(monId, join(dir, 'Bonus_UptimeMonitor_AyushRawat.json'));
  }
}
await browser.close();
