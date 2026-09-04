import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const localIntent = readFileSync(new URL('../src/localLlmIntent.ts', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
const transport = readFileSync(new URL('../src/transport.ts', import.meta.url), 'utf8');

describe('Local LLM frontend ownership boundary', () => {
  it('keeps the pure envelope and stale guard free of ROS, DOM, HTTP, and actuator APIs', () => {
    expect(localIntent).not.toMatch(/fetch\s*\(|XMLHttpRequest|localhost|127\.0\.0\.1|\/v1\//);
    expect(localIntent).not.toMatch(/document\.|window\.|roslib|cmd_vel|navigate_to_pose/);
  });

  it('uses only the same-origin API and never receives provider configuration', () => {
    const chatHandlers = ui.slice(
      ui.indexOf('private bindObjectSearchChat'),
      ui.indexOf('private currentObjectSearchCandidate'),
    );
    expect(chatHandlers).toContain("fetch(appPath('api/llm/intent')");
    expect(chatHandlers).toContain("fetch(appPath('api/llm/status')");
    expect(chatHandlers).not.toMatch(/localhost|127\.0\.0\.1|\/v1\/|ROS2_VISUAL_LLM_(?:BASE_URL|TOKEN)|Authorization/);
  });

  it('keeps the optional adapter out of ROS Transport ownership', () => {
    expect(transport).not.toMatch(/\/llm\//);
    expect(ui).not.toMatch(/publish\('\/llm\//);
  });
});
