import { Action, Ros, Service, Topic, type RosbridgeMessage } from 'roslib';
import { appPath } from './appPaths';
import {
  ConnectionState,
  NavigationGoalCallbacks,
  NavigationGoalError,
  PoseStampedMessage,
  RosGraphSnapshot,
  RosLifecycleManagerActivity,
  TOPICS,
  TopicMessage,
  TopicName,
  TransportEvent,
} from './types';

export type TopicCallback = (message: TopicMessage) => void;
export type TransportListener = (event: TransportEvent) => void;
export type ConnectionListener = (state: ConnectionState, detail?: string) => void;

export function normalizeNavigationGoalError(error: unknown): NavigationGoalError {
  const message = error instanceof Error ? error.message : String(error);
  if (/STATUS_CANCELED|action was canc(?:eled|elled)/i.test(message)) return { status: 'canceled', message };
  if (/STATUS_ABORTED|action was aborted/i.test(message)) return { status: 'aborted', message };
  return { status: 'failed', message };
}

export interface TransportAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  publish(topic: TopicName, type: string, message: TopicMessage): void;
  subscribe(topic: TopicName, type: string, callback: TopicCallback): () => void;
  getConnectionState(): ConnectionState;
  getGraphSnapshot(): Promise<RosGraphSnapshot>;
  sendNavigationGoal(goal: PoseStampedMessage, callbacks: NavigationGoalCallbacks): string | null;
  cancelNavigationGoal(): void;
  saveMap(mapUrl: string): Promise<boolean>;
  resetMap(): Promise<boolean>;
  onEvent(listener: TransportListener): () => void;
  onConnection(listener: ConnectionListener): () => void;
  dispose(): void;
}

const UNKNOWN_LIFECYCLE_MANAGERS: RosLifecycleManagerActivity = { mapping: null, navigation: null };
const EMPTY_GRAPH: RosGraphSnapshot = { nodes: [], topics: [], actions: [], lifecycleManagers: UNKNOWN_LIFECYCLE_MANAGERS };
const LIFECYCLE_MANAGER_SERVICE_TIMEOUT_SECONDS = 3;
const ROSBRIDGE_CONNECTION_TIMEOUT_MS = 30_000;

interface LifecycleStateResponse { current_state?: { id?: number; label?: string } }

function lifecycleNodeIsActive(ros: Ros, node: '/slam_toolbox' | '/controller_server'): Promise<boolean | null> {
  const service = new Service<Record<string, never>, LifecycleStateResponse>({
    ros,
    name: `${node}/get_state`,
    serviceType: 'lifecycle_msgs/srv/GetState',
  });
  return new Promise((resolve) => service.callService(
    {},
    (response) => resolve(response.current_state?.id === 3 || response.current_state?.label === 'active'),
    () => resolve(null),
    LIFECYCLE_MANAGER_SERVICE_TIMEOUT_SECONDS,
  ));
}

export class LocalTopicBusAdapter implements TransportAdapter {
  private readonly subscribers = new Map<TopicName, Set<TopicCallback>>();
  private readonly eventListeners = new Set<TransportListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private state: ConnectionState = 'SIMULATED';

  async connect(): Promise<void> { this.setState('SIMULATED'); }
  disconnect(): void { this.setState('DISCONNECTED'); }

  publish(topic: TopicName, _type: string, message: TopicMessage): void {
    const event = { topic, message, at: performance.now() };
    this.subscribers.get(topic)?.forEach((callback) => callback(message));
    this.eventListeners.forEach((listener) => listener(event));
  }

  subscribe(topic: TopicName, _type: string, callback: TopicCallback): () => void {
    const callbacks = this.subscribers.get(topic) ?? new Set<TopicCallback>();
    callbacks.add(callback);
    this.subscribers.set(topic, callbacks);
    return () => callbacks.delete(callback);
  }

  getConnectionState(): ConnectionState { return this.state; }
  async getGraphSnapshot(): Promise<RosGraphSnapshot> { return EMPTY_GRAPH; }
  sendNavigationGoal(_goal: PoseStampedMessage, callbacks: NavigationGoalCallbacks): string | null { callbacks.onError(normalizeNavigationGoalError('ROS 2へ接続してから目標を送信してください。')); return null; }
  cancelNavigationGoal(): void { /* SIMにはROS actionがない */ }
  async saveMap(mapUrl: string): Promise<boolean> { void mapUrl; return false; }
  async resetMap(): Promise<boolean> { return false; }
  onEvent(listener: TransportListener): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onConnection(listener: ConnectionListener): () => void { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener); }
  dispose(): void { this.subscribers.clear(); this.eventListeners.clear(); this.connectionListeners.clear(); }
  private setState(state: ConnectionState, detail?: string): void { this.state = state; this.connectionListeners.forEach((listener) => listener(state, detail)); }
}

