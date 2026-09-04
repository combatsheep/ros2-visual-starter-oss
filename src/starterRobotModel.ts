import * as THREE from 'three';
import { ROBOT_GEOMETRY } from './robotGeometry';

/**
 * Neutral, geometry-only placeholder used until a redistributable original
 * robot asset is supplied. Physics, LiDAR and camera frames remain owned by
 * Simulation; this module is visual-only.
 */
export interface StarterRobotModel {
  group: THREE.Group;
  wheels: THREE.Mesh[];
}

function standardMaterial(color: number, metalness = .05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: .72, metalness });
}

export function createStarterRobotModel(): StarterRobotModel {
  const group = new THREE.Group();
  group.name = 'starterRobotPlaceholder';
  group.userData.placeholder = true;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(.42, .24, .36),
    standardMaterial(0x4f7f86, .12),
  );
  body.position.y = .01;
  body.castShadow = true;
  body.receiveShadow = true;
  body.name = 'body';
  group.add(body);

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(.25, .09, .2),
    standardMaterial(0xd8ebe7),
  );
  top.position.set(0, .175, -.015);
  top.castShadow = true;
  top.name = 'sensorDeck';
  group.add(top);

  const lidar = new THREE.Mesh(
    new THREE.CylinderGeometry(.055, .055, .035, 20),
    standardMaterial(0x213c45, .2),
  );
  lidar.position.y = ROBOT_GEOMETRY.lidarCenterLocalY;
  lidar.castShadow = true;
  lidar.name = 'lidarHousing';
  group.add(lidar);

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(.025, .025, .025, 16),
    standardMaterial(0x182a33, .25),
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, ROBOT_GEOMETRY.cameraCenterLocalY, ROBOT_GEOMETRY.cameraLensCenterLocalZ);
  lens.name = 'cameraLens';
  group.add(lens);

  const wheelGeometry = new THREE.CylinderGeometry(
    ROBOT_GEOMETRY.wheelRadius,
    ROBOT_GEOMETRY.wheelRadius,
    .07,
    20,
  );
  const wheelMaterial = standardMaterial(0x27363b, .08);
  const wheels = [-1, 1].map((side, index) => {
    const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * .245, ROBOT_GEOMETRY.wheelCenterLocalY, 0);
    wheel.castShadow = true;
    wheel.name = index === 0 ? 'leftWheel' : 'rightWheel';
    group.add(wheel);
    return wheel;
  });

  return { group, wheels };
}
