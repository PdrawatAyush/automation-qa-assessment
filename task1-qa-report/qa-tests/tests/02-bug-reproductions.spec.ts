import { test, expect, Page } from '@playwright/test';
import { API, apiCall, createArticleViaApi, newUser, registerViaApi, shot, signInWithToken } from './helpers';

// Reproduction tests: each one asserts the CURRENT (buggy) behaviour, so a green run means
// "bug confirmed". The title says what SHOULD happen. After a fix, invert the final
// assertion and the test becomes a regression test. IDs match the QA report table.

/** Page rendered no content and no error text (only header + footer). */
async function expectBlankPage(page: Page) {
  await page.waitForTimeout(1_000);
  await expect(page.locator('.article-page h1, .profile-page .user-info')).toHaveCount(0);
  await expect(page.locator('.error-messages li')).toHaveCount(0);
}

test('[BUG-01] Feed shows "Loading articles..." forever when the API fails (expected: error + retry)', async ({ page }) => {
  // Simulate a backend outage / network drop for every API call.
  await page.route(`${API}/**`, route => route.abort('connectionrefused'));
  await page.goto('/');
  await page.waitForTimeout(10_000); // a user would have given up long before this
  await expect(page.getByText('Loading articles...')).toBeVisible();
  await expect(page.locator('.error-messages li')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /retry|try again/i })).toHaveCount(0);
  await shot(page, 'bug01-feed-loading-forever', 'API unreachable: 10 s later still "Loading articles..." - no error, no retry');
});

test('[BUG-02] Editing only the body changes the article URL; old links break (expected: URL stays the same)', async ({ page }) => {
  const u = await registerViaApi(newUser('edit'));
  const article = await createArticleViaApi(u.token, { title: 'Our release notes', body: 'Version 1 of the body' });
  await signInWithToken(page, u.token);

  await page.goto(`/article/${article.slug}`);
  await expect(page.locator('h1')).toHaveText('Our release notes');
  await shot(page, 'bug02-a-original-url', 'Original article URL (the link authors share)');

  await page.goto(`/editor/${article.slug}`);
  await expect(page.locator('input[name="title"]')).toHaveValue('Our release notes');
  await page.fill('textarea[name="body"]', 'Version 2 - only fixed a typo in the body');
  await page.click('button:has-text("Publish Article")');
  await page.waitForURL(/\/article\//);
  const newSlug = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  expect(newSlug).not.toBe(article.slug); // the URL changed although the title did not
  await expect(page.locator('h1')).toHaveText('Our release notes');
  await expect(page.locator('.article-content')).toContainText('Version 2');
  await shot(page, 'bug02-b-new-url-after-edit', 'After a body-only edit the SAME article now lives at a NEW URL (compare the suffix)');

  // Someone opens the link that was shared earlier.
  const apiAnswer = page.waitForResponse(r => r.url().endsWith(`/api/articles/${article.slug}`));
  await page.goto(`/article/${article.slug}`);
  expect((await apiAnswer).status()).toBe(404);
  await expectBlankPage(page);
  await shot(page, 'bug02-c-old-link-broken', 'The link shared before the edit is dead (API 404) - and the page is simply blank');
});

test('[BUG-03] Logging out does not end the session on the server (expected: token revoked)', async ({ page }) => {
  const u = newUser('logout');
  await registerViaApi(u);
  await page.goto('/login');
  await page.fill('input[name="email"]', u.email);
  await page.fill('input[name="password"]', u.password);
  await page.click('button[type="submit"]');
  await expect(page.locator('.navbar')).toContainText(u.username);
  const token = await page.evaluate(() => window.localStorage.getItem('jwtToken'));
  expect(token).toBeTruthy();

  await page.click('a[href="/settings"]');
  await page.click('button:has-text("Or click here to logout")');
  await expect(page.locator('.navbar')).toContainText('Sign in');
  expect(await page.evaluate(() => window.localStorage.getItem('jwtToken'))).toBeNull(); // only removed in the browser

  await page.waitForTimeout(1_500); // JWT timestamps have 1-second resolution
  const afterLogout = await apiCall('GET', '/user', undefined, token!);
  expect(afterLogout.status).toBe(200); // the "logged out" token still works...
  const expOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000;
  expect(expOf(token!) - Date.now()).toBeGreaterThan(59 * 24 * 3600 * 1000); // valid for 60 days
  expect(expOf(afterLogout.json.user.token)).toBeGreaterThan(expOf(token!)); // ...and mints a fresh, later-expiring one
});

test('[BUG-04] Unlimited password guessing - no rate limit or lockout (expected: 429 / temporary lock)', async () => {
  const u = await registerViaApi(newUser('brute'));
  const statuses: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    statuses.push((await apiCall('POST', '/users/login', { user: { email: u.email, password: `guess-${i}` } })).status);
  }
  const seconds = (Date.now() - t0) / 1000;
  expect(new Set(statuses)).toEqual(new Set([401])); // 30 wrong guesses, never throttled
  expect((await apiCall('POST', '/users/login', { user: { email: u.email, password: u.password } })).status).toBe(200); // not locked
  console.log(`30 wrong passwords in ${seconds.toFixed(1)} s, all answered 401, account still unlocked`);
});