interface SubscriptionRecord {
  topic: TopicName;
  type: string;
  callback: TopicCallback;
  activeTopic: Topic<TopicMessage> | null;
  rawId: string | null;
  rawHandler: ((message: RosbridgeMessage) => void) | null;
}

interface NavigateGoal { pose: PoseStampedMessage }

export class RosbridgeAdapter implements TransportAdapter {
  private readonly eventListeners = new Set<TransportListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly subscriptions = new Set<SubscriptionRecord>();
  private readonly publishers = new Map<TopicName, Topic<TopicMessage>>();
  private ros: Ros | null = null;
  private navigationAction: Action<NavigateGoal, unknown, unknown> | null = null;
  private activeGoalId: string | null = null;
  private state: ConnectionState = 'DISCONNECTED';
  private intentionalClose = false;
  private reconnectTimer: number | null = null;
  private graphSnapshotRequest: { ros: Ros; promise: Promise<RosGraphSnapshot> } | null = null;

  constructor(
    private readonly createRos: () => Ros = () => new Ros(),
    private readonly connectionTimeoutMs = ROSBRIDGE_CONNECTION_TIMEOUT_MS,
  ) {}

  async connect(): Promise<void> {
    this.intentionalClose = false;
    if (this.state === 'CONNECTED' || this.state === 'CONNECTING') return;
    this.setState('CONNECTING');
    await this.openConnection();
  }

