import { describe, expect, it, vi } from 'vitest';
import { BrowserControlLease, CONTROL_LEASE_TTL_MS, ControlLeaseRegistry } from '../src/controlLease';

describe('browser control lease registry', () => {
  it('keeps one owner, supports explicit takeover, and lets a viewer recover an expired lease', () => {
    const registry = new ControlLeaseRegistry();
    const now = 10_000;

    expect(registry.update('browser-a', 'renew', now)).toMatchObject({ owned: true, ownerPresent: true });
    expect(registry.update('browser-b', 'renew', now + 100)).toMatchObject({ owned: false, ownerPresent: true });

    expect(registry.update('browser-b', 'claim', now + 200)).toMatchObject({ owned: true, ownerPresent: true, handoffDelayMs: 600 });
    expect(registry.update('browser-a', 'renew', now + 300)).toMatchObject({ owned: false, ownerPresent: true });

    const recovered = registry.update('browser-a', 'renew', now + 200 + CONTROL_LEASE_TTL_MS + 1);
    expect(recovered).toMatchObject({ owned: true, ownerPresent: true });
    expect(recovered.expiresInMs).toBe(CONTROL_LEASE_TTL_MS);
  });

  it('releases only the current owner and rejects malformed client ids', () => {
    const registry = new ControlLeaseRegistry();
    registry.update('browser-a', 'renew', 1_000);

    expect(registry.update('browser-b', 'release', 1_100)).toMatchObject({ owned: false, ownerPresent: true });
    expect(registry.update('browser-a', 'release', 1_200)).toMatchObject({ owned: false, ownerPresent: false });
    expect(() => registry.update('bad', 'renew', 1_300)).toThrow('clientId is invalid');
  });

  it('releases browser ownership and stops heartbeats when ROS disconnects', async () => {
    const actions: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_endpoint: string, request: RequestInit) => {
      const action = String((JSON.parse(String(request.body)) as { action?: unknown }).action ?? '');
      actions.push(action);
      return {
        ok: true,
        json: async () => ({
          owned: action !== 'release', ownerPresent: action !== 'release', generation: 1,
          expiresInMs: action !== 'release' ? CONTROL_LEASE_TTL_MS : 0, handoffDelayMs: 0,
        }),
      };
    }));
    const lease = new BrowserControlLease('/api/control-lease');

    await expect(lease.start()).resolves.toBe(true);
    expect(lease.isOwner()).toBe(true);
    await lease.stop();
    expect(lease.isOwner()).toBe(false);
    expect(actions).toEqual(['renew', 'release']);

    lease.dispose();
    vi.unstubAllGlobals();
  });
});
