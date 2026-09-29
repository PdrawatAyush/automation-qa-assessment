// API-level probes for the RealWorld (Conduit) backend.
// Each probe sends real HTTP requests and records what the server actually did,
// so every issue in the QA report is backed by reproducible evidence.
//
// Usage:  node api-probes.mjs [apiBase]      (default http://localhost:3000/api)
// Output: ../evidence/api-probes.json  +  a summary table on stdout
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.argv[2] ?? 'http://localhost:3000/api';
const here = dirname(fileURLToPath(import.meta.url));
const run = randomBytes(3).toString('hex'); // makes every run independent of earlier data
const pw = () => 'Qa!' + randomBytes(9).toString('base64url'); // throwaway test passwords
const results = [];

async function call(method, path, { body, token, raw } = {}) {
  const started = performance.now();
  const res = await fetch(raw ? path : API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Token ${token}` } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
  return { status: res.status, ms: Math.round(performance.now() - started), json };
}

function record(id, title, expected, observed, bug, details = {}) {
  results.push({ id, title, expected, observed, bug, ...details });
}

async function register(username, email, password) {
  return call('POST', '/users', { body: { user: { username, email, password } } });
}

// ---------------------------------------------------------------- P1 weak password
{
  const r = await register(`weakpw_${run}`, `weakpw_${run}@example.test`, 'a');
  const token = r.json?.user?.token;
  const upd = token ? await call('PUT', '/user', { token, body: { user: { password: 'b' } } }) : null;
  record('P1', 'Sign-up accepts a 1-character password',
    'Sign-up rejects weak passwords (settings already requires >= 8 chars)',
    `POST /users with password "a" -> ${r.status}; PUT /user with password "b" -> ${upd?.status} ${JSON.stringify(upd?.json)}`,
    r.status === 201, { signup: r, settingsUpdate: upd });
}

// ---------------------------------------------------------------- P2 invalid email
{
  const r = await register(`bademail_${run}`, `not-an-email-${run}`, pw());
  record('P2', 'Sign-up accepts an invalid e-mail address',
    '422 with an "email is invalid" message',
    `POST /users with email "not-an-email-${run}" -> ${r.status}, stored email = ${JSON.stringify(r.json?.user?.email)}`,
    r.status === 201, { response: r });
}

// ---------------------------------------------------------------- P3 e-mail case sensitivity
{
  const password = pw();
  const mixed = `Case.User_${run}@Example.test`;
  const reg = await register(`caseuser_${run}`, mixed, password);
  const loginLower = await call('POST', '/users/login', { body: { user: { email: mixed.toLowerCase(), password } } });
  const dup = await register(`caseuser2_${run}`, mixed.toLowerCase(), pw());
  record('P3', 'E-mail addresses are case-sensitive (login fails / duplicate accounts)',
    'Login with the same address in lower case succeeds; registering it again is rejected (409)',
    `register ${mixed} -> ${reg.status}; login as ${mixed.toLowerCase()} -> ${loginLower.status} ${JSON.stringify(loginLower.json)}; register ${mixed.toLowerCase()} again -> ${dup.status}`,
    loginLower.status === 401 && dup.status === 201, { reg, loginLower, dup });
}

// ---------------------------------------------------------------- P4 usernames with URL characters
{
  const names = [`qa?tester_${run}`, `qa/tester_${run}`, `qa#tester_${run}`, `qa tester_${run}`];
  const rows = [];
  for (const n of names) {
    const reg = await register(n, `${randomBytes(4).toString('hex')}_${run}@example.test`, pw());
    // The Angular ProfileService builds the URL with plain string concatenation: '/profiles/' + username
    const asFrontendDoes = await call('GET', `/profiles/${n}`);
    const encoded = await call('GET', `/profiles/${encodeURIComponent(n)}`);
    rows.push({ username: n, register: reg.status, unencodedGet: asFrontendDoes.status, unencodedProfile: asFrontendDoes.json?.profile?.username ?? asFrontendDoes.json, encodedGet: encoded.status });
  }
  record('P4', 'Usernames may contain URL-reserved characters (?, /, #, space)',
    'Username restricted to URL-safe characters (or always URL-encoded by clients)',
    rows.map(r => `"${r.username}": register ${r.register}, GET unencoded ${r.unencodedGet}, GET encoded ${r.encodedGet}`).join(' | '),
    rows.every(r => r.register === 201), { rows });
}

// ---------------------------------------------------------------- P5 brute force / rate limiting
{
  const password = pw();
  const email = `bruteforce_${run}@example.test`;
  await register(`bruteforce_${run}`, email, password);
  const statuses = {};
  const t0 = performance.now();
  const attempts = 30;
  for (let i = 0; i < attempts; i++) {
    const r = await call('POST', '/users/login', { body: { user: { email, password: `wrong-guess-${i}` } } });
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  }
  const seconds = ((performance.now() - t0) / 1000).toFixed(1);
  const finalOk = await call('POST', '/users/login', { body: { user: { email, password } } });
  record('P5', 'No rate limiting / lockout on failed logins',
    'After a handful of failures the API throttles (429) or locks the account temporarily',
    `${attempts} wrong passwords in ${seconds}s -> status counts ${JSON.stringify(statuses)}; correct password afterwards -> ${finalOk.status}`,
    !statuses[429] && finalOk.status === 200, { statuses, seconds: Number(seconds) });
}

// ---------------------------------------------------------------- P6 token lifetime / logout
{
  const password = pw();
  const email = `session_${run}@example.test`;
  const reg = await register(`session_${run}`, email, password);
  const token = reg.json?.user?.token;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const days = Math.round((payload.exp - payload.iat) / 86400);
  // "Log out" in the UI only deletes the token from localStorage - the server is never told.
  await new Promise(r => setTimeout(r, 1500)); // JWT iat/exp have 1-second resolution
  const afterLogout = await call('GET', '/user', { token });
  const minted = afterLogout.json?.user?.token;
  const mintedPayload = minted ? JSON.parse(Buffer.from(minted.split('.')[1], 'base64url').toString()) : null;
  record('P6', 'Logout does not invalidate the session token (60-day JWT, silently renewable)',
    'Logout revokes the token server-side; tokens are short-lived',
    `token lifetime = ${days} days; GET /user with the "logged-out" token -> ${afterLogout.status}; response contains a NEW token = ${Boolean(minted && minted !== token)} (expires ${mintedPayload ? new Date(mintedPayload.exp * 1000).toISOString() : 'n/a'})`,
    afterLogout.status === 200, { lifetimeDays: days });
}

// ---------------------------------------------------------------- P7 pagination parameters
{
  const neg = await call('GET', '/articles?offset=-1');
  const negLimit = await call('GET', '/articles?limit=-1');
  const nan = await call('GET', '/articles?offset=abc&limit=xyz');
  record('P7', 'Pagination parameters are not validated (negative offset -> 500)',
    '400/422 for invalid values',
    `offset=-1 -> ${neg.status} ${typeof neg.json === 'string' ? neg.json : JSON.stringify(neg.json).slice(0, 160)}; limit=-1 -> ${negLimit.status}; offset=abc&limit=xyz -> ${nan.status}`,
    neg.status >= 500, { neg, negLimit: { status: negLimit.status } });
}

// Author used for the article probes
const author = await register(`author_${run}`, `author_${run}@example.test`, pw());
const authorToken = author.json?.user?.token;

// ---------------------------------------------------------------- P8 slug changes on every edit
{
  const art = { title: `Slug stability ${run}`, description: 'desc', body: 'original body', tagList: [] };
  const created = await call('POST', '/articles', { token: authorToken, body: { article: art } });
  const oldSlug = created.json?.article?.slug;
  // The Angular editor always sends title+description+body+tagList, even if only the body changed.
  const edited = await call('PUT', `/articles/${oldSlug}`, { token: authorToken, body: { article: { ...art, body: 'fixed a typo in the body' } } });
  const newSlug = edited.json?.article?.slug;
  const oldLink = await call('GET', `/articles/${oldSlug}`);
  record('P8', 'Editing an article (even only its body) changes its URL; old links return 404',
    'Slug stays the same when the title is unchanged; old URLs keep working (or redirect)',
    `created slug "${oldSlug}"; after body-only edit slug = "${newSlug}"; GET old slug -> ${oldLink.status} ${JSON.stringify(oldLink.json)}`,
    oldSlug !== newSlug && oldLink.status === 404, { oldSlug, newSlug, oldLinkStatus: oldLink.status });
}

// ---------------------------------------------------------------- P9 duplicate tags
{
  const r = await call('POST', '/articles', { token: authorToken, body: { article: { title: `Dup tags ${run}`, description: 'd', body: 'b', tagList: [`dup${run}`, `dup${run}`] } } });
  record('P9', 'Duplicate tag in one article -> misleading error',
    'Duplicates silently de-duplicated (or a clear "duplicate tag" message)',
    `POST /articles with tagList ["dup${run}","dup${run}"] -> ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`,
    r.status !== 201, { response: r });
}

// ---------------------------------------------------------------- P10 whitespace tags
{
  const r = await call('POST', '/articles', { token: authorToken, body: { article: { title: `Space tags ${run}`, description: 'd', body: 'b', tagList: [`  padded${run}  `, `padded${run}`] } } });
  record('P10', 'Tags are not trimmed (" qa " and "qa" become different tags)',
    'Tags trimmed / normalised before saving',
    `POST /articles with tagList ["  padded${run}  ","padded${run}"] -> ${r.status}, saved tagList = ${JSON.stringify(r.json?.article?.tagList)}`,
    r.status === 201 && (r.json?.article?.tagList ?? []).some(t => t !== t.trim()), { response: r.json?.article?.tagList });
}

// ---------------------------------------------------------------- P11 very long title
{
  const longTitle = ('Longtitle' + run).repeat(2000); // ~ 20 000 characters, no spaces
  const created = await call('POST', '/articles', { token: authorToken, body: { article: { title: longTitle, description: 'd', body: 'b' } } });
  const slug = created.json?.article?.slug;
  const open = slug ? await call('GET', `/articles/${slug}`) : null;
  record('P11', `No length limits: a ${('Longtitle' + run).length * 2000}-character title creates an article that can never be opened`,
    'Title length validated (e.g. <= 200 chars) so every saved article is reachable',
    `POST title length ${longTitle.length} -> ${created.status} (slug length ${slug?.length}); GET /articles/<slug> -> ${open?.status} ${typeof open?.json === 'string' ? open.json.slice(0, 80) : ''}`,
    created.status === 201 && open && open.status !== 200, { createStatus: created.status, slugLength: slug?.length, openStatus: open?.status });
}

// ---------------------------------------------------------------- P12 very large body
{
  const big = 'x'.repeat(10 * 1024 * 1024); // 10 MB
  const r = await call('POST', '/articles', { token: authorToken, body: { article: { title: `Big body ${run}`, description: 'd', body: big } } });
  record('P12', 'No request-size limit (10 MB article body accepted)',
    'Request rejected with 413 above a sane limit (e.g. 1 MB)',
    `POST 10 MB body -> ${r.status} in ${r.ms} ms`,
    r.status === 201, { status: r.status, ms: r.ms });
}

// ---------------------------------------------------------------- P13 stored markup (checked in the UI later)
{
  const body = 'Hello <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> [link](javascript:window.__xss=3)';
  const r = await call('POST', '/articles', { token: authorToken, body: { article: { title: `Markup ${run}`, description: 'd', body } } });
  record('P13', 'HTML/JS in markdown body is stored verbatim (UI must sanitise it)',
    'Stored as-is is acceptable only if every client sanitises on render',
    `POST article with <img onerror>/<script>/javascript: link -> ${r.status}, slug ${r.json?.article?.slug}`,
    false, { slug: r.json?.article?.slug });
}

// ---------------------------------------------------------------- P14 follow yourself
{
  const r = await call('POST', `/profiles/${encodeURIComponent(`author_${run}`)}/follow`, { token: authorToken });
  record('P14', 'A user can follow themself',
    '422 "cannot follow yourself"',
    `POST /profiles/<self>/follow -> ${r.status}, following = ${r.json?.profile?.following}`,
    r.status === 200 && r.json?.profile?.following === true, { status: r.status });
}

// ---------------------------------------------------------------- P15 authorization (expected to hold)
{
  const intruder = await register(`intruder_${run}`, `intruder_${run}@example.test`, pw());
  const intruderToken = intruder.json?.user?.token;
  const owned = await call('POST', '/articles', { token: authorToken, body: { article: { title: `Owned ${run}`, description: 'd', body: 'original' } } });
  const slug = owned.json?.article?.slug;
  const comment = await call('POST', `/articles/${slug}/comments`, { token: authorToken, body: { comment: { body: 'author comment' } } });
  const put = await call('PUT', `/articles/${slug}`, { token: intruderToken, body: { article: { body: 'hacked' } } });
  const del = await call('DELETE', `/articles/${slug}`, { token: intruderToken });
  const delComment = await call('DELETE', `/articles/${slug}/comments/${comment.json?.comment?.id}`, { token: intruderToken });
  const still = await call('GET', `/articles/${slug}`);
  record('P15', 'Other users cannot edit/delete my article or my comment (authorization)',
    '403 for PUT/DELETE by another user; content unchanged',
    `PUT by another user -> ${put.status}; DELETE article -> ${del.status}; DELETE comment -> ${delComment.status}; article afterwards -> ${still.status}, body "${still.json?.article?.body}"`,
    !(put.status === 403 && del.status === 403 && delComment.status === 403 && still.json?.article?.body === 'original'), {});
}

// ---------------------------------------------------------------- P7b page size has no upper bound
{
  // Make sure there are more articles than the default page size (10), then ask for a huge page.
  for (let i = 0; i < 12; i++) await call('POST', '/articles', { token: authorToken, body: { article: { title: `Filler ${i} ${run}`, description: 'd', body: 'b' } } });
  const huge = await call('GET', '/articles?limit=100000');
  record('P7b', 'Page size (limit) has no upper bound',
    'limit capped (e.g. max 100) so one request cannot pull the whole table',
    `limit=100000 -> ${huge.status}, returned ${huge.json?.articles?.length} of ${huge.json?.articlesCount} articles in one response (default page = 10)`,
    huge.status === 200 && huge.json?.articles?.length === huge.json?.articlesCount && huge.json?.articlesCount > 10, { returned: huge.json?.articles?.length });
}

mkdirSync(join(here, '..', 'evidence'), { recursive: true });
const out = join(here, '..', 'evidence', 'api-probes.json');
// Never store session tokens in evidence files (they are credentials, even for test accounts).
const redactJwt = (_key, value) => (typeof value === 'string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value) ? '<redacted JWT>' : value);
writeFileSync(out, JSON.stringify({ api: API, run, executedAt: new Date().toISOString(), results }, redactJwt, 2));
for (const r of results) console.log(`${r.bug ? 'BUG ' : 'ok  '} ${r.id.padEnd(4)} ${r.title}\n      -> ${r.observed}\n`);
console.log(`Evidence written to ${out}`);