  private async openConnection(): Promise<void> {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(appPath('rosbridge'), window.location.origin);
    url.protocol = protocol;
    const ros = this.createRos();
    this.ros = ros;
    ros.on('close', () => {
      if (this.ros === ros) this.handleClose();
    });
    ros.on('error', (error) => {
      if (this.ros === ros && this.state === 'CONNECTING') this.setState('ERROR', String(error));
    });
    try {
      const opened = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error('rosbridge WebSocketの接続が30秒以内に完了しませんでした。'));
        }, this.connectionTimeoutMs);
        const onConnection = (): void => { cleanup(); resolve(); };
        const onError = (error: unknown): void => { cleanup(); reject(error); };
        const onClose = (): void => { cleanup(); reject(new Error('rosbridge WebSocketが接続前に閉じました。')); };
        const cleanup = (): void => {
          window.clearTimeout(timeout);
          ros.off('connection', onConnection);
          ros.off('error', onError);
          ros.off('close', onClose);
        };
        ros.on('connection', onConnection);
        ros.on('error', onError);
        ros.on('close', onClose);
      });
      await Promise.all([ros.connect(url.toString()), opened]);
      if (this.ros !== ros) { ros.close(); return; }
      this.setState('CONNECTED');
      this.publishers.clear();
      this.navigationAction = new Action<NavigateGoal, unknown, unknown>({ ros, name: '/navigate_to_pose', actionType: 'nav2_msgs/action/NavigateToPose' });
      this.subscriptions.forEach((record) => this.attachSubscription(record));
    } catch (error) {
      if (this.ros === ros) {
        this.ros = null;
        ros.close();
      }
      this.setState('ERROR', String(error));
      throw error;
    }
  }

  private handleClose(): void {
    this.clearActiveHandles();
    if (this.intentionalClose) { this.setState('DISCONNECTED'); return; }
    this.setState('RECONNECTING', 'rosbridgeとの接続が切れました。速度を0にして再接続します。');
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection().catch(() => {
        if (!this.intentionalClose) this.handleClose();
      });
    }, 1500);
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cancelNavigationGoal();
    const ros = this.ros;
    this.clearActiveHandles();
    this.ros = null;
    ros?.close();
    this.setState('DISCONNECTED');
  }

  publish(topicName: TopicName, type: string, message: TopicMessage): void {
    const ros = this.ros;
    if (!ros || this.state !== 'CONNECTED') return;
    let publisher = this.publishers.get(topicName);
    if (!publisher) {
      publisher = new Topic<TopicMessage>({ ros, name: topicName, messageType: type, queue_size: 10 });
      publisher.advertise();
      this.publishers.set(topicName, publisher);
    }
    publisher.publish(message);
    this.emitTopicEvent(topicName, message);
  }

  subscribe(topic: TopicName, type: string, callback: TopicCallback): () => void {
    const record: SubscriptionRecord = { topic, type, callback, activeTopic: null, rawId: null, rawHandler: null };
    this.subscriptions.add(record);
    if (this.state === 'CONNECTED') this.attachSubscription(record);
    return () => { this.detachSubscription(record); this.subscriptions.delete(record); };
  }

  private attachSubscription(record: SubscriptionRecord): void {
    const ros = this.ros;
    if (!ros || record.activeTopic || record.rawId) return;
    const handler = (message: TopicMessage): void => {
      if (this.ros !== ros || this.state !== 'CONNECTED') return;
      record.callback(message);
      this.emitTopicEvent(record.topic, message);
    };
    if (record.topic === '/map' || record.topic === '/control/mode' || record.topic === '/system/runtime_mode' || record.topic === '/map_library/state') {
      const id = `subscribe:${record.topic}:${crypto.randomUUID()}`;
      const rawHandler = (message: RosbridgeMessage): void => {
        const payload = (message as unknown as { msg?: TopicMessage }).msg;
        if (payload) handler(payload);
      };
      record.rawId = id;
      record.rawHandler = rawHandler;
      ros.on(record.topic, rawHandler);
      ros.callOnConnection({
        op: 'subscribe', id, topic: record.topic, type: record.type,
        qos: { history: 'keep_last', depth: 1, reliability: 'reliable', durability: 'transient_local' },
      } as unknown as RosbridgeMessage);
      return;
    }
    const subscription = new Topic<TopicMessage>({ ros, name: record.topic, messageType: record.type, queue_length: 1 });
    subscription.subscribe(handler);
    record.activeTopic = subscription;
  }

  private detachSubscription(record: SubscriptionRecord): void {
    record.activeTopic?.unsubscribe();
    record.activeTopic = null;
    if (record.rawId && this.ros) {
      this.ros.callOnConnection({ op: 'unsubscribe', id: record.rawId, topic: record.topic });
      if (record.rawHandler) this.ros.off(record.topic, record.rawHandler);
    }
    record.rawId = null;
    record.rawHandler = null;
  }

  private clearActiveHandles(): void {
    this.publishers.forEach((publisher) => publisher.unadvertise());
    this.publishers.clear();
    this.subscriptions.forEach((record) => {
      record.activeTopic = null;
      record.rawId = null;
      record.rawHandler = null;
    });
    this.navigationAction = null;
    this.activeGoalId = null;
    this.graphSnapshotRequest = null;
  }

  getConnectionState(): ConnectionState { return this.state; }

  getGraphSnapshot(): Promise<RosGraphSnapshot> {
    const ros = this.ros;
    if (!ros || this.state !== 'CONNECTED') return Promise.resolve(EMPTY_GRAPH);
    if (this.graphSnapshotRequest?.ros === ros) return this.graphSnapshotRequest.promise;
    const promise = this.queryGraphSnapshot(ros);
    this.graphSnapshotRequest = { ros, promise };
    const clearRequest = (): void => {
      if (this.graphSnapshotRequest?.promise === promise) this.graphSnapshotRequest = null;
    };
    void promise.then(clearRequest, clearRequest);
    return promise;
  }

  private async queryGraphSnapshot(ros: Ros): Promise<RosGraphSnapshot> {
    // rosbridge can time out lifecycle_manager's std_srvs/Trigger response
    // after rosapi graph queries even while Nav2 is fully active.  Read the
    // managed lifecycle nodes themselves before issuing nodes/topics/actions.
    // Node presence is still checked by rosGraphHealth, so this representative
    // active state is combined with the complete required-node rule.
    const serviceList = await new Promise<string[]>((resolve) => ros.getServices(resolve, () => resolve([])));
    const hasManager = (manager: 'mapping' | 'navigation'): boolean => serviceList.includes(`/lifecycle_manager_${manager}/is_active`);
    const lifecycleEvidence = (
      manager: 'mapping' | 'navigation',
      node: '/slam_toolbox' | '/controller_server',
    ): Promise<boolean | null> => {
      if (!hasManager(manager)) return Promise.resolve(null);
      if (!serviceList.includes(`${node}/get_state`)) return Promise.resolve(false);
      return lifecycleNodeIsActive(ros, node);
    };
    const [mapping, navigation] = await Promise.all([
      lifecycleEvidence('mapping', '/slam_toolbox'),
      lifecycleEvidence('navigation', '/controller_server'),
    ]);
    const [nodeList, topicList, actionList] = await Promise.all([
      new Promise<string[]>((resolve) => ros.getNodes(resolve, () => resolve([]))),
      new Promise<string[]>((resolve) => ros.getTopics((result) => resolve(result.topics), () => resolve([]))),
      new Promise<string[]>((resolve) => ros.getActionServers(resolve, () => resolve([]))),
    ]);
    if (this.ros !== ros || this.state !== 'CONNECTED') return EMPTY_GRAPH;
    return {
      nodes: nodeList.sort(),
      topics: topicList.sort(),
      actions: actionList.sort(),
      lifecycleManagers: { mapping, navigation },
    };
  }

  sendNavigationGoal(goal: PoseStampedMessage, callbacks: NavigationGoalCallbacks): string | null {
    if (!this.navigationAction || this.state !== 'CONNECTED') { callbacks.onError(normalizeNavigationGoalError('Nav2へ接続できていません。')); return null; }
    this.cancelNavigationGoal();
    let sentGoalId: string | null = null;
    const clearIfStillActive = (): void => {
      if (sentGoalId !== null && this.activeGoalId === sentGoalId) this.activeGoalId = null;
    };
    const id = this.navigationAction.sendGoal(
      { pose: goal },
      (result) => { clearIfStillActive(); callbacks.onResult(result); },
      callbacks.onFeedback,
      (error) => { clearIfStillActive(); callbacks.onError(normalizeNavigationGoalError(error)); },
    );
    sentGoalId = id ?? null;
    this.activeGoalId = sentGoalId;
    return this.activeGoalId;
  }

  cancelNavigationGoal(): void {
    if (this.activeGoalId && this.navigationAction) this.navigationAction.cancelGoal(this.activeGoalId);
    this.activeGoalId = null;
  }

  async saveMap(mapUrl: string): Promise<boolean> {
    const ros = this.ros;
    if (!ros || this.state !== 'CONNECTED') return false;
    const service = new Service<Record<string, unknown>, { result: boolean }>({ ros, name: '/map_saver/save_map', serviceType: 'nav2_msgs/srv/SaveMap' });
    return new Promise<boolean>((resolve) => service.callService({
      map_topic: '/map', map_url: mapUrl, image_format: 'pgm', map_mode: 'trinary', free_thresh: 0.25, occupied_thresh: 0.65,
    }, (response) => resolve(Boolean(response.result)), () => resolve(false), 10));
  }

  async resetMap(): Promise<boolean> {
    const ros = this.ros;
    if (!ros || this.state !== 'CONNECTED') return false;
    const service = new Service<{ pause_new_measurements: boolean }, { result: number }>({ ros, name: '/slam_toolbox/reset', serviceType: 'slam_toolbox/srv/Reset' });
    return new Promise<boolean>((resolve) => service.callService(
      { pause_new_measurements: false },
      (response) => resolve(response.result === 0),
      () => resolve(false),
      10,
    ));
  }

  onEvent(listener: TransportListener): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onConnection(listener: ConnectionListener): () => void { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener); }
  dispose(): void { this.disconnect(); this.subscriptions.clear(); this.eventListeners.clear(); this.connectionListeners.clear(); }
  private emitTopicEvent(topic: TopicName, message: TopicMessage): void { this.eventListeners.forEach((listener) => listener({ topic, message, at: performance.now() })); }
  private setState(state: ConnectionState, detail?: string): void { this.state = state; this.connectionListeners.forEach((listener) => listener(state, detail)); }
}

