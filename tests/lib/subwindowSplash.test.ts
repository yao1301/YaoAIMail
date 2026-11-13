import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

const html = readFileSync(resolve('index.html'), 'utf8');

// Execute the real HTML's inline startup script, with NO React/module loading.
// An effect-only fix would fail: this is the first-paint interval at issue.
it.each(['?mailWindow=1&message=bTE', '?mailWindow=1&message=invalid', '?compose=1', '?compose=1&prefill=abc', '?workspaceWindow=1&transfer=fixture'])(
  'never exposes the startup logo before the subwindow frontend loads: %s', search => {
    const page = new JSDOM(html, { url: `https://app.test/${search}`, runScripts: 'dangerously' });
    try {
      const splash = page.window.document.getElementById('splash')!;
      expect(page.window.getComputedStyle(splash).display).toBe('none');
      expect(page.window.document.getElementById('root')?.childElementCount).toBe(0);
    } finally { page.window.close(); }
  },
);

it.each(['', '?mailWindow=0', '?compose=0', '?message=bTE', '?workspaceWindow=0'])(
  'preserves the normal main-window splash: %s', search => {
    const page = new JSDOM(html, { url: `https://app.test/${search}`, runScripts: 'dangerously' });
    try {
      expect(page.window.getComputedStyle(page.window.document.getElementById('splash')!).display).toBe('flex');
    } finally { page.window.close(); }
  },
);
