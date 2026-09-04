import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const vite = read('../vite.config.ts');
const ui = read('../src/ui.ts');
const start = read('../start.sh');
const stop = read('../stop.sh');
const envExample = read('../.env.example');
const sidecar = read('../backend/ros2_visual_backend/optional_llm_server.py');
const serviceSupervisor = read('../scripts/service_process_supervisor.py');
const launcher = read('../backend/ros2_visual_backend/launcher.py');

describe('Optional Local LLM process and network boundary', () => {
  it('is default-disabled and does not require a provider or model identifier', () => {
    expect(envExample).toContain('ROS2_VISUAL_LLM_ENABLED=0');
    expect(envExample).toMatch(/ROS2_VISUAL_LLM_MODEL=\s*$/m);
    expect(sidecar).toContain('if enabled_value == "0"');
    expect(sidecar).toContain('return cls(enabled=False)');
  });

  it('uses a same-origin Browser route to one fixed loopback sidecar', () => {
    expect(ui).toContain("fetch(appPath('api/llm/status')");
    expect(ui).toContain("fetch(appPath('api/llm/intent')");
    expect(vite).toContain("server.middlewares.use('/api/llm'");
    expect(vite).toContain("target: 'http://127.0.0.1:27184'");
    expect(vite).toContain("parsed.protocol === 'http:'");
    expect(vite).toContain('&& parsed.host === host');
    expect(vite).toContain('followRedirects: false');
    expect(vite).toContain("removeHeader('authorization')");
    expect(sidecar).toContain('SIDECAR_HOST = "127.0.0.1"');
  });

  it('runs in SIM as a non-ROS sidecar and is lifecycle-owned by start and stop', () => {
    expect(start).toContain('service_process_supervisor.py optional_llm');
    expect(serviceSupervisor).toContain('ros2_visual_backend.optional_llm_server');
    expect(serviceSupervisor).toContain('os.setsid()');
    expect(start).toContain('.logs/optional_llm.pid');
    expect(start).toContain('.logs/optional_llm.pgid');
    expect(stop).toContain('.logs/optional_llm.pid');
    expect(stop).toContain('.logs/optional_llm.pgid');
    expect(launcher).not.toMatch(/local_llm/);
    expect(sidecar).not.toMatch(/import rclpy|from rclpy|\/cmd_vel|navigate_to_pose/);
  });
});
