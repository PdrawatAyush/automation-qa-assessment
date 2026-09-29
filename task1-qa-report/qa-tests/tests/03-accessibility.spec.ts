import { test, expect, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiCall, createArticleViaApi, newUser, registerViaApi, shot, signInWithToken } from './helpers';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const COLORS: Record<string, string> = { 'color-contrast': '#e67e00', 'image-alt': '#d00000', 'link-name': '#7b1fa2', 'html-has-lang': '#0066cc' };

async function runAxe(page: Page) {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async tags => {
    // @ts-expect-error axe is injected at runtime
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
    return r.violations.map((v: any) => ({
      id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, count: v.nodes.length,
      targets: v.nodes.map((n: any) => n.target.join(' ')),
    }));
  }, WCAG_AA);
}

/** Outline every element axe flagged, colour-coded by rule, for the screenshot. */
async function outlineViolations(page: Page, violations: { id: string; targets: string[] }[]) {
  await page.evaluate(([vs, colors]) => {
    for (const v of vs as { id: string; targets: string[] }[]) {
      for (const t of v.targets) {
        const el = document.querySelector(t) as HTMLElement | null;
        if (el && el.tagName !== 'HTML') el.style.outline = `3px solid ${(colors as Record<string, string>)[v.id] ?? '#d00'}`;
      }
    }
  }, [violations, COLORS] as const);
}

test('[BUG-11] WCAG 2.1 AA failures on every page (axe-core) + delete-comment icon is mouse-only', async ({ page }) => {
  const author = await registerViaApi(newUser('a11yauthor'));
  const article = await createArticleViaApi(author.token, { title: 'Accessibility check', body: 'Some **markdown** body', tagList: ['a11y'] });
  const reader = await registerViaApi(newUser('a11yreader'));
  await apiCall('POST', `/articles/${article.slug}/comments`, { comment: { body: 'My own comment' } }, reader.token);

  const report: Record<string, any[]> = {};

  await page.goto('/register');
  await expect(page.locator('input[name="username"]')).toBeVisible();
  report['/register (signed out)'] = await runAxe(page);
  // Not an automated failure (axe accepts placeholders as names) but noted: no visible labels.
  const placeholderOnlyFields = await page.locator('input:not([id]), textarea:not([id])').count();

  await page.goto('/');
  await expect(page.locator('.article-preview').first()).toBeVisible();
  report['/ (home, signed out)'] = await runAxe(page);
  await outlineViolations(page, report['/ (home, signed out)']);
  await shot(page, 'bug11-a11y-home-violations', 'axe WCAG 2.1 AA: orange = low contrast, red = image without alt text, purple = link without a name');

  await signInWithToken(page, reader.token);
  await page.goto(`/article/${article.slug}`);
  await expect(page.locator('.card:not(.comment-form) .card-block').first()).toContainText('My own comment');
  report['/article/:slug (signed in, own comment)'] = await runAxe(page);

  // The "delete comment" control is a bare <i> icon with a click handler: not focusable, no name, no role.
  const trash = await page.locator('.mod-options .ion-trash-a').first().evaluate(el => ({
    tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex, role: el.getAttribute('role'), name: el.getAttribute('aria-label') ?? el.textContent?.trim(),
  }));
  expect(trash).toEqual({ tag: 'I', tabIndex: -1, role: null, name: '' });
  // Prove it with the keyboard: tab through the page and record everything that receives focus.
  const focused: string[] = [];
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    focused.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName}.${el.className}`.slice(0, 60) : 'none';
    }));
  }
  expect(focused.some(f => f.includes('ion-trash-a'))).toBe(false); // keyboard users can never delete their comment

  await page.goto('/editor');
  await expect(page.locator('input[name="title"]')).toBeVisible();
  report['/editor (signed in)'] = await runAxe(page);

  await page.goto('/settings');
  await expect(page.locator('input[name="email"]')).toBeVisible();
  report['/settings (signed in)'] = await runAxe(page);

  const lang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
  expect(lang).toBeNull(); // <html> has no lang attribute -> screen readers guess the language

  const summary = Object.fromEntries(Object.entries(report).map(([p, v]) => [p, Object.fromEntries(v.map(x => [x.id, `${x.impact}, ${x.count} element(s)`]))]));
  writeFileSync(join(import.meta.dirname, '..', '..', 'evidence', 'axe-results.json'),
    JSON.stringify({ tool: 'axe-core 4.13.0', rules: WCAG_AA, summary, trashIcon: trash, focusedWhileTabbing: focused, placeholderOnlyFieldsOnRegister: placeholderOnlyFields, lang, report }, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  const allIds = new Set(Object.values(report).flatMap(v => v.map(x => x.id)));
  expect([...allIds]).toEqual(expect.arrayContaining(['color-contrast', 'html-has-lang', 'image-alt', 'link-name']));
});
