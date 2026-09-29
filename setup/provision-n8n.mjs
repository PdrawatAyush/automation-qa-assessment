// Provisions the local n8n instance (idempotent - safe to run again):
//   1. owner account (first run only)          2. credentials (Discord webhook, webhook token)
//   3. imports / updates the workflow JSON files from this repo, wires the Error Workflow, publishes them
//
//   node setup/provision-n8n.mjs            # n8n must be running on http://localhost:5678
//
// Local-only test secrets (owner login, webhook token) are generated on the first run and stored in
// .local/n8n-local.json (git-ignored). The Discord credential points to the local mock
// (setup/mock-discord.mjs) unless DISCORD_WEBHOOK_URL is set in the environment - or you can simply
// paste your real webhook URL into the credential in the n8n UI.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.N8N_URL ?? 'http://localhost:5678';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const secretsFile = join(root, '.local', 'n8n-local.json');
const MOCK_DISCORD = 'http://localhost:5680/api/webhooks/1000000000000000001/local-mock-token';
const ERROR_HANDLER_NAME = 'Error Handler – alerts for failed workflows';
const WORKFLOW_FILES = [ // error handler first: the others reference its id
  'task2-n8n-workflow/Task2_ErrorHandler_AyushRawat.json',
  'task2-n8n-workflow/Task2_Workflow_AyushRawat.json',
  'bonus-uptime-monitor/Bonus_UptimeMonitor_AyushRawat.json',
];

// ---------------------------------------------------------------- local secrets
const secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {
  owner: { email: 'ayush.rawat@example.com', firstName: 'Ayush', lastName: 'Rawat', password: `Local-${randomBytes(9).toString('base64url')}-7Q` },
  webhookToken: randomBytes(24).toString('base64url'),
  browserId: randomUUID(),
};
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));

// ---------------------------------------------------------------- REST helper (session cookie)
let cookie = '';
async function rest(method, path, body) {
  const res = await fetch(`${BASE}/rest${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'browser-id': secrets.browserId, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const auth = setCookie.find(c => c.startsWith('n8n-auth='));
  if (auth) cookie = auth.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json?.data ?? json;
}

// ---------------------------------------------------------------- 1. owner + login
const settings = await rest('GET', '/settings');
if (settings.userManagement?.showSetupOnFirstLoad) {
  await rest('POST', '/owner/setup', secrets.owner);
  console.log('owner account created (login saved in .local/n8n-local.json)');
}
await rest('POST', '/login', { emailOrLdapLoginId: secrets.owner.email, password: secrets.owner.password });

// ---------------------------------------------------------------- 2. credentials
const wanted = [
  { name: 'Discord webhook – Morning Brief', type: 'discordWebhookApi', data: { webhookUri: process.env.DISCORD_WEBHOOK_URL || MOCK_DISCORD }, updateIf: !!process.env.DISCORD_WEBHOOK_URL },
  { name: 'Local webhook token', type: 'httpHeaderAuth', data: { name: 'X-Webhook-Token', value: secrets.webhookToken } },
];
const existingCreds = await rest('GET', '/credentials');
const credIds = {};
for (const c of wanted) {
  const found = existingCreds.find(e => e.name === c.name && e.type === c.type);
  if (!found) {
    credIds[c.name] = (await rest('POST', '/credentials', { name: c.name, type: c.type, data: c.data })).id;
    console.log(`credential created: ${c.name}${c.type === 'discordWebhookApi' ? (process.env.DISCORD_WEBHOOK_URL ? ' (real Discord webhook)' : ' (local mock)') : ''}`);
  } else {
    credIds[c.name] = found.id;
    if (c.updateIf) { await rest('PATCH', `/credentials/${found.id}`, { name: c.name, type: c.type, data: c.data }); console.log(`credential updated: ${c.name}`); }
  }
}

// ---------------------------------------------------------------- 3. data table for the uptime monitor's state
// (read at run time; workflow static data is snapshotted when an execution is created - see bonus README)
const project = await rest('GET', '/projects/personal');
const tables = await rest('GET', `/projects/${project.id}/data-tables`);
const tableList = Array.isArray(tables) ? tables : (tables.data ?? []);
if (!tableList.some(t => t.name === 'uptime_state')) {
  await rest('POST', `/projects/${project.id}/data-tables`, { name: 'uptime_state', columns: [{ name: 'key', type: 'string' }, { name: 'state', type: 'string' }] });
  console.log('data table created: uptime_state (key, state)');
}

// ---------------------------------------------------------------- 4. workflows
const existingWfs = await rest('GET', '/workflows');
let errorHandlerId = existingWfs.find(w => w.name === ERROR_HANDLER_NAME)?.id;
for (const file of WORKFLOW_FILES) {
  const path = join(root, file);
  if (!existsSync(path)) { console.log(`skipped (not built yet): ${file}`); continue; }
  const src = JSON.parse(readFileSync(path, 'utf8'));
  const wf = { name: src.name, nodes: src.nodes, connections: src.connections, settings: { ...(src.settings ?? {}) }, pinData: {} };
  for (const n of wf.nodes) for (const [type, ref] of Object.entries(n.credentials ?? {})) {
    if (!credIds[ref.name]) throw new Error(`${file}: node "${n.name}" needs unknown credential "${ref.name}"`);
    n.credentials[type] = { id: credIds[ref.name], name: ref.name };
  }
  if (wf.settings.errorWorkflow) wf.settings.errorWorkflow = errorHandlerId;

  const current = (await rest('GET', '/workflows')).find(w => w.name === wf.name);
  let saved;
  if (current) {
    const full = await rest('GET', `/workflows/${current.id}`);
    saved = await rest('PATCH', `/workflows/${current.id}`, { ...wf, versionId: full.versionId });
  } else {
    saved = await rest('POST', '/workflows', wf);
  }
  if (wf.name === ERROR_HANDLER_NAME) errorHandlerId = saved.id;

  // n8n 2.x only runs PUBLISHED workflows from triggers - including the Error Workflow
  // (otherwise n8n logs: 'Workflow "<id>" is not active and cannot be executed').
  const hasActivatableTrigger = wf.nodes.some(n => /scheduleTrigger|webhook$|errorTrigger/i.test(n.type));
  if (hasActivatableTrigger) {
    const full = await rest('GET', `/workflows/${saved.id}`);
    await rest('POST', `/workflows/${saved.id}/activate`, { versionId: full.versionId });
  }
  console.log(`workflow ${current ? 'updated' : 'created'}${hasActivatableTrigger ? ' + published' : ''}: ${wf.name} (id ${saved.id})`);
}
console.log(`\nEditor: ${BASE}   (login: see .local/n8n-local.json)`);
