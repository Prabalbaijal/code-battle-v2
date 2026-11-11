import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

/**
 * Visual snapshots (plan §21.5): every UI-kit story from the static Storybook build, plus the
 * pages whose look doesn't depend on data, in dark and light. A changed pixel fails the test;
 * after an intended change run `playwright test e2e/visual.spec.ts --update-snapshots`.
 * Baselines are per platform (fonts render differently), so they're taken on the dev machine.
 */
const STATIC = join(import.meta.dirname, '../../../packages/ui/storybook-static');
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

let server: Server | undefined;
let base = '';

test.beforeAll(async () => {
  if (!existsSync(join(STATIC, 'index.json'))) return;
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^([/\\])+/, '');
    const file = join(STATIC, path || 'index.html');
    if (!file.startsWith(STATIC) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
test.afterAll(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const SCHEMES = ['dark', 'light'] as const;

test('UI kit stories look the same', async ({ page }) => {
  test.skip(!server, 'build the Storybook first: pnpm --filter @cb/ui build-storybook');
  const index = JSON.parse(readFileSync(join(STATIC, 'index.json'), 'utf8')) as {
    entries: Record<string, { id: string; type: string }>;
  };
  const stories = Object.values(index.entries).filter((e) => e.type === 'story');
  expect(stories.length).toBeGreaterThan(5);
  for (const s of stories) {
    for (const colorScheme of SCHEMES) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto(`${base}/iframe.html?id=${s.id}&viewMode=story`);
      await page.locator('#storybook-root > *').first().waitFor();
      await expect(page.locator('#storybook-root')).toHaveScreenshot(`${s.id}-${colorScheme}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      });
    }
  }
});

test('static pages look the same', async ({ page }) => {
  for (const path of ['/', '/login', '/register', '/forgot-password']) {
    for (const colorScheme of SCHEMES) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const name = path === '/' ? 'landing' : path.slice(1);
      await expect(page).toHaveScreenshot(`${name}-${colorScheme}.png`, {
        animations: 'disabled',
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    }
  }
});
