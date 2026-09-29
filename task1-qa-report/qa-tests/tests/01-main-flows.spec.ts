import { test, expect } from '@playwright/test';
import { createArticleViaApi, newUser, registerViaApi, shot } from './helpers';

// Security spot-check that PASSES: stored script/HTML in an article body must not execute.
test('security: script and event-handler markup in an article body is neutralised (XSS)', async ({ page }) => {
  const u = await registerViaApi(newUser('xss'));
  const body = 'Hello <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> [click me](javascript:window.__xss=3)';
  const article = await createArticleViaApi(u.token, { title: 'XSS probe', body });
  const dialogs: string[] = [];
  page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto(`/article/${article.slug}`);
  await expect(page.locator('.article-content')).toContainText('Hello');
  await page.locator('.article-content a', { hasText: 'click me' }).click().catch(() => { /* link may be neutralised */ });
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  await expect(page.locator('.article-content img[onerror], .article-content script')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// Happy path through every flow the assignment asks for. This test is expected to PASS:
// it proves the basics work, so the bugs in 02-bug-reproductions are genuine edge cases.
test('main flows: sign up -> log out -> log in -> create -> edit -> comment -> delete -> log out', async ({ page }) => {
  const u = newUser('flow');
  const title = `Hello from QA ${u.username}`;

  await test.step('sign up', async () => {
    await page.goto('/register');
    await page.fill('input[name="username"]', u.username);
    await page.fill('input[name="email"]', u.email);
    await page.fill('input[name="password"]', u.password);
    await page.click('button[type="submit"]');
    await expect(page.locator('.navbar')).toContainText(u.username);
    await shot(page, 'flow-01-signed-up', 'Sign-up works: new user is logged in (name in the top bar)');
  });

  await test.step('log out', async () => {
    await page.click('a[href="/settings"]');
    await page.click('button:has-text("Or click here to logout")');
    await expect(page.locator('.navbar')).toContainText('Sign in');
  });

  await test.step('log in', async () => {
    await page.goto('/login');
    await page.fill('input[name="email"]', u.email);
    await page.fill('input[name="password"]', u.password);
    await page.click('button[type="submit"]');
    await expect(page.locator('.navbar')).toContainText(u.username);
  });

  await test.step('create article', async () => {
    await page.click('a[href="/editor"]');
    await page.fill('input[name="title"]', title);
    await page.fill('input[name="description"]', 'Checking the create flow');
    await page.fill('textarea[name="body"]', 'First **version** of the body.');
    await page.fill('input[placeholder="Enter tags"]', 'qa');
    await page.press('input[placeholder="Enter tags"]', 'Enter');
    await page.click('button:has-text("Publish Article")');
    await page.waitForURL(/\/article\//);
    await expect(page.locator('h1')).toHaveText(title);
    await shot(page, 'flow-02-article-created', 'Create works: article published and displayed');
  });

  await test.step('edit article', async () => {
    await page.locator('a:has-text("Edit Article")').first().click();
    await expect(page.locator('input[name="title"]')).toHaveValue(title);
    await page.fill('textarea[name="body"]', 'Second version of the body (edited).');
    await page.click('button:has-text("Publish Article")');
    await page.waitForURL(/\/article\//);
    await expect(page.locator('.article-content')).toContainText('Second version of the body');
  });

  await test.step('add and delete a comment', async () => {
    await page.fill('textarea[placeholder="Write a comment..."]', 'A comment from the QA run');
    await page.click('button:has-text("Post Comment")');
    await expect(page.locator('.card:not(.comment-form) .card-block')).toContainText('A comment from the QA run');
    await page.locator('.mod-options .ion-trash-a').first().click();
    await expect(page.locator('.card:not(.comment-form)')).toHaveCount(0);
  });

  await test.step('delete article', async () => {
    await page.locator('button:has-text("Delete Article")').first().click();
    await page.waitForURL(url => new URL(url).pathname === '/');
    await page.goto(`/profile/${u.username}`);
    await expect(page.locator('.article-preview')).toContainText('No articles are here');
  });

  await test.step('log out again', async () => {
    await page.click('a[href="/settings"]');
    await page.click('button:has-text("Or click here to logout")');
    await expect(page.locator('.navbar')).toContainText('Sign up');
    await shot(page, 'flow-03-logged-out', 'Log-out works: visitor navigation shown again');
  });
});