/** Keeps the simulation stable while switching between the local bus and rosbridge. */
export class SwitchableTransportAdapter implements TransportAdapter {
  private active: TransportAdapter;
  private readonly subscriptions: Array<{ topic: TopicName; type: string; callback: TopicCallback; unsubscribe: () => void }> = [];
  private readonly eventListeners = new Set<TransportListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private unsubscribeEvents: () => void = () => undefined;
  private unsubscribeConnection: () => void = () => undefined;

  constructor(initial: TransportAdapter) { this.active = initial; this.attachListeners(); }
  private attachListeners(): void {
    this.unsubscribeEvents(); this.unsubscribeConnection();
    this.unsubscribeEvents = this.active.onEvent((event) => this.eventListeners.forEach((listener) => listener(event)));
    this.unsubscribeConnection = this.active.onConnection((state, detail) => this.connectionListeners.forEach((listener) => listener(state, detail)));
  }
  async connect(): Promise<void> { await this.active.connect(); }
  disconnect(): void { this.active.disconnect(); }
  publish(topic: TopicName, type: string, message: TopicMessage): void { this.active.publish(topic, type, message); }
  subscribe(topic: TopicName, type: string, callback: TopicCallback): () => void {
    const record = { topic, type, callback, unsubscribe: this.active.subscribe(topic, type, callback) };
    this.subscriptions.push(record);
    return () => { record.unsubscribe(); const index = this.subscriptions.indexOf(record); if (index >= 0) this.subscriptions.splice(index, 1); };
  }
  getConnectionState(): ConnectionState { return this.active.getConnectionState(); }
  getGraphSnapshot(): Promise<RosGraphSnapshot> { return this.active.getGraphSnapshot(); }
  sendNavigationGoal(goal: PoseStampedMessage, callbacks: NavigationGoalCallbacks): string | null { return this.active.sendNavigationGoal(goal, callbacks); }
  cancelNavigationGoal(): void { this.active.cancelNavigationGoal(); }
  saveMap(mapUrl: string): Promise<boolean> { return this.active.saveMap(mapUrl); }
  resetMap(): Promise<boolean> { return this.active.resetMap(); }
  onEvent(listener: TransportListener): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onConnection(listener: ConnectionListener): () => void { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener); }
  async setActive(next: TransportAdapter): Promise<void> {
    this.subscriptions.forEach((record) => record.unsubscribe());
    this.active.disconnect();
    this.active = next;
    this.attachListeners();
    this.subscriptions.forEach((record) => { record.unsubscribe = this.active.subscribe(record.topic, record.type, record.callback); });
    await this.active.connect();
  }
  dispose(): void { this.subscriptions.forEach((record) => record.unsubscribe()); this.subscriptions.length = 0; this.unsubscribeEvents(); this.unsubscribeConnection(); this.active.dispose(); this.eventListeners.clear(); this.connectionListeners.clear(); }
}

