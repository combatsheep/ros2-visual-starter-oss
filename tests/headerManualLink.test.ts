import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('header manual and exit controls', () => {
  it('keeps the manual link in the former exit-button slot and opens the local guide', () => {
    expect(html).toMatch(/class="button-outline manual-link" href="\.\/docs\/STARTUP_GUIDE\.html" target="_blank" rel="noopener"/);
    expect(html).toContain('aria-label="マニュアルを開く"');
    expect(html).toContain('class="manual-icon" viewBox="0 0 32 32"');
    expect(html).toContain('class="manual-icon-bookmark"');
    expect(html).toMatch(/class="topbar-actions"[\s\S]*class="button-outline manual-link"[\s\S]*<\/div>\s*<nav/);
    expect(html).not.toMatch(/class="brand-lockup"[\s\S]*class="manual-link"/);
  });

  it('moves the exit button to the topbar edge', () => {
    expect(html).toContain('class="app-exit-button topbar-exit-button"');
    expect(html).toMatch(/<\/nav>\s*<\/div>\s*<button id="app-exit-button"/);
  });

  it('keeps the icon link touch-friendly and responsive', () => {
    expect(styles).toContain('.manual-link {');
    expect(styles).toContain('min-width: 2.75rem');
    expect(styles).toContain('min-height: 2.75rem');
    expect(styles).toContain('.manual-icon {');
    expect(styles).toContain('.topbar-exit-button {');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(styles).toContain('justify-content: flex-start');
    expect(styles).toContain('flex: 1 1 auto');
  });
});
