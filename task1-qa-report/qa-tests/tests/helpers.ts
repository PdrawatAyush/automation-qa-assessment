import { Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const API = process.env.API_URL ?? 'http://localhost:3000/api';
export const SHOTS = join(import.meta.dirname, '..', '..', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const id = () => randomBytes(4).toString('hex');

// Throwaway accounts for the local test database only. Passwords are generated per run.
export function newUser(prefix = 'qa') {
  const s = id();
  return { username: `${prefix}_${s}`, email: `${prefix}_${s}@example.test`, password: `Qa!${randomBytes(9).toString('base64url')}` };
}

export async function apiCall(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Token ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

export async function registerViaApi(user = newUser()) {
  const r = await apiCall('POST', '/users', { user });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { ...user, token: r.json.user.token as string };
}

export async function createArticleViaApi(token: string, article: Partial<{ title: string; description: string; body: string; tagList: string[] }> = {}) {
  const data = { title: `QA article ${id()}`, description: 'Created by the QA suite', body: 'Body text', tagList: [], ...article };
  const r = await apiCall('POST', '/articles', { article: data }, token);
  if (r.status !== 201) throw new Error(`create article failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.article as { slug: string; title: string };
}

/** Start the browser session already signed in (same thing the app does after a login). */
export async function signInWithToken(page: Page, token: string) {
  await page.addInitScript(t => window.localStorage.setItem('jwtToken', t), token);
}

/**
 * Screenshot with a banner showing the current URL and a caption, so each image
 * explains itself in the report (the browser address bar is not part of a page screenshot).
 */
export async function shot(page: Page, name: string, caption: string) {
  await page.evaluate(([url, text]) => {
    const el = document.createElement('div');
    el.id = '__qa_banner';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#111;color:#fff;font:13px/1.4 Consolas,monospace;padding:6px 10px;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    el.textContent = `URL: ${url.length > 140 ? url.slice(0, 140) + '…' : url}   |   ${text}`;
    document.body.appendChild(el);
  }, [page.url(), caption]);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.evaluate(() => document.getElementById('__qa_banner')?.remove());
}
