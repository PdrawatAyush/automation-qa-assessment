// Renders ../report-source/report.html -> ../Task1_QA_Report_AyushRawat.pdf with headless Chrome.
// Usage (from qa-tests):  node render-report.mjs
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'report-source', 'report.html');
const out = join(here, '..', 'Task1_QA_Report_AyushRawat.pdf');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle' });
await page.pdf({
  path: out,
  preferCSSPageSize: true, // honour @page sizes: portrait text pages, landscape table/screenshot pages
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: `<div style="font:7.5pt 'Segoe UI',Arial,sans-serif;color:#6b778c;width:100%;padding:0 12mm;display:flex;justify-content:space-between">
      <span>Task 1 – Web App QA &amp; Debug Report · Ayush Rawat</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  tagged: true,
  outline: true,
});
await browser.close();
console.log('PDF written:', out);
