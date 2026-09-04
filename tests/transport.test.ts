import { describe, expect, it, vi } from 'vitest';
import { ControlLeaseTransportAdapter, LocalTopicBusAdapter, RosbridgeAdapter } from '../src/transport';
import { makeTwist, type NavigationGoalCallbacks, type NavigationGoalError, type PoseStampedMessage, type TopicMessage } from '../src/types';

describe('local topic bus', () => {
  it('publishes typed messages to subscribers and event listeners', async () => {
    const bus = new LocalTopicBusAdapter();
    const received: number[] = [];
    const events: string[] = [];
    bus.subscribe('/cmd_vel', 'geometry_msgs/msg/Twist', (message) => received.push((message as ReturnType<typeof makeTwist>).linear.x));
    bus.onEvent((event) => events.push(event.topic));
    await bus.connect();
    bus.publish('/cmd_vel', 'geometry_msgs/msg/Twist', makeTwist(.5, 0));
    expect(received).toEqual([.5]);
    expect(events).toEqual(['/cmd_vel']);
  });
});

describe('shared ROS browser control ownership', () => {
  it('allows independent SIM topics but blocks ROS mutations from a viewer', async () => {
    const bus = new LocalTopicBusAdapter();
    let owner = false;
    const guarded = new ControlLeaseTransportAdapter(bus, () => owner);
    const received: number[] = [];
    bus.subscribe('/cmd_vel_manual', 'geometry_msgs/msg/Twist', (message) => received.push((message as ReturnType<typeof makeTwist>).linear.x));

    guarded.publish('/cmd_vel_manual', 'geometry_msgs/msg/Twist', makeTwist(.4, 0));
    expect(received).toEqual([.4]);

    Object.assign(bus as unknown as Record<string, unknown>, { state: 'CONNECTED' });
    guarded.publish('/cmd_vel_manual', 'geometry_msgs/msg/Twist', makeTwist(.8, 0));
    expect(received).toEqual([.4]);
    await expect(guarded.saveMap('maps/test')).resolves.toBe(false);
    await expect(guarded.resetMap()).resolves.toBe(false);

    owner = true;
    guarded.publish('/cmd_vel_manual', 'geometry_msgs/msg/Twist', makeTwist(.6, 0));
    expect(received).toEqual([.4, .6]);
  });

  it('rejects a viewer goal at the Transport boundary without forwarding it', () => {
    const bus = new LocalTopicBusAdapter();
    Object.assign(bus as unknown as Record<string, unknown>, { state: 'CONNECTED' });
    const forwarded = vi.spyOn(bus, 'sendNavigationGoal');
    const guarded = new ControlLeaseTransportAdapter(bus, () => false);
    const goal: PoseStampedMessage = {
      header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
      pose: { position: { x: 1, y: 2, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    };
    const errors: NavigationGoalError[] = [];

    const id = guarded.sendNavigationGoal(goal, {
      onFeedback: () => undefined,
      onResult: () => undefined,
      onError: (error) => errors.push(error),
    });

    expect(id).toBeNull();
    expect(forwarded).not.toHaveBeenCalled();
    expect(errors[0]?.message).toContain('別の画面');
  });
});

describe('rosbridge navigation goal ownership', () => {
  it('does not let a late result or error from an old goal clear the newer active goal', () => {
    const goal: PoseStampedMessage = {
      header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
      pose: {
        position: { x: 1, y: 2, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
    const captured: Array<{
      onResult: (result: unknown) => void;
      onError: (error: string) => void;
    }> = [];
    const canceled: string[] = [];
    const fakeAction = {
      sendGoal: (
        _goal: unknown,
        onResult: (result: unknown) => void,
        _onFeedback: (feedback: unknown) => void,
        onError: (error: string) => void,
      ): string => {
        captured.push({ onResult, onError });
        return `goal-${captured.length}`;
      },
      cancelGoal: (id: string): void => { canceled.push(id); },
    };
    const adapter = new RosbridgeAdapter();
    Object.assign(adapter as unknown as Record<string, unknown>, {
      navigationAction: fakeAction,
      state: 'CONNECTED',
    });
    const results: string[] = [];
    const errors: string[] = [];
    const callbacks = (label: string): NavigationGoalCallbacks => ({
      onFeedback: () => undefined,
      onResult: (result) => results.push(`${label}:${String(result)}`),
      onError: (error) => errors.push(`${label}:${error.status}:${error.message}`),
    });

    expect(adapter.sendNavigationGoal(goal, callbacks('first'))).toBe('goal-1');
    expect(adapter.sendNavigationGoal(goal, callbacks('second'))).toBe('goal-2');
    expect(canceled).toEqual(['goal-1']);
    captured[0].onResult('late-result');
    adapter.cancelNavigationGoal();
    expect(canceled).toEqual(['goal-1', 'goal-2']);
    expect(results).toEqual(['first:late-result']);

    expect(adapter.sendNavigationGoal(goal, callbacks('third'))).toBe('goal-3');
    expect(adapter.sendNavigationGoal(goal, callbacks('fourth'))).toBe('goal-4');
    expect(canceled).toEqual(['goal-1', 'goal-2', 'goal-3']);
    captured[2].onError('late-error');
    adapter.cancelNavigationGoal();
    expect(canceled).toEqual(['goal-1', 'goal-2', 'goal-3', 'goal-4']);
    expect(errors).toEqual(['third:failed:late-error']);
  });

  it('normalizes roslib goal failures at the Transport boundary', () => {
    const goal: PoseStampedMessage = {
      header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
      pose: {
        position: { x: 1, y: 2, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
    const capturedErrors: Array<(error: string) => void> = [];
    const fakeAction = {
      sendGoal: (
        _goal: unknown,
        _onResult: (result: unknown) => void,
        _onFeedback: (feedback: unknown) => void,
        onError: (error: string) => void,
      ): string => {
        capturedErrors.push(onError);
        return `goal-${capturedErrors.length}`;
      },
      cancelGoal: (): void => undefined,
    };
    const adapter = new RosbridgeAdapter();
    Object.assign(adapter as unknown as Record<string, unknown>, {
      navigationAction: fakeAction,
      state: 'CONNECTED',
    });
    const errors: NavigationGoalError[] = [];
    const callbacks: NavigationGoalCallbacks = {
      onFeedback: () => undefined,
      onResult: () => undefined,
      onError: (error) => errors.push(error),
    };

    adapter.sendNavigationGoal(goal, callbacks);
    capturedErrors[0]('GoalError: Action was canceled: {"status":5}');
    adapter.sendNavigationGoal(goal, callbacks);
    capturedErrors[1]('GoalError: Action was aborted: {"status":6}');
    adapter.sendNavigationGoal(goal, callbacks);
    capturedErrors[2]('socket closed');

    expect(errors).toEqual([
      { status: 'canceled', message: 'GoalError: Action was canceled: {"status":5}' },
      { status: 'aborted', message: 'GoalError: Action was aborted: {"status":6}' },
      { status: 'failed', message: 'socket closed' },
    ]);
  });
});

describe('rosbridge connection session isolation', () => {
  it('stays CONNECTING until the WebSocket actually emits connection', async () => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', origin: 'http://localhost:27182' },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const fakeRos = {
      on: (event: string, listener: (...args: unknown[]) => void): void => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      off: (event: string, listener: (...args: unknown[]) => void): void => { listeners.get(event)?.delete(listener); },
      connect: async (): Promise<void> => undefined,
      close: (): void => undefined,
    };
    const adapter = new RosbridgeAdapter(() => fakeRos as unknown as import('roslib').Ros, 1_000);
    const states: string[] = [];
    adapter.onConnection((state) => states.push(state));

    const connecting = adapter.connect();
    await Promise.resolve();
    expect(adapter.getConnectionState()).toBe('CONNECTING');
    expect(states).toEqual(['CONNECTING']);

    listeners.get('connection')?.forEach((listener) => listener({}));
    await connecting;
    expect(adapter.getConnectionState()).toBe('CONNECTED');
    expect(states).toEqual(['CONNECTING', 'CONNECTED']);
    vi.unstubAllGlobals();
  });

  it('drops a topic callback retained by an older Ros connection', () => {
    type RawHandler = (message: { msg?: TopicMessage }) => void;
    const rawHandlers: RawHandler[] = [];
    const firstRos = {
      on: (_topic: string, handler: RawHandler): void => { rawHandlers.push(handler); },
      callOnConnection: (): void => undefined,
    };
    const secondRos = {
      on: (): void => undefined,
      callOnConnection: (): void => undefined,
    };
    const adapter = new RosbridgeAdapter();
    const received: TopicMessage[] = [];
    const events: string[] = [];
    adapter.onEvent((event) => events.push(event.topic));
    const record = {
      topic: '/map' as const,
      type: 'nav_msgs/msg/OccupancyGrid',
      callback: (message: TopicMessage): void => { received.push(message); },
      activeTopic: null,
      rawId: null,
      rawHandler: null,
    };
    const internal = adapter as unknown as {
      ros: unknown;
      state: string;
      attachSubscription: (subscription: typeof record) => void;
    };
    internal.ros = firstRos;
    internal.state = 'CONNECTED';
    internal.attachSubscription(record);

    const currentMessage = { data: 'current-session' } as TopicMessage;
    rawHandlers[0]({ msg: currentMessage });
    expect(received).toEqual([currentMessage]);
    expect(events).toEqual(['/map']);

    internal.ros = secondRos;
    const staleMessage = { data: 'old-session' } as TopicMessage;
    rawHandlers[0]({ msg: staleMessage });
    expect(received).toEqual([currentMessage]);
    expect(events).toEqual(['/map']);
  });

  it('coalesces overlapping graph queries and reads managed lifecycle nodes before rosapi graph calls', async () => {
    type OnceCallback = (message: {
      op: string;
      id: string;
      result: boolean;
      values: { current_state: { id: number; label: string } };
    }) => void;
    const onceCallbacks = new Map<string, OnceCallback>();
    const lifecycleTimeouts: number[] = [];
    const callOrder: string[] = [];
    let graphQueryCount = 0;
    const fakeRos = {
      getServices: (callback: (services: string[]) => void): void => {
        callOrder.push('services');
        callback([
          '/lifecycle_manager_mapping/is_active',
          '/lifecycle_manager_navigation/is_active',
          '/slam_toolbox/get_state',
          '/controller_server/get_state',
        ]);
      },
      getNodes: (callback: (nodes: string[]) => void): void => {
        graphQueryCount += 1;
        callOrder.push('nodes');
        callback(['/lifecycle_manager_mapping', '/lifecycle_manager_navigation']);
      },
      getTopics: (callback: (result: { topics: string[] }) => void): void => { callOrder.push('topics'); callback({ topics: [] }); },
      getActionServers: (callback: (actions: string[]) => void): void => { callOrder.push('actions'); callback(['/navigate_to_pose']); },
      once: (id: string, callback: OnceCallback): void => { onceCallbacks.set(id, callback); },
      callOnConnection: (message: { op: string; id: string; service?: string; timeout?: number }): void => {
        if (message.op !== 'call_service') return;
        callOrder.push(String(message.service));
        lifecycleTimeouts.push(message.timeout ?? 0);
        onceCallbacks.get(message.id)?.({
          op: 'service_response',
          id: message.id,
          result: true,
          values: { current_state: { id: 3, label: 'active' } },
        });
      },
    };
    const adapter = new RosbridgeAdapter();
    const internal = adapter as unknown as { ros: unknown; state: string };
    internal.ros = fakeRos;
    internal.state = 'CONNECTED';

    const first = adapter.getGraphSnapshot();
    const overlapping = adapter.getGraphSnapshot();
    expect(overlapping).toBe(first);
    await expect(first).resolves.toMatchObject({
      actions: ['/navigate_to_pose'],
      lifecycleManagers: { mapping: true, navigation: true },
    });
    expect(graphQueryCount).toBe(1);
    expect(lifecycleTimeouts).toEqual([3, 3]);
    expect(callOrder.slice(0, 6)).toEqual([
      'services',
      '/slam_toolbox/get_state',
      '/controller_server/get_state',
      'nodes',
      'topics',
      'actions',
    ]);

    const nextPoll = adapter.getGraphSnapshot();
    expect(nextPoll).not.toBe(first);
    await nextPoll;
    expect(graphQueryCount).toBe(2);
    expect(lifecycleTimeouts).toEqual([3, 3, 3, 3]);
  });
});