/** Prevents secondary browser screens from mutating a shared ROS runtime. */
export class ControlLeaseTransportAdapter implements TransportAdapter {
  constructor(private readonly delegate: TransportAdapter, private readonly canControl: () => boolean) {}

  private mutationAllowed(): boolean {
    return this.delegate.getConnectionState() === 'SIMULATED' || this.canControl();
  }

  connect(): Promise<void> { return this.delegate.connect(); }
  disconnect(): void { this.delegate.disconnect(); }
  publish(topic: TopicName, type: string, message: TopicMessage): void {
    if (this.mutationAllowed()) this.delegate.publish(topic, type, message);
  }
  subscribe(topic: TopicName, type: string, callback: TopicCallback): () => void { return this.delegate.subscribe(topic, type, callback); }
  getConnectionState(): ConnectionState { return this.delegate.getConnectionState(); }
  getGraphSnapshot(): Promise<RosGraphSnapshot> { return this.delegate.getGraphSnapshot(); }
  sendNavigationGoal(goal: PoseStampedMessage, callbacks: NavigationGoalCallbacks): string | null {
    if (this.mutationAllowed()) return this.delegate.sendNavigationGoal(goal, callbacks);
    callbacks.onError(normalizeNavigationGoalError('別の画面がROS 2の操作権を所有しています。'));
    return null;
  }
  cancelNavigationGoal(): void { if (this.mutationAllowed()) this.delegate.cancelNavigationGoal(); }
  saveMap(mapUrl: string): Promise<boolean> { return this.mutationAllowed() ? this.delegate.saveMap(mapUrl) : Promise.resolve(false); }
  resetMap(): Promise<boolean> { return this.mutationAllowed() ? this.delegate.resetMap() : Promise.resolve(false); }
  onEvent(listener: TransportListener): () => void { return this.delegate.onEvent(listener); }
  onConnection(listener: ConnectionListener): () => void { return this.delegate.onConnection(listener); }
  dispose(): void { this.delegate.dispose(); }
}

export function topicType(topic: TopicName): string { return TOPICS.find((definition) => definition.name === topic)?.type ?? 'std_msgs/msg/String'; }
