import { ControlInput, LaserScanMessage, SafetyDecision, makeTwist, zeroTwist } from './types';

export interface SafetyConfig {
  stopDistance: number;
  resumeDistance: number;
  frontAngleDeg: number;
  scanTimeoutSec: number;
  commandTimeoutSec: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  stopDistance: 0.34,
  resumeDistance: 0.42,
  frontAngleDeg: 15,
  scanTimeoutSec: 0.5,
  commandTimeoutSec: 0.5,
};

export function frontDistance(scan: LaserScanMessage, frontAngleDeg = DEFAULT_SAFETY_CONFIG.frontAngleDeg): number {
  const limit = (frontAngleDeg * Math.PI) / 180;
  let closest = Number.POSITIVE_INFINITY;
  scan.ranges.forEach((range, index) => {
    const angle = scan.angle_min + scan.angle_increment * index;
    if (Math.abs(angle) <= limit && Number.isFinite(range) && range >= scan.range_min && range <= scan.range_max) {
      closest = Math.min(closest, range);
    }
  });
  return closest;
}

export function decideSafeCommand(
  raw: ControlInput,
  scan: LaserScanMessage | null,
  now: number,
  lastScanAt: number,
  lastCommandAt: number,
  wasStopped: boolean,
  config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
): SafetyDecision {
  if (now - lastCommandAt > config.commandTimeoutSec * 1000) {
    return { command: zeroTwist(), stopped: true, frontDistance: Number.POSITIVE_INFINITY, reason: 'command-timeout' };
  }
  if (!scan || now - lastScanAt > config.scanTimeoutSec * 1000) {
    return { command: zeroTwist(), stopped: true, frontDistance: Number.POSITIVE_INFINITY, reason: 'scan-timeout' };
  }

  const distance = frontDistance(scan, config.frontAngleDeg);
  const blocked = distance < config.stopDistance;
  const canResume = distance >= config.resumeDistance || !Number.isFinite(distance);
  const stopped = raw.linear > 0 && (blocked || (wasStopped && !canResume));
  return {
    command: stopped ? makeTwist(0, raw.angular) : makeTwist(raw.linear, raw.angular),
    stopped,
    frontDistance: distance,
    reason: stopped ? 'obstacle' : 'clear',
  };
}
