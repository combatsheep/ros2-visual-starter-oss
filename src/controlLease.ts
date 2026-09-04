export const CONTROL_LEASE_TTL_MS = 2_500;
export const CONTROL_LEASE_HEARTBEAT_MS = 500;

export type ControlLeaseAction = 'renew' | 'claim' | 'release';

export interface ControlLeaseResponse {
  owned: boolean;
  ownerPresent: boolean;
  generation: number;
  expiresInMs: number;
  handoffDelayMs: number;
}

export class ControlLeaseRegistry {
  private ownerId: string | null = null;
  private expiresAtMs = 0;
  private generation = 0;

  update(clientId: string, action: ControlLeaseAction, nowMs: number): ControlLeaseResponse {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientId)) throw new Error('clientId is invalid');
    if (!Number.isFinite(nowMs)) throw new Error('nowMs is invalid');

    if (this.ownerId !== null && this.expiresAtMs <= nowMs) {
      this.ownerId = null;
      this.expiresAtMs = 0;
      this.generation += 1;
    }

    if (action === 'release') {
      if (this.ownerId === clientId) {
        this.ownerId = null;
        this.expiresAtMs = 0;
        this.generation += 1;
      }
      return this.snapshot(clientId, nowMs, 0);
    }

    const mayAcquire = action === 'claim' || this.ownerId === null || this.ownerId === clientId;
    const replacingOwner = action === 'claim' && this.ownerId !== null && this.ownerId !== clientId;
    if (mayAcquire) {
      if (this.ownerId !== clientId) this.generation += 1;
      this.ownerId = clientId;
      this.expiresAtMs = nowMs + CONTROL_LEASE_TTL_MS;
    }
    return this.snapshot(clientId, nowMs, replacingOwner ? CONTROL_LEASE_HEARTBEAT_MS + 100 : 0);
  }

  private snapshot(clientId: string, nowMs: number, handoffDelayMs: number): ControlLeaseResponse {
    const owned = this.ownerId === clientId && this.expiresAtMs > nowMs;
    return {
      owned,
      ownerPresent: this.ownerId !== null && this.expiresAtMs > nowMs,
      generation: this.generation,
      expiresInMs: owned ? Math.max(0, this.expiresAtMs - nowMs) : 0,
      handoffDelayMs,
    };
  }
}

type ControlLeaseListener = (owned: boolean) => void;

function createControlLeaseClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export class BrowserControlLease {
  private readonly clientId = createControlLeaseClientId();
  private readonly listeners = new Set<ControlLeaseListener>();
  private owned = false;
  private lastServerResponseAtMs = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private renewalInFlight: Promise<boolean> | null = null;
  private activationNotBeforeMs = 0;
  private disposed = false;

  constructor(private readonly endpoint: string) {}

  isOwner(): boolean { return this.owned; }

  onChange(listener: ControlLeaseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<boolean> {
    const owned = await this.request('renew');
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => void this.renew(), CONTROL_LEASE_HEARTBEAT_MS);
    }
    return owned;
  }

  async claim(): Promise<boolean> {
    if (this.renewalInFlight) await this.renewalInFlight;
    return this.request('claim');
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.renewalInFlight) await this.renewalInFlight;
    await this.request('release');
    this.activationNotBeforeMs = 0;
    this.setOwned(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.owned && typeof navigator.sendBeacon === 'function') {
      const body = new Blob([JSON.stringify({ clientId: this.clientId, action: 'release' })], { type: 'application/json' });
      navigator.sendBeacon(this.endpoint, body);
    }
    this.setOwned(false);
  }

  private async renew(): Promise<boolean> {
    if (this.renewalInFlight) return this.renewalInFlight;
    const renewal = this.request('renew');
    this.renewalInFlight = renewal;
    try { return await renewal; } finally {
      if (this.renewalInFlight === renewal) this.renewalInFlight = null;
    }
  }

  private async request(action: ControlLeaseAction): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId, action }),
        cache: 'no-store',
        keepalive: action === 'release',
      });
      if (!response.ok) throw new Error(`control lease ${response.status}`);
      const status = await response.json() as ControlLeaseResponse;
      this.lastServerResponseAtMs = Date.now();
      if (action === 'claim' && status.owned === true && status.handoffDelayMs > 0) {
        this.activationNotBeforeMs = Date.now() + status.handoffDelayMs;
        this.setOwned(false);
        await new Promise((resolve) => setTimeout(resolve, status.handoffDelayMs));
        if (this.disposed) return false;
        return this.request('renew');
      }
      const activationReady = Date.now() >= this.activationNotBeforeMs;
      this.setOwned(status.owned === true && activationReady);
      if (this.owned) this.activationNotBeforeMs = 0;
    } catch (error) {
      console.warn('control lease unavailable', error);
      if (Date.now() - this.lastServerResponseAtMs >= CONTROL_LEASE_TTL_MS) this.setOwned(false);
    }
    return this.owned;
  }

  private setOwned(owned: boolean): void {
    if (this.owned === owned) return;
    this.owned = owned;
    this.listeners.forEach((listener) => listener(owned));
  }
}
