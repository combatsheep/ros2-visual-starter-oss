import { describe, expect, it } from 'vitest';
import { evaluateExplorationReadinessHealth, evaluateRosGraphHealth, evaluateRuntimeRosGraphHealth, rosGraphRuleForMode } from '../src/rosGraphHealth';

describe('ROS graph health', () => {
  const required = ['/safety_controller', '/controller_server'];

  it('reports a node missing from initial startup after the grace checks', () => {
    const first = evaluateRosGraphHealth(required, ['/safety_controller'], 0);
    const second = evaluateRosGraphHealth(required, ['/safety_controller'], first.consecutiveMissingChecks);
    expect(first.shouldStop).toBe(false);
    expect(second).toEqual({
      missing: ['/controller_server'],
      forbidden: [],
      notActiveLifecycleManagers: [],
      consecutiveMissingChecks: 2,
      shouldStop: true,
      ready: false,
    });
  });

  it('reports only once while the same outage continues', () => {
    const result = evaluateRosGraphHealth(required, [], 2);
    expect(result.consecutiveMissingChecks).toBe(2);
    expect(result.shouldStop).toBe(false);
  });

  it('resets the grace period after all required nodes recover', () => {
    const recovered = evaluateRosGraphHealth(required, required, 2);
    expect(recovered).toEqual({
      missing: [],
      forbidden: [],
      notActiveLifecycleManagers: [],
      consecutiveMissingChecks: 0,
      shouldStop: false,
      ready: true,
    });
  });

  it('requires online SLAM and Nav2 but forbids Map Server and AMCL in exploration', () => {
    const rule = rosGraphRuleForMode('exploration');
    expect(rule.required).toContain('/slam_toolbox');
    expect(rule.required).toContain('/controller_server');
    expect(rule.required).toContain('/lifecycle_manager_mapping');
    expect(rule.required).toContain('/lifecycle_manager_navigation');
    expect(rule.required).toContain('/navigation_lifecycle_coordinator');
    expect(rule.required).not.toContain('/map_server');
    expect(rule.required).not.toContain('/amcl');
    expect(rule.forbidden).toEqual(['/map_server', '/amcl']);
  });

  it('stops when a forbidden fixed-localization node remains in exploration', () => {
    const rule = rosGraphRuleForMode('exploration');
    const available = [...rule.required, '/amcl'];
    const first = evaluateRuntimeRosGraphHealth('exploration', available, 0);
    const second = evaluateRuntimeRosGraphHealth('exploration', available, first.consecutiveMissingChecks);
    expect(first.shouldStop).toBe(false);
    expect(second).toEqual({
      missing: [],
      forbidden: ['/amcl'],
      notActiveLifecycleManagers: ['/lifecycle_manager_mapping', '/lifecycle_manager_navigation'],
      consecutiveMissingChecks: 2,
      shouldStop: true,
      ready: false,
    });
  });

  it('does not treat configured but inactive Nav2 as exploration-ready', () => {
    const rule = rosGraphRuleForMode('exploration');
    const inactive = evaluateRuntimeRosGraphHealth(
      'exploration',
      rule.required,
      0,
      { mapping: true, navigation: false },
    );
    expect(inactive).toMatchObject({
      missing: [],
      forbidden: [],
      notActiveLifecycleManagers: ['/lifecycle_manager_navigation'],
      shouldStop: false,
      ready: false,
    });

    const transitionInProgress = evaluateRuntimeRosGraphHealth(
      'exploration',
      rule.required,
      0,
      { mapping: true, navigation: null },
    );
    expect(transitionInProgress).toMatchObject({
      notActiveLifecycleManagers: ['/lifecycle_manager_navigation'],
      ready: false,
    });

    const active = evaluateRuntimeRosGraphHealth(
      'exploration',
      rule.required,
      0,
      { mapping: true, navigation: true },
    );
    expect(active).toMatchObject({
      notActiveLifecycleManagers: [],
      ready: true,
    });
  });

  it('counts an inactive fixed-map lifecycle manager toward the safe-stop grace period', () => {
    const rule = rosGraphRuleForMode('navigation');
    const first = evaluateRuntimeRosGraphHealth(
      'navigation',
      rule.required,
      0,
      { mapping: false, navigation: false },
    );
    const second = evaluateRuntimeRosGraphHealth(
      'navigation',
      rule.required,
      first.consecutiveMissingChecks,
      { mapping: false, navigation: false },
    );

    expect(first).toMatchObject({
      missing: [],
      forbidden: [],
      notActiveLifecycleManagers: ['/lifecycle_manager_navigation'],
      consecutiveMissingChecks: 1,
      shouldStop: false,
      ready: false,
    });
    expect(second).toMatchObject({
      consecutiveMissingChecks: 2,
      shouldStop: true,
      ready: false,
    });

    const recovered = evaluateRuntimeRosGraphHealth(
      'navigation',
      rule.required,
      second.consecutiveMissingChecks,
      { mapping: false, navigation: true },
    );
    expect(recovered).toMatchObject({
      notActiveLifecycleManagers: [],
      consecutiveMissingChecks: 0,
      shouldStop: false,
      ready: true,
    });
  });

  it('graces one transient lifecycle timeout, invalidates on the bounded repeat, and resets after success', () => {
    const rule = rosGraphRuleForMode('exploration');
    const timedOut = evaluateRuntimeRosGraphHealth(
      'exploration',
      rule.required,
      0,
      { mapping: true, navigation: null },
    );
    const first = evaluateExplorationReadinessHealth(timedOut, true, 0, true);
    expect(first).toEqual({
      ready: false,
      consecutiveFailureChecks: 1,
      shouldInvalidateReadiness: false,
    });

    const second = evaluateExplorationReadinessHealth(timedOut, true, first.consecutiveFailureChecks, true);
    expect(second).toEqual({
      ready: false,
      consecutiveFailureChecks: 2,
      shouldInvalidateReadiness: true,
    });
    expect(evaluateExplorationReadinessHealth(timedOut, true, second.consecutiveFailureChecks, true)).toEqual({
      ready: false,
      consecutiveFailureChecks: 2,
      shouldInvalidateReadiness: false,
    });

    const active = evaluateRuntimeRosGraphHealth(
      'exploration',
      rule.required,
      0,
      { mapping: true, navigation: true },
    );
    expect(evaluateExplorationReadinessHealth(active, true, second.consecutiveFailureChecks, true)).toEqual({
      ready: true,
      consecutiveFailureChecks: 0,
      shouldInvalidateReadiness: false,
    });
  });

  it('does not invalidate startup readiness before Nav2 health was ever accepted', () => {
    const notReady = { ready: false };
    const first = evaluateExplorationReadinessHealth(notReady, true, 0, false);
    const second = evaluateExplorationReadinessHealth(notReady, true, first.consecutiveFailureChecks, false);
    expect(second).toEqual({
      ready: false,
      consecutiveFailureChecks: 2,
      shouldInvalidateReadiness: false,
    });
  });

  it('keeps fixed-map navigation and online exploration node rules separate', () => {
    const navigation = rosGraphRuleForMode('navigation');
    const exploration = rosGraphRuleForMode('exploration');
    expect(navigation.required).toContain('/map_server');
    expect(navigation.required).toContain('/amcl');
    expect(navigation.forbidden).toContain('/slam_toolbox');
    expect(exploration.required).toContain('/slam_toolbox');
    expect(exploration.forbidden).toContain('/amcl');
  });
});
