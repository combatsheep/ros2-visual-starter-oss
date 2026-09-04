import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { rosMapNorthToThree, rosVectorToThree, rosYawToRosQuaternion, rosYawToThreeForward, rosYawToThreeQuaternion, setRosYawToThreeForward, threeQuaternionToRosYaw, threeVectorToRos } from '../src/coordinateTransform';

describe('coordinate transform', () => {
  it('maps ROS axes to the browser world', () => {
    expect(rosVectorToThree({ x: 1, y: 2, z: 3 }).toArray()).toEqual([-2, 3, -1]);
    expect(threeVectorToRos(new THREE.Vector3(-2, 3, -1))).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('keeps robot forward and visual rotation aligned after turning', () => {
    const leftForward = rosYawToThreeForward(Math.PI / 2);
    const visualForward = new THREE.Vector3(0, 0, -1).applyQuaternion(rosYawToThreeQuaternion(Math.PI / 2));

    expect(leftForward.x).toBeCloseTo(-1);
    expect(leftForward.z).toBeCloseTo(0);
    expect(visualForward.x).toBeCloseTo(leftForward.x);
    expect(visualForward.z).toBeCloseTo(leftForward.z);
    expect(threeQuaternionToRosYaw(rosYawToThreeQuaternion(Math.PI / 2))).toBeCloseTo(Math.PI / 2);
  });

  it('updates a reusable forward vector without allocating a replacement', () => {
    const target = new THREE.Vector3();

    expect(setRosYawToThreeForward(target, Math.PI / 2)).toBe(target);
    expect(target.x).toBeCloseTo(-1);
    expect(target.z).toBeCloseTo(0);
  });

  it('projects all cardinal headings like the north-up map canvas', () => {
    const cameraUp = rosMapNorthToThree();
    const cameraBackward = new THREE.Vector3(0, 1, 0);
    const cameraRight = new THREE.Vector3().crossVectors(cameraUp, cameraBackward).normalize();
    const cases = [
      { yaw: 0, canvas: { x: 1, y: 0 } },
      { yaw: Math.PI / 2, canvas: { x: 0, y: -1 } },
      { yaw: Math.PI, canvas: { x: -1, y: 0 } },
      { yaw: -Math.PI / 2, canvas: { x: 0, y: 1 } },
    ];

    for (const testCase of cases) {
      const forward = rosYawToThreeForward(testCase.yaw);
      expect(forward.dot(cameraRight)).toBeCloseTo(testCase.canvas.x);
      expect(-forward.dot(cameraUp)).toBeCloseTo(testCase.canvas.y);
    }
  });

  it('encodes ROS yaw around the z axis for odometry', () => {
    const orientation = rosYawToRosQuaternion(Math.PI / 2);

    expect(orientation.x).toBe(0);
    expect(orientation.y).toBe(0);
    expect(orientation.z).toBeCloseTo(Math.SQRT1_2);
    expect(orientation.w).toBeCloseTo(Math.SQRT1_2);
  });
});
