import { appPath } from './appPaths';
import { BrowserControlLease } from './controlLease';
import { Simulation } from './simulation';
import { LearningUI } from './ui';
import type { RuntimeManagerState } from './appState';
import { ControlLeaseTransportAdapter, LocalTopicBusAdapter, RosbridgeAdapter, SwitchableTransportAdapter, topicType } from './transport';
import { zeroTwist, type LaserScanMessage, type OdometryMessage, type RuntimeMode } from './types';

const root = document.querySelector<HTMLElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas');
const errorPanel = document.querySelector<HTMLElement>('#webgl-error');

function showFatalError(message: string): void {
  if (errorPanel) { errorPanel.hidden = false; errorPanel.textContent = message; }
}

async function start(): Promise<void> {
  if (!root || !canvas) return;
  const webgl2 = canvas.getContext('webgl2');
  if (!webgl2) { showFatalError('このブラウザでは3D表示に必要なWebGL 2を使用できません。SafariまたはChromeを最新版へ更新してください。'); return; }
  const ui = new LearningUI(root, canvas);
  const local = new LocalTopicBusAdapter();
  const switchableTransport = new SwitchableTransportAdapter(local);
  const controlLease = new BrowserControlLease(appPath('api/control-lease'));
  const transport = new ControlLeaseTransportAdapter(switchableTransport, () => controlLease.isOwner());
  ui.bindControlLease(() => controlLease.claim());
  ui.setTransport(transport);
  transport.onEvent((event) => ui.onTopicEvent(event));
  transport.onConnection((state, detail) => ui.setConnection(state, detail));
  await transport.connect();
  ui.setControlLeaseOwner(controlLease.isOwner());

  let simulation: Simulation;
  try {
    simulation = await Simulation.create(canvas, transport, {
      onScan: (scan) => ui.renderScan(scan),
      onOdom: (odom) => ui.renderOdom(odom),
      onStatus: (status) => { ui.renderStatus(status); if (status.stopped) ui.markMission('safety'); },
      onNarration: (message) => ui.showNarration(message),
      onRaySelection: (index, distance) => ui.showRaySelection(index, distance),
      onVisionFrame: (frame) => ui.renderVisionFrame(frame),
      onStageCameraChange: () => ui.refreshStageHandles(),
    });
  } catch (error) {
    console.error(error);
    showFatalError('物理シミュレーションの初期化に失敗しました。ページを再読み込みするか、./scripts/doctor.sh の結果を確認してください。');
    return;
  }
  ui.setSimulation(simulation);
  const syncSimulationOwnership = (): void => simulation.setSharedRuntimeOwner(
    switchableTransport.getConnectionState() === 'SIMULATED' || controlLease.isOwner(),
  );
  syncSimulationOwnership();
  ui.bindSimulationControls(simulation);
  transport.subscribe('/odom', topicType('/odom'), (message) => {
    if (switchableTransport.getConnectionState() !== 'CONNECTED' || controlLease.isOwner()) return;
    const odom = message as OdometryMessage;
    simulation.syncExternalOdometry(odom);
    ui.renderOdom(odom);
  });
  transport.subscribe('/scan', topicType('/scan'), (message) => {
    if (switchableTransport.getConnectionState() === 'CONNECTED' && !controlLease.isOwner()) ui.renderScan(message as LaserScanMessage);
  });
  controlLease.onChange((owner) => {
    if (!owner && switchableTransport.getConnectionState() === 'CONNECTED') {
      switchableTransport.cancelNavigationGoal();
      switchableTransport.publish('/cmd_vel_manual', topicType('/cmd_vel_manual'), zeroTwist());
    }
    syncSimulationOwnership();
    ui.setControlLeaseOwner(owner);
  });
  transport.onConnection((state) => {
    if (state === 'CONNECTED') {
      void controlLease.start();
    } else if (state !== 'SIMULATED') {
      void controlLease.stop();
    }
  });
  window.addEventListener('pagehide', () => controlLease.dispose(), { once: true });
  simulation.start();
  if (import.meta.env.DEV) {
    (window as Window & { __ros2VisualDiagnostics?: () => ReturnType<Simulation['getResourceDiagnostics']> }).__ros2VisualDiagnostics = () => simulation.getResourceDiagnostics();
    (window as Window & { __ros2VisualSim?: Simulation }).__ros2VisualSim = simulation;
  }

  let runtimeState: RuntimeManagerState = { mode: 'sim', target: 'sim', processing: false, phase: '', error: '', backendAlive: false };
  let rosTransportActive = false;
  let transportSwitching = false;
  let nextRosRetryAt = 0;

  const syncTransport = async (state: RuntimeManagerState): Promise<void> => {
    if (transportSwitching) return;
    if (state.processing || state.mode === 'sim') {
      if (!rosTransportActive) return;
      transportSwitching = true;
      await switchableTransport.setActive(local);
      syncSimulationOwnership();
      rosTransportActive = false;
      if (!state.processing) {
        ui.setConnection('SIMULATED');
        ui.showNarration('ROS2、MAP、NAV2、探索構成を終了してSIMへ戻りました。ROS 2なしでも同じTopicの学習を続けられます。');
      }
      transportSwitching = false;
      return;
    }
    const connection = transport.getConnectionState();
    if (rosTransportActive && (connection === 'CONNECTED' || connection === 'CONNECTING' || connection === 'RECONNECTING')) return;
    if (Date.now() < nextRosRetryAt) return;
    transportSwitching = true;
    const ros = new RosbridgeAdapter();
    try {
      await switchableTransport.setActive(ros);
      syncSimulationOwnership();
      rosTransportActive = true;
      ui.showNarration('ROS2へ接続しました。上部のROS2・MAP・NAV2と地図パネルの探索状態で起動構成を確認できます。');
    } catch (error) {
      console.warn('rosbridge connection failed; remaining in SIM mode', error);
      await switchableTransport.setActive(local);
      syncSimulationOwnership();
      rosTransportActive = false;
      nextRosRetryAt = Date.now() + 2000;
      ui.setConnection('ERROR', 'rosbridgeが起動していません');
      ui.showNarration('ROS2 backendの起動完了を待っています。接続できるまでSIMは停止状態を保ちます。');
    } finally {
      transportSwitching = false;
    }
  };

  const refreshRuntime = async (): Promise<RuntimeManagerState | null> => {
    try {
      const response = await fetch(appPath('api/runtime'), { cache: 'no-store' });
      if (!response.ok) throw new Error(`runtime status ${response.status}`);
      runtimeState = await response.json() as RuntimeManagerState;
      ui.setRuntimeManagerState(runtimeState);
      await syncTransport(runtimeState);
      return runtimeState;
    } catch (error) {
      console.warn('runtime status unavailable', error);
      return null;
    }
  };

  const requestRuntime = async (mode: RuntimeMode): Promise<boolean> => {
    if (runtimeState.processing) return false;
    runtimeState = { ...runtimeState, target: mode, processing: true, phase: mode === 'sim' ? 'closing' : 'processing', error: '' };
    ui.setRuntimeManagerState(runtimeState);
    try {
      // Stop the previous rosbridge adapter before replacing the backend.  In
      // particular, its reconnect loop and rosapi graph polling must not enter
      // the new graph while lifecycle services are still being discovered.
      await syncTransport(runtimeState);
      const response = await fetch(appPath('api/runtime'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || `runtime request ${response.status}`);
      }
      const runtimeLabel = mode === 'base' ? 'ROS2' : mode === 'mapping' ? 'MAP' : mode === 'navigation' ? 'NAV2' : mode === 'exploration' ? '探索構成' : 'SIM';
      ui.showNarration(mode === 'sim' ? 'ROS2構成を安全に終了しています。' : `${runtimeLabel}を起動しています。完了まで操作ボタンをロックします。`);
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        const state = await refreshRuntime();
        if (!state || state.processing) continue;
        if (state.error) return false;
        if (state.mode === mode && (mode === 'sim' || transport.getConnectionState() === 'CONNECTED')) return true;
      }
      throw new Error(`${mode}への切替が時間内に完了しませんでした。ROSログを確認してください。`);
    } catch (error) {
      runtimeState = { ...runtimeState, processing: false, phase: '', error: error instanceof Error ? error.message : String(error) };
      ui.setRuntimeManagerState(runtimeState);
      return false;
    }
  };

  ui.bindRuntimeControls(requestRuntime);
  const requestShutdown = async (): Promise<boolean> => {
    try {
      const response = await fetch(appPath('api/shutdown'), { method: 'POST' });
      return response.ok;
    } catch {
      return false;
    }
  };
  ui.bindAppExit(requestShutdown);
  await refreshRuntime();
  window.setInterval(() => void refreshRuntime(), 750);
}

void start();
