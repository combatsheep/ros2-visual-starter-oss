/**
 * Shared planar footprint for the teaching robot.
 *
 * Keep this in one place because the SIM collider, Nav2 costmaps, frontier
 * clearance, and map marker all need to describe the same robot.
 */
export const ROBOT_FOOTPRINT = {
  lengthMeters: 0.32,
  widthMeters: 0.40,
} as const;

export const ROBOT_CIRCUMSCRIBED_RADIUS_METERS = Math.hypot(
  ROBOT_FOOTPRINT.lengthMeters / 2,
  ROBOT_FOOTPRINT.widthMeters / 2,
);
export const ROBOT_SAFETY_MARGIN_METERS = 0.04;
/** Rounded-up physical footprint plus safety margin used by planning/Safety. */
export const ROBOT_SAFE_STOP_DISTANCE_METERS = Math.ceil(
  (ROBOT_CIRCUMSCRIBED_RADIUS_METERS + ROBOT_SAFETY_MARGIN_METERS) * 100,
) / 100;

export const ROBOT_GEOMETRY = {
  bodyCenterHeight: 0.18,
  bodyHeight: 0.3,
  colliderHalfHeight: 0.18,
  colliderHalfWidth: ROBOT_FOOTPRINT.widthMeters / 2,
  colliderHalfLength: ROBOT_FOOTPRINT.lengthMeters / 2,
  bodyWidth: 0.34,
  bodyLength: 0.30,
  wheelRadius: 0.08,
  wheelAxleWidth: 0.06,
  wheelCenterLocalX: 0.18,
  wheelCenterLocalY: -0.10,
  lidarHeight: 0.2,
  lidarCenterLocalY: 0.25,
  cameraCenterLocalY: 0.18,
  cameraHousingCenterLocalZ: -0.16,
  cameraLensCenterLocalZ: -0.198,
  cameraViewLocalZ: -0.22,
  frontArrowRadius: 0.065,
  frontArrowHeight: 0.17,
  frontArrowLocalY: 0,
  frontArrowLocalZ: -0.24,
} as const;

export function wheelGroundClearance(bodyCenterHeight: number = ROBOT_GEOMETRY.bodyCenterHeight): number {
  return bodyCenterHeight + ROBOT_GEOMETRY.wheelCenterLocalY - ROBOT_GEOMETRY.wheelRadius;
}

export function lidarWorldHeight(bodyCenterHeight: number = ROBOT_GEOMETRY.bodyCenterHeight): number {
  return bodyCenterHeight + ROBOT_GEOMETRY.lidarCenterLocalY;
}
