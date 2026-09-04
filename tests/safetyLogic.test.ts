import { describe, expect, it } from 'vitest';
import { decideSafeCommand, frontDistance } from '../src/safetyLogic';
import { LaserScanMessage } from '../src/types';

function scanWithFront(distance: number): LaserScanMessage {
  const ranges = Array.from({ length: 180 }, () => 8);
  ranges[90] = distance;
  return { header: { frame_id: 'laser_frame', stamp: { sec: 0, nanosec: 0 } }, angle_min: -Math.PI, angle_max: Math.PI - Math.PI / 90, angle_increment: Math.PI / 90, time_increment: 0, scan_time: .1, range_min: .05, range_max: 8, ranges, intensities: [] };
}

describe('safety logic', () => {
  it('finds the nearest valid ray in the front cone', () => {
    const scan = scanWithFront(1.2);
    scan.ranges[89] = .7;
    expect(frontDistance(scan)).toBe(.7);
  });

  it('stops forward motion under the stop distance but keeps turning', () => {
    const result = decideSafeCommand({ linear: 1, angular: .5 }, scanWithFront(.33), 1000, 900, 900, false);
    expect(result.stopped).toBe(true);
    expect(result.command.linear.x).toBe(0);
    expect(result.command.angular.z).toBe(.5);
  });

  it('allows reverse motion near an obstacle', () => {
    const result = decideSafeCommand({ linear: -.6, angular: 0 }, scanWithFront(.3), 1000, 900, 900, false);
    expect(result.stopped).toBe(false);
    expect(result.command.linear.x).toBe(-.6);
  });

  it('keeps a stop until the hysteresis resume distance is reached', () => {
    const result = decideSafeCommand({ linear: 1, angular: 0 }, scanWithFront(.38), 1000, 900, 900, true);
    expect(result.stopped).toBe(true);
    const resumed = decideSafeCommand({ linear: 1, angular: 0 }, scanWithFront(.43), 1000, 900, 900, true);
    expect(resumed.stopped).toBe(false);
  });

  it('stops when scan or command input is stale', () => {
    expect(decideSafeCommand({ linear: 1, angular: 0 }, scanWithFront(3), 2000, 1000, 1900, false).reason).toBe('scan-timeout');
    expect(decideSafeCommand({ linear: 1, angular: 0 }, scanWithFront(3), 2000, 1900, 1000, false).reason).toBe('command-timeout');
  });
});