test('[BUG-05] Sign-up accepts an invalid e-mail and a 1-character password (expected: validation errors)', async ({ page }) => {
  const u = newUser('weak');
  await page.goto('/register');
  await page.fill('input[name="username"]', u.username);
  await page.fill('input[name="email"]', `not-an-email-${u.username}`);
  await page.fill('input[name="password"]', 'a');
  await shot(page, 'bug05-a-weak-signup-form', 'Sign-up form: e-mail "not-an-email-...", password "a"');
  await page.click('button[type="submit"]');
  await expect(page.locator('.navbar')).toContainText(u.username); // account created and logged in
  await shot(page, 'bug05-b-weak-signup-accepted', 'Account created and logged in - no validation at all');
  // Inconsistent rules: the Settings page (same API) does require 8+ characters.
  const token = await page.evaluate(() => window.localStorage.getItem('jwtToken'));
  const change = await apiCall('PUT', '/user', { user: { password: 'b' } }, token!);
  expect(change.status).toBe(422);
  expect(change.json).toEqual({ errors: { password: ['must be at least 8 characters long'] } });
});

test('[BUG-06] "Not found" / load errors render a completely blank page (expected: a clear message)', async ({ page }) => {
  const apiAnswer = page.waitForResponse(r => r.url().includes('/api/articles/this-article-does-not-exist'));
  await page.goto('/article/this-article-does-not-exist');
  const res = await apiAnswer;
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ errors: { article: ['not found'] } }); // the API DID send a message...
  await expectBlankPage(page); // ...but the UI drops it
  await shot(page, 'bug06-blank-not-found-page', 'API answered 404 {"errors":{"article":["not found"]}} but the user sees a blank page');
});

test('[BUG-07a] "Delete Article" deletes instantly with no confirmation (expected: confirm step)', async ({ page }) => {
  const u = await registerViaApi(newUser('del'));
  const article = await createArticleViaApi(u.token, { title: 'Important article' });
  await signInWithToken(page, u.token);
  let dialogShown = false;
  page.on('dialog', d => { dialogShown = true; void d.dismiss(); });

  await page.goto(`/article/${article.slug}`);
  await expect(page.locator('h1')).toHaveText('Important article');
  await shot(page, 'bug07-a-before-delete', 'One click on "Delete Article"...');
  await page.locator('button:has-text("Delete Article")').first().click();
  await page.waitForURL(url => new URL(url).pathname === '/');
  expect(dialogShown).toBe(false);
  expect((await apiCall('GET', `/articles/${article.slug}`)).status).toBe(404); // gone for good
  await page.goto(`/profile/${u.username}`);
  await expect(page.locator('.article-preview')).toContainText('No articles are here');
  await shot(page, 'bug07-b-after-delete', '...and it is permanently gone (author profile: no articles) - no "Are you sure?", no undo');
});

test('[BUG-07b] A failed delete gives the user no feedback (expected: error message)', async ({ page }) => {
  const u = await registerViaApi(newUser('delfail'));
  const article = await createArticleViaApi(u.token, { title: 'Delete that fails' });
  await signInWithToken(page, u.token);
  await page.route(`${API}/articles/${article.slug}`, route =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"errors":{"server":["temporarily unavailable"]}}' })
      : route.continue());

  await page.goto(`/article/${article.slug}`);
  await page.locator('button:has-text("Delete Article")').first().click();
  await page.waitForTimeout(3_000);
  expect(new URL(page.url()).pathname).toBe(`/article/${article.slug}`); // still here
  await expect(page.locator('.error-messages li')).toHaveCount(0); // ...and nothing tells the user why
  await shot(page, 'bug07-c-silent-delete-failure', 'Server returned 500 on delete - the page shows nothing at all');
});

test('[BUG-08] Login is case-sensitive on e-mail (expected: Alice@X.com == alice@x.com)', async ({ page }) => {
  const u = newUser('case');
  const mixedEmail = `Case.${u.username}@Example.test`;
  await registerViaApi({ ...u, email: mixedEmail });

  await page.goto('/login');
  await page.fill('input[name="email"]', mixedEmail.toLowerCase());
  await page.fill('input[name="password"]', u.password);
  await page.click('button[type="submit"]');
  await expect(page.locator('.error-messages')).toContainText('credentials invalid');
  await shot(page, 'bug08-case-sensitive-login', `Registered as ${mixedEmail}; same address in lower case + correct password -> rejected`);

  // ...and the same address in lower case can even be registered a second time.
  const dup = await apiCall('POST', '/users', { user: { username: `${u.username}_2`, email: mixedEmail.toLowerCase(), password: u.password } });
  expect(dup.status).toBe(201);
});

