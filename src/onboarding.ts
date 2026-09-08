export const ONBOARDING_STORAGE_KEY = 'ros2-visual-starter-onboarding-v1';
export const TIP_IDS = ['ros', 'exploration', 'keyboard', 'camera'] as const;
type TipId = typeof TIP_IDS[number];
export interface TipProgress { explorationStarts: number; dismissed: TipId[] }
export function readTipProgress(raw: string | null): TipProgress {
  try {
    const value = JSON.parse(raw ?? '{}');
    return {
      explorationStarts: Number.isSafeInteger(value?.explorationStarts) && value.explorationStarts >= 0 ? value.explorationStarts : 0,
      dismissed: Array.isArray(value?.dismissed) ? TIP_IDS.filter((id) => value.dismissed.includes(id)) : [],
    };
  } catch { return { explorationStarts: 0, dismissed: [] }; }
}
export interface TipContext { blocked: boolean; sim: boolean; explorationReady: boolean; manual: boolean; idle: boolean }
export function selectTip(progress: TipProgress, closed: ReadonlySet<TipId>, context: TipContext): TipId | null {
  if (context.blocked) return null;
  const available = (id: TipId): boolean => !closed.has(id) && !progress.dismissed.includes(id);
  if (context.sim && available('ros')) return 'ros';
  if (context.explorationReady && available('exploration')) return 'exploration';
  if (progress.explorationStarts >= 3 && context.idle) {
    if (context.manual && available('keyboard')) return 'keyboard';
    if (available('camera')) return 'camera';
  }
  return null;
}
const tips: Record<TipId, { target: string; text: string }> = {
  ros: { target: '#connection-status', text: 'ROS2バックエンドを起動するには、このボタンを押して下さい。' },
  exploration: { target: '#start-exploration-button', text: '自律的な経路探索をするには、このボタンを押して下さい。' },
  keyboard: { target: '#manual-mode-button', text: 'w・a・s・dキーでロボットを操縦できます。' },
  camera: { target: '#camera-toggle', text: 'このボタンで、ロボットを上から見下ろせます。' },
};

/** Non-modal coach marks: never move the robot or steal focus on appearance. */
export class OnboardingTips {
  private progress: TipProgress;
  private closed = new Set<TipId>();
  private current: TipId | null = null;
  private revealed = new Set<TipId>();
  private target: HTMLElement | null = null;
  private card = document.createElement('section');
  private checkbox: HTMLInputElement;
  private message: HTMLElement;
  constructor(private root: HTMLElement, private context: () => TipContext) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(ONBOARDING_STORAGE_KEY); } catch { /* Private browsing can deny storage. */ }
    this.progress = readTipProgress(raw);
    this.card.className = 'onboarding-tip';
    this.card.hidden = true;
    this.card.setAttribute('role', 'region');
    this.card.setAttribute('aria-label', '使い方のヒント');
    this.card.innerHTML = '<p id="onboarding-message" aria-live="polite"></p><div class="onboarding-actions"><label><input type="checkbox"> 次回から表示しない</label><button type="button">OK</button></div>';
    this.message = this.card.querySelector('p')!;
    this.checkbox = this.card.querySelector('input')!;
    this.card.querySelector('button')!.addEventListener('click', () => this.close());
    this.card.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
    });
    this.card.addEventListener('keyup', (event) => event.stopPropagation());
    document.body.append(this.card);
    window.addEventListener('resize', () => this.refresh());
    document.addEventListener('scroll', () => this.refresh(), true);
    // Also observes readiness, modal visibility and layout changes without coupling to render frequency.
    window.setInterval(() => this.refresh(), 500);
    this.refresh();
  }
  recordExplorationStart(): void {
    this.progress.explorationStarts = Math.min(this.progress.explorationStarts + 1, 1000);
    this.closed.add('exploration');
    this.save();
    this.refresh();
  }
  private save(): void {
    try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(this.progress)); } catch { /* Session behavior remains available. */ }
  }
  private close(): void {
    if (!this.current) return;
    this.closed.add(this.current);
    if (this.checkbox.checked) {
      this.progress.dismissed = [...new Set([...this.progress.dismissed, this.current])];
      this.save();
    }
    const restoreFocus = this.card.contains(document.activeElement);
    const target = this.target;
    this.hide();
    if (restoreFocus) target?.focus({ preventScroll: true });
    // Let the user return to the UI before showing another hint.
    this.nextTipAt = Date.now() + 4000;
  }
  private nextTipAt = 0;
  private hide(): void {
    this.target?.classList.remove('onboarding-target');
    if (this.target) {
      const descriptions = (this.target.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id && id !== 'onboarding-message');
      if (descriptions.length) this.target.setAttribute('aria-describedby', descriptions.join(' '));
      else this.target.removeAttribute('aria-describedby');
    }
    this.current = null;
    this.target = null;
    this.card.hidden = true;
  }
  private refresh(): void {
    const id = Date.now() < this.nextTipAt ? null : selectTip(this.progress, this.closed, this.context());
    const target = id ? this.root.querySelector<HTMLElement>(tips[id].target) : null;
    if (id && target && !this.revealed.has(id) && target.getClientRects().length) {
      this.revealed.add(id);
      const bounds = target.getBoundingClientRect();
      if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    }
    const rect = target?.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    if (!id || !target || !rect || !rect.width || !rect.height || rect.top < 0 || rect.bottom > height || rect.left < 0 || rect.right > width) { this.hide(); return; }
    if (this.current !== id) {
      this.hide();
      this.current = id;
      this.target = target;
      this.message.textContent = tips[id].text;
      this.checkbox.checked = false;
      target.classList.add('onboarding-target');
      target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), 'onboarding-message'].filter(Boolean).join(' '));
    }
    this.card.hidden = false;
    const box = this.card.getBoundingClientRect();
    const below = rect.bottom + box.height + 20 <= height;
    const top = below ? rect.bottom + 14 : rect.top - box.height - 14;
    if (top < 8) { this.hide(); return; }
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, width - box.width - 8));
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
    this.card.style.setProperty('--tip-arrow-left', `${Math.max(16, Math.min(rect.left + rect.width / 2 - left, box.width - 16))}px`);
    this.card.dataset.side = below ? 'below' : 'above';
  }
}
