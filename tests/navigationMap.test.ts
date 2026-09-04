import { describe, expect, it } from 'vitest';
import { EXPLORATION_NAVIGATION_TF_MAX_AGE_MS, applyPlanarTransform, canvasToWorld, closestStamped, createMapViewport, laserHitToWorld, makePose, mapCellToWorld, navigationTransformFreshness, quaternionToYaw, robotMarkerDimensions, selectMappingPose, transformOdomPoseToMap, viewportCanvasToWorld, worldToCanvas, worldToMapCell, worldToViewportCanvas } from '../src/navigationMap';
import { OccupancyGridMessage } from '../src/types';

const map: OccupancyGridMessage = {
  header: { frame_id: 'map', stamp: { sec: 0, nanosec: 0 } },
  info: {
    map_load_time: { sec: 0, nanosec: 0 }, resolution: .05, width: 200, height: 160,
    origin: { position: { x: -5, y: -4, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
  },
  data: [],
};

describe('navigation map coordinates', () => {
  it('classifies a delayed map-to-odom transform before exploration sends a goal', () => {
    const transform = {
      header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
      child_frame_id: 'odom',
      transform: { translation: { x: 0, y: 0, z: 0 }, rotation: makePose(0, 0).orientation },
    };
    expect(navigationTransformFreshness(transform, 100_000 + EXPLORATION_NAVIGATION_TF_MAX_AGE_MS)).toEqual({
      status: 'fresh',
      ageMs: EXPLORATION_NAVIGATION_TF_MAX_AGE_MS,
    });
    expect(navigationTransformFreshness(transform, 100_000 + EXPLORATION_NAVIGATION_TF_MAX_AGE_MS + 1)).toEqual({
      status: 'stale',
      ageMs: EXPLORATION_NAVIGATION_TF_MAX_AGE_MS + 1,
    });
    expect(navigationTransformFreshness(null, 100_000)).toEqual({ status: 'missing' });
    expect(navigationTransformFreshness({ ...transform, header: { ...transform.header, stamp: { sec: 102, nanosec: 0 } } }, 100_000)).toEqual({
      status: 'future',
      ageMs: -2000,
    });
  });

  it('round-trips ROS world and map cells', () => {
    const cell = worldToMapCell(map, { x: 1.25, y: -2.5 });
    expect(mapCellToWorld(map, cell)).toEqual({ x: 1.25, y: -2.5 });
  });

  it('round-trips canvas clicks and ROS map coordinates', () => {
    const point = { x: 2, y: 1 };
    const canvas = worldToCanvas(map, point, 720, 480);
    const restored = canvasToWorld(map, canvas, 720, 480);
    expect(restored.x).toBeCloseTo(point.x);
    expect(restored.y).toBeCloseTo(point.y);
  });

  it('scales the map robot marker from the training-room footprint', () => {
    const marker = robotMarkerDimensions(map, 720, 480);
    expect(marker.length).toBeGreaterThanOrEqual(24);
    expect(marker.width).toBeGreaterThan(marker.length);
    const zoomed = robotMarkerDimensions(map, 1440, 960);
    expect(zoomed.length).toBeGreaterThan(marker.length);
    expect(zoomed.width).toBeGreaterThan(marker.width);
  });

  it('fits the full map without distorting its aspect ratio', () => {
    const viewport = createMapViewport(map, 720, 480);
    expect(viewport.width / viewport.height).toBeCloseTo(map.info.width / map.info.height);
    expect(viewport.offsetX).toBeGreaterThanOrEqual(0);
    expect(viewport.offsetY).toBeGreaterThanOrEqual(0);
    expect(viewport.offsetX + viewport.width).toBeLessThanOrEqual(720);
    expect(viewport.offsetY + viewport.height).toBeLessThanOrEqual(480);
    const topMargin = viewport.offsetY;
    const bottomMargin = 480 - viewport.offsetY - viewport.height;
    expect(topMargin).toBeGreaterThanOrEqual(4);
    expect(bottomMargin).toBeGreaterThan(topMargin);
    expect(bottomMargin - topMargin).toBeLessThanOrEqual(24);
  });

  it('round-trips points through the fitted map viewport', () => {
    const point = { x: 2, y: 1 };
    const viewport = createMapViewport(map, 720, 480, 1.25);
    const restored = viewportCanvasToWorld(map, worldToViewportCanvas(map, point, viewport), viewport);
    expect(restored?.x).toBeCloseTo(point.x);
    expect(restored?.y).toBeCloseTo(point.y);
  });

  it('projects live LiDAR hits from the current map pose', () => {
    const pose = makePose(-2.65, 0, Math.PI / 2);
    const forwardHit = laserHitToWorld(pose, 0, 2);
    const rightHit = laserHitToWorld(pose, -Math.PI / 2, 1);
    expect(forwardHit.x).toBeCloseTo(-2.65);
    expect(forwardHit.y).toBeCloseTo(2);
    expect(rightHit.x).toBeCloseTo(-1.65);
    expect(rightHit.y).toBeCloseTo(0);
  });

  it('transforms the fixed training start from odom into the saved map frame', () => {
    const mapRobot = makePose(4, 1, Math.PI / 2);
    const odomRobot = makePose(1, 2, 0);
    const trainingStart = transformOdomPoseToMap(mapRobot, odomRobot, makePose(-2.65, 0, 0));
    expect(trainingStart.position.x).toBeCloseTo(6, 5);
    expect(trainingStart.position.y).toBeCloseTo(-2.65, 5);
    expect(trainingStart.orientation.z).toBeCloseTo(Math.sin(Math.PI / 4), 5);
    expect(trainingStart.orientation.w).toBeCloseTo(Math.cos(Math.PI / 4), 5);
  });

  it('applies the live map to odom transform to the training start', () => {
    const trainingStart = applyPlanarTransform({
      header: { frame_id: 'map', stamp: { sec: 0, nanosec: 0 } },
      child_frame_id: 'odom',
      transform: { translation: { x: 6, y: 0, z: 0 }, rotation: makePose(0, 0, Math.PI / 2).orientation },
    }, makePose(-2.65, 0, 0));
    expect(trainingStart.position.x).toBeCloseTo(6, 5);
    expect(trainingStart.position.y).toBeCloseTo(-2.65, 5);
  });

  it('keeps a moved odometry pose in the same map frame', () => {
    const movedPose = applyPlanarTransform({
      header: { frame_id: 'map', stamp: { sec: 12, nanosec: 0 } },
      child_frame_id: 'odom',
      transform: { translation: { x: 4, y: -1, z: 0 }, rotation: makePose(0, 0, Math.PI / 2).orientation },
    }, makePose(1, 2, Math.PI / 4));
    expect(movedPose.position.x).toBeCloseTo(2, 5);
    expect(movedPose.position.y).toBeCloseTo(0, 5);
    expect(quaternionToYaw(movedPose.orientation)).toBeCloseTo(3 * Math.PI / 4, 5);
  });

  it('matches odometry to the LaserScan timestamp instead of the latest pose', () => {
    const samples = [
      { header: { frame_id: 'odom', stamp: { sec: 10, nanosec: 0 } }, pose: makePose(0, 0, 0) },
      { header: { frame_id: 'odom', stamp: { sec: 10, nanosec: 101_000_000 } }, pose: makePose(1, 0, .2) },
      { header: { frame_id: 'odom', stamp: { sec: 10, nanosec: 201_000_000 } }, pose: makePose(2, 0, .4) },
    ];
    expect(closestStamped(samples, { sec: 10, nanosec: 100_000_000 }, 20)?.pose.position.x).toBe(1);
    expect(closestStamped(samples, { sec: 11, nanosec: 0 }, 20)).toBeNull();
  });

  it('prefers a newer synchronized map-to-odom and odom pose over a stale direct SLAM pose', () => {
    const staleSlamPose = {
      header: { frame_id: 'map', stamp: { sec: 10, nanosec: 0 } },
      pose: makePose(99, 0),
    };
    const mapToOdom = [{
      header: { frame_id: 'map', stamp: { sec: 20, nanosec: 100_000_000 } },
      child_frame_id: 'odom',
      transform: { translation: { x: 2, y: 0, z: 0 }, rotation: makePose(0, 0).orientation },
    }];
    const odom = [{
      header: { frame_id: 'odom', stamp: { sec: 20, nanosec: 0 } },
      pose: makePose(3, 0),
    }];

    const selected = selectMappingPose(staleSlamPose, mapToOdom, odom, 500);
    expect(selected?.source).toBe('tf-odom');
    expect(selected?.timestampMs).toBe(20_000);
    expect(selected?.pose.pose.position.x).toBeCloseTo(5);
  });

  it('keeps a newer direct SLAM pose when the synchronized TF pair is older', () => {
    const direct = {
      header: { frame_id: 'map', stamp: { sec: 21, nanosec: 0 } },
      pose: makePose(7, 1),
    };
    const mapToOdom = [{
      header: { frame_id: 'map', stamp: { sec: 20, nanosec: 0 } },
      child_frame_id: 'odom',
      transform: { translation: { x: 2, y: 0, z: 0 }, rotation: makePose(0, 0).orientation },
    }];
    const odom = [{
      header: { frame_id: 'odom', stamp: { sec: 20, nanosec: 0 } },
      pose: makePose(3, 0),
    }];

    expect(selectMappingPose(direct, mapToOdom, odom)?.source).toBe('slam-pose');
    expect(selectMappingPose(direct, mapToOdom, odom)?.pose).toBe(direct);
  });
});