test('[BUG-09] A username containing "?" makes the user\'s own profile page unreachable (expected: profile loads)', async ({ page }) => {
  const u = await registerViaApi(newUser('qa?tester'));
  await signInWithToken(page, u.token);
  await page.goto('/');
  // The frontend builds '/profiles/' + username without encoding, so "?" starts a query string.
  const apiAnswer = page.waitForResponse(r => r.url().includes('/api/profiles/'));
  await page.locator('.navbar a.nav-link', { hasText: u.username }).click();
  const res = await apiAnswer;
  expect(res.url()).toContain('/api/profiles/qa?tester'); // the request asked for user "qa" with a query string
  expect(res.status()).toBe(404);
  await expectBlankPage(page);
  await shot(page, 'bug09-profile-unreachable', `"${u.username}" clicks their own name -> API looks up user "qa" (404) -> blank page`);
});

test('[BUG-10] No length/size limits: a very long title creates an article nobody can open (expected: validation)', async ({ page }) => {
  const u = await registerViaApi(newUser('long'));
  await signInWithToken(page, u.token);
  const longTitle = 'Averyveryverylongtitle'.repeat(1400); // 30,800 characters, no spaces
  await page.goto('/editor');
  await page.fill('input[name="title"]', longTitle);
  await page.fill('input[name="description"]', 'Long title test');
  await page.fill('textarea[name="body"]', 'Body');
  const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/articles'));
  const loadFailed = page.waitForEvent('requestfailed', r => r.method() === 'GET' && r.url().includes('/api/articles/Averyvery'));
  await page.click('button:has-text("Publish Article")');
  expect((await saved).status()).toBe(201); // saving works...
  await page.waitForURL(/\/article\//);
  await loadFailed; // ...but the browser cannot load it back
  const slug = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  expect((await apiCall('GET', `/articles/${slug}`)).status).toBe(431); // server: "Request Header Fields Too Large"
  await expectBlankPage(page);
  await shot(page, 'bug10-a-long-title-unopenable', 'Article saved, but it can never be opened: API answers HTTP 431 -> blank page');

  await page.goto('/');
  await expect(page.locator('.article-preview').first()).toContainText('Averyveryverylongtitle');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeGreaterThan(0); // and the unbroken title pushes the feed off-screen
  await shot(page, 'bug10-b-feed-layout-broken', `The article still appears in the feed and breaks the layout (${overflow.toLocaleString('en-US')} px horizontal overflow)`);

  // Size limits are missing too: a 10 MB article body is accepted.
  const big = await apiCall('POST', '/articles', { article: { title: 'Big body', description: 'd', body: 'x'.repeat(10 * 1024 * 1024) } }, u.token);
  expect(big.status).toBe(201);
});

test('[BUG-12] Invalid paging parameters crash the API with HTTP 500 and leak internal details (expected: 400)', async () => {
  const res = await fetch(`${API}/articles?offset=-1`);
  const text = await res.text();
  expect(res.status).toBe(500);
  expect(text).toContain('prisma.article.findMany'); // internal ORM call and query shape exposed to the caller
  const capped = await apiCall('GET', '/articles?limit=100000');
  expect(capped.status).toBe(200); // no upper bound on page size either:
  expect(capped.json.articlesCount).toBeGreaterThan(10); // (more articles exist than one default page)
  expect(capped.json.articles.length).toBe(capped.json.articlesCount); // ...and all of them come back at once
});

test('[BUG-13] Tags are not trimmed: " news " and "news" become two identical-looking tags (expected: one tag)', async ({ page }) => {
  const u = await registerViaApi(newUser('tags'));
  const tag = `news${Date.now().toString().slice(-5)}`;
  await signInWithToken(page, u.token);
  // Through the real editor: type the tag with surrounding spaces and press Enter.
  await page.goto('/editor');
  await page.fill('input[name="title"]', 'Tagged with spaces');
  await page.fill('input[name="description"]', 'Tag typed with surrounding spaces');
  await page.fill('textarea[name="body"]', 'Body');
  await page.fill('input[placeholder="Enter tags"]', `  ${tag}  `);
  await page.press('input[placeholder="Enter tags"]', 'Enter');
  await page.click('button:has-text("Publish Article")');
  await page.waitForURL(/\/article\//);
  const slug = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  expect((await apiCall('GET', `/articles/${slug}`)).json.article.tagList).toEqual([`  ${tag}  `]); // spaces were saved
  await createArticleViaApi(u.token, { title: 'Tagged normally', tagList: [tag] });
  await page.goto('/');
  const pills = page.locator('.sidebar .tag-pill', { hasText: tag });
  await expect(pills).toHaveCount(2);
  await pills.first().evaluate(el => el.parentElement!.querySelectorAll('.tag-pill').forEach(p => p.textContent?.includes(el.textContent!.trim()) && ((p as HTMLElement).style.outline = '3px solid #d00')));
  await shot(page, 'bug13-duplicate-looking-tags', `"Popular Tags" lists "${tag}" twice (one copy has hidden spaces)`);
});
