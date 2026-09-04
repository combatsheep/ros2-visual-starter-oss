import * as THREE from 'three';

/** ROS x=前, y=左, z=上 to Three.js x=右, y=上, z=奥. */
export function rosVectorToThree(vector: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(-vector.y, vector.z, -vector.x);
}

export function threeVectorToRos(vector: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: -vector.z, y: -vector.x, z: vector.y };
}

export function rosYawToThreeQuaternion(yaw: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}

/** ROS yawをThree.js空間のロボット前方ベクトルへ変換する。 */
export function rosYawToThreeForward(yaw: number): THREE.Vector3 {
  return setRosYawToThreeForward(new THREE.Vector3(), yaw);
}

/** 高頻度sensor loop向けに、既存VectorへROS yawの前方を書き込む。 */
export function setRosYawToThreeForward(target: THREE.Vector3, yaw: number): THREE.Vector3 {
  return target.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/** ROS mapの北（+Y）を、map Canvasと同じ上向きにするThree.jsベクトル。 */
export function rosMapNorthToThree(): THREE.Vector3 {
  return rosVectorToThree({ x: 0, y: 1, z: 0 });
}

/** nav_msgs/Odometryで使う、ROS z軸まわりのyaw Quaternion。 */
export function rosYawToRosQuaternion(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
}

export function threeQuaternionToRosYaw(quaternion: THREE.Quaternion): number {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
  return euler.y;
}
