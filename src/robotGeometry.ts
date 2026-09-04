export const ROBOT_GEOMETRY = {
  bodyCenterHeight: 0.18,
  bodyHeight: 0.3,
  colliderHalfHeight: 0.18,
  wheelRadius: 0.095,
  wheelCenterLocalY: -0.085,
  lidarHeight: 0.2,
  lidarCenterLocalY: 0.25,
  cameraCenterLocalY: 0.18,
  cameraHousingCenterLocalZ: -0.19,
  cameraLensCenterLocalZ: -0.234,
  cameraViewLocalZ: -0.25,
  frontArrowRadius: 0.075,
  frontArrowHeight: 0.2,
  frontArrowLocalY: 0,
  frontArrowLocalZ: -0.29,
} as const;

export function wheelGroundClearance(bodyCenterHeight: number = ROBOT_GEOMETRY.bodyCenterHeight): number {
  return bodyCenterHeight + ROBOT_GEOMETRY.wheelCenterLocalY - ROBOT_GEOMETRY.wheelRadius;
}

export function lidarWorldHeight(bodyCenterHeight: number = ROBOT_GEOMETRY.bodyCenterHeight): number {
  return bodyCenterHeight + ROBOT_GEOMETRY.lidarCenterLocalY;
}
