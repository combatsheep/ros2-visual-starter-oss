import cases from './fixtures/safety_cases.json';
import { describe, expect, it } from 'vitest';
import { decideSafeCommand } from '../src/safetyLogic';
import { LaserScanMessage } from '../src/types';

function scanWithFront(distance: number): LaserScanMessage {
  const ranges = Array.from({ length: 180 }, () => 8);
  ranges[90] = distance;
  return { header: { frame_id: 'laser_frame', stamp: { sec: 0, nanosec: 0 } }, angle_min: -Math.PI, angle_max: Math.PI - Math.PI / 90, angle_increment: Math.PI / 90, time_increment: 0, scan_time: .1, range_min: .05, range_max: 8, ranges, intensities: [] };
}

describe('shared safety fixtures', () => {
  for (const fixture of cases) {
    it(fixture.name, () => {
      const now = 1000;
      const result = decideSafeCommand({ linear: fixture.linear, angular: fixture.angular }, scanWithFront(fixture.front_distance), now, now - fixture.scan_age_ms, now - fixture.command_age_ms, fixture.was_stopped);
      expect(result.command.linear.x).toBe(fixture.expected_linear);
      expect(result.command.angular.z).toBe(fixture.expected_angular);
      expect(result.stopped).toBe(fixture.expected_stopped);
      expect(result.reason).toBe(fixture.reason);
    });
  }
});
