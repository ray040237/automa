import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const handler = readFileSync(path.join(here, 'handler.iife.js'), 'utf8');
const html = readFileSync(path.join(here, 'fixture-list.html'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();

await page.setContent(html, { waitUntil: 'load' });
await page.addScriptTag({ content: handler });

const has = await page.evaluate(() => typeof window.__agentReadPage);
console.log('注入后 window.__agentReadPage =', has);

const out = await page.evaluate(() => window.__agentReadPage({ detail: 'summary' }));
console.log('---- read_page(detail=summary) 输出 ----');
console.log(out);

await browser.close();
