// Local stand-in for a Discord webhook, so the n8n workflows can be tested end-to-end
// before a real Discord webhook URL is configured (and without spamming a real channel).
//
// It validates payloads against Discord's documented webhook limits (so formatting bugs are
// caught locally) and answers like Discord does for `?wait=true`.
//
//   POST http://localhost:5680/api/webhooks/<id>/<token>[?wait=true]   -> 200 message JSON (or 204)
//   POST http://localhost:5680/__fail?count=N                            -> next N webhook calls return 503
//   GET  http://localhost:5680/__messages                                -> everything received so far
//
// Every received payload is appended to .local/logs/mock-discord.jsonl
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_DISCORD_PORT ?? 5680);
const logDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'logs');
const logFile = join(logDir, 'mock-discord.jsonl');
mkdirSync(logDir, { recursive: true });

const messages = [];
let failNext = 0;
let nextId = 1_300_000_000_000_000_000n;

// Discord limits: https://discord.com/developers/docs/resources/message#embed-object-embed-limits
function validate(body) {
  const errors = [];
  if (!body || (typeof body.content !== 'string' && !Array.isArray(body.embeds))) errors.push('message must have content or embeds');
  if (typeof body?.content === 'string' && body.content.length > 2000) errors.push(`content is ${body.content.length} chars (max 2000)`);
  const embeds = body?.embeds ?? [];
  if (embeds.length > 10) errors.push(`${embeds.length} embeds (max 10)`);
  let total = 0;
  embeds.forEach((e, i) => {
    if ((e.title ?? '').length > 256) errors.push(`embeds[${i}].title > 256`);
    if ((e.description ?? '').length > 4096) errors.push(`embeds[${i}].description is ${e.description.length} chars (max 4096)`);
    if ((e.fields ?? []).length > 25) errors.push(`embeds[${i}] has > 25 fields`);
    (e.fields ?? []).forEach((f, j) => {
      if (!f.name || !f.value) errors.push(`embeds[${i}].fields[${j}] needs name and value`);
      if ((f.name ?? '').length > 256 || (f.value ?? '').length > 1024) errors.push(`embeds[${i}].fields[${j}] too long`);
    });
    if ((e.footer?.text ?? '').length > 2048) errors.push(`embeds[${i}].footer.text > 2048`);
    total += (e.title ?? '').length + (e.description ?? '').length + (e.footer?.text ?? '').length + (e.author?.name ?? '').length
      + (e.fields ?? []).reduce((n, f) => n + (f.name ?? '').length + (f.value ?? '').length, 0);
  });
  if (total > 6000) errors.push(`embeds total ${total} chars (max 6000)`);
  return errors;
}

const send = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(obj === undefined ? undefined : JSON.stringify(obj));
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    if (url.pathname === '/__messages') return send(res, 200, messages);
    if (url.pathname === '/__fail') { failNext = Number(url.searchParams.get('count') ?? 1); return send(res, 200, { failNext }); }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/webhooks/')) return send(res, 404, { message: '404: Not Found', code: 0 });

    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { message: 'The request body contains invalid JSON.', code: 50109 }); }
    const receivedAt = new Date().toISOString();
    if (failNext > 0) {
      failNext--;
      appendFileSync(logFile, JSON.stringify({ receivedAt, status: 503, injectedFailure: true }) + '\n');
      return send(res, 503, { message: 'Service Unavailable (injected by mock)', code: 0 });
    }
    const errors = validate(body);
    if (errors.length) {
      appendFileSync(logFile, JSON.stringify({ receivedAt, status: 400, errors, body }) + '\n');
      return send(res, 400, { message: 'Invalid Form Body', code: 50035, errors });
    }
    const message = {
      id: String(nextId++), type: 0, channel_id: '1000000000000000001', webhook_id: url.pathname.split('/')[3] ?? 'mock',
      content: body.content ?? '', embeds: body.embeds ?? [], author: { bot: true, id: 'mock', username: body.username ?? 'Mock Webhook' },
      timestamp: receivedAt, edited_timestamp: null, tts: false, mention_everyone: false, pinned: false, flags: 0, _mock: true,
    };
    messages.push(message);
    appendFileSync(logFile, JSON.stringify({ receivedAt, status: 200, body }) + '\n');
    console.log(`[mock-discord] ${receivedAt} message ${message.id}: ${(body.content ?? '').split('\n')[0].slice(0, 100)}`);
    return url.searchParams.get('wait') === 'true' ? send(res, 200, message) : send(res, 204);
  });
}).listen(PORT, () => console.log(`[mock-discord] listening on http://localhost:${PORT}`));
