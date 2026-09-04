import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');

describe('Object Search chat UI contract', () => {
  it('provides accessible in-flow chat controls and live output', () => {
    expect(html).toContain('OBJECT SEARCH CHAT');
    expect(html).toMatch(/id="object-search-messages"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="object-search-input"[^>]*maxlength="200"/);
    expect(html).toContain('object-search-composer');
    expect(html).not.toContain('id="object-search-suggestion"');
    expect(html).toContain('id="object-search-cancel"');
    expect(html).toContain('id="object-search-resume"');
    expect(html).toContain('id="local-llm-state"');
    expect(html).toContain('Optional Local LLM');
    expect(html).toContain('RULE-BASED · LLM OFF');
  });

  it('uses textContent and an in-flow responsive panel without persisting chat bodies', () => {
    expect(ui).not.toMatch(/object-search[^\n]*innerHTML/i);
    expect(ui).not.toMatch(/localStorage[^\n]*(message|chat)/i);
    expect(ui).not.toContain('#object-search-suggestion');
    expect(styles).toContain('.object-search-panel');
    expect(styles).toContain('.object-search-composer');
    expect(styles).toContain('.navigation-panel .map-shell');
    expect(styles).toContain('minmax(18rem, 23.5vh) minmax(18rem, calc(23.5vh + 2rem))');
    expect(styles).toContain('background: linear-gradient(180deg, #2d5056 0%, #1b3439 100%)');
    expect(styles).toContain('inset 0 0 0 1px color-mix(in srgb, var(--control-button-accent) 68%, transparent)');
    expect(styles).toContain('--control-selected-line: #ffe09a');
    expect(styles).toContain('.runtime-map.activated');
    expect(styles).toContain('border-style: dashed');
    expect(styles).toContain('.local-llm-banner');
    expect(styles).not.toMatch(/\.object-search-panel\s*\{[^}]*position:\s*fixed/s);
  });
});
