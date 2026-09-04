import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { rosMapNorthToThree, rosYawToRosQuaternion, rosYawToThreeForward, rosYawToThreeQuaternion, setRosYawToThreeForward } from './coordinateTransform';
import { quaternionToYaw } from './navigationMap';
import { lidarWorldHeight, ROBOT_GEOMETRY } from './robotGeometry';
import { createStarterRobotModel } from './starterRobotModel';
import { DEFAULT_PLAYGROUND, PLAYGROUND_STAGE_PRESETS, getVisionTargetAssetByUrl, type PlaygroundDefinition, type PlaygroundObject, type PlaygroundStageSize } from './playground';
import { decideSafeCommand, DEFAULT_SAFETY_CONFIG } from './safetyLogic';
import {
  lidarAngleAt,
  lidarAngleIncrement,
  lidarAngleMax,
  lidarScanRange,
  lidarVisibleScanIndex,
  nearestVisibleLidarRayIndex,
  SIM_LIDAR_RANGE_MAX,
  SIM_LIDAR_RANGE_MIN,
  SIM_LIDAR_RAY_COUNT,
  SIM_LIDAR_VISIBLE_DEFAULT,
  SIM_LIDAR_VISIBLE_RAY_COUNT,
} from './lidarSampling';
import { clampSimTopCameraZoom, simTopCameraHeight } from './simCamera';
import { getRegisteredStageImageByReference } from './stageImages';
import { ControlInput, LaserScanMessage, OdometryMessage, TfMessage, TwistMessage, makeTwist, unwrapBool, unwrapNumber, unwrapString, zeroTwist } from './types';
import { TransportAdapter, topicType } from './transport';
import { downsampleDepthToBytes, makeCameraInfo, packedDepthBytesToMeters, VISION_CAMERA, type VisionFrame } from './vision';

const RAY_COUNT = SIM_LIDAR_RAY_COUNT;
const VISIBLE_RAY_COUNT = SIM_LIDAR_VISIBLE_RAY_COUNT;
const RENDER_FRAME_RATE = 60;
const RENDER_FRAME_INTERVAL_MS = 1000 / RENDER_FRAME_RATE;
const RANGE_MAX = SIM_LIDAR_RANGE_MAX;
const RANGE_MIN = SIM_LIDAR_RANGE_MIN;
const RAY_COLOR_CLEAR = new THREE.Color(0x75d8be);
const RAY_COLOR_STOP = new THREE.Color(0xe76f65);
const RAY_COLOR_HIGHLIGHT = new THREE.Color(0xffd166);
export const TRAINING_START_ROS_POSE = { x: -2.65, y: 0, yaw: 0 } as const;
const TRAINING_START = { x: -TRAINING_START_ROS_POSE.y, z: -TRAINING_START_ROS_POSE.x, yaw: TRAINING_START_ROS_POSE.yaw } as const;

export type CameraMode = 'follow' | 'top' | 'robot';
interface RosPose { x: number; y: number; yaw: number }

const STAGE_VIEW_MARGIN = 5.3;
const STAGE_CAMERA_HEIGHT = 30;
const STAGE_UP = new THREE.Vector3(0, 1, 0);

export interface SimulationCallbacks {
  onScan: (scan: LaserScanMessage) => void;
  onOdom: (odom: OdometryMessage) => void;
  onStatus: (status: { frontDistance: number; speed: number; fps: number; stopped: boolean }) => void;
  onNarration: (message: string) => void;
  onRaySelection: (index: number, distance: number) => void;
  onVisionFrame: (frame: VisionFrame) => void;
  onStageCameraChange?: () => void;
}

export class Simulation {
  private readonly canvas: HTMLCanvasElement;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly stageCamera = new THREE.OrthographicCamera(-STAGE_VIEW_MARGIN, STAGE_VIEW_MARGIN, STAGE_VIEW_MARGIN, -STAGE_VIEW_MARGIN, .1, 60);
  private readonly stageOrbitCamera = new THREE.PerspectiveCamera(50, 1, .1, 200);
  private stageView: 'plan' | 'orbit' = 'plan';
  private planScale = 1;
  private readonly planCenter = new THREE.Vector2(0, 0);
  private orbitYaw = 0;
  private orbitPitch = Math.PI / 3;
  private orbitDistance = 11;
  private readonly orbitTarget = new THREE.Vector3(0, .3, 0);
  private flyInput: { forward: number; strafe: number; vertical: number } = { forward: 0, strafe: 0, vertical: 0 };
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly pointerNdc = new THREE.Vector2();
  private readonly projectionVector = new THREE.Vector3();
  private readonly workVectorA = new THREE.Vector3();
  private readonly workVectorB = new THREE.Vector3();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly visionCamera: THREE.PerspectiveCamera;
  private readonly rgbRenderTarget: THREE.WebGLRenderTarget;
  private readonly depthRenderTarget: THREE.WebGLRenderTarget;
  private readonly depthMaterial: THREE.MeshDepthMaterial;
  private readonly rgbReadBuffer = new Uint8Array(VISION_CAMERA.width * VISION_CAMERA.height * 4);
  private readonly depthReadBuffer = new Uint8Array(VISION_CAMERA.width * VISION_CAMERA.height * 4);
  private readonly visionRgb = new Uint8ClampedArray(VISION_CAMERA.width * VISION_CAMERA.height * 4);
  private readonly visionDepth = new Float32Array(VISION_CAMERA.width * VISION_CAMERA.height);
  private readonly visionCanvas = document.createElement('canvas');
  private readonly playgroundGroup = new THREE.Group();
  private stageFloor: THREE.Mesh | null = null;
  private stageGrid: THREE.GridHelper | null = null;
  private stageFloorCollider: RAPIER.Collider | null = null;
  private stageSize: PlaygroundStageSize = DEFAULT_PLAYGROUND.stageSize;
  private playgroundColliders: RAPIER.Collider[] = [];
  private playgroundRevision = 0;
  private selectionHelper: THREE.BoxHelper | null = null;
  private readonly world: RAPIER.World;
  private readonly robotBody: RAPIER.RigidBody;
  private readonly robotCollider: RAPIER.Collider;
  private readonly robotVisual: THREE.Group;
  private readonly wheelMeshes: THREE.Mesh[];
  private readonly rayGeometry: THREE.BufferGeometry;
  private readonly rayPositions: Float32Array;
  private readonly rayColors: Float32Array;
  private readonly rayLines: THREE.LineSegments;
  private readonly hitGeometry: THREE.BufferGeometry;
  private readonly hitPositions: Float32Array;
  private readonly hitPoints: THREE.Points;
  private readonly transport: TransportAdapter;
  private readonly callbacks: SimulationCallbacks;
  private readonly clock = new THREE.Clock();
  private readonly target = new THREE.Vector3();
  private readonly followPosition = new THREE.Vector3();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly lidarRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  private readonly rayRanges = new Float32Array(RAY_COUNT);
  private readonly scanRanges = new Float32Array(RAY_COUNT);
  private readonly rayAngles = new Float32Array(RAY_COUNT);
  private input: ControlInput = { linear: 0, angular: 0 };
  private safeCommand: TwistMessage = zeroTwist();
  private lastRawAt = performance.now();
  private lastCommandPublishAt = 0;
  private lastScanAt = performance.now();
  private lastLidarAt = 0;
  private lastOdomAt = 0;
  private lastStatusAt = 0;
  private lastVisionAt = 0;
  private lastDepthTopicAt = 0;
  private lastSafeCommandAt = performance.now();
  private safeCommandTimedOut = false;
  private lastFpsAt = performance.now();
  private lastRenderAt = performance.now();
  private frameCount = 0;
  private fps = 0;
  private stopped = false;
  private safetyFrontDistance = RANGE_MAX;
  private navigationMode = false;
  private stageEditing = false;
  private savedCameraMode: CameraMode = 'follow';
  private savedFog: THREE.Fog | THREE.FogExp2 | null = null;
  private readonly defaultSceneFog = new THREE.Fog(0xaedfd5, 12, 25);
  private yaw = 0;
  private cameraMode: CameraMode = 'follow';
  private topCameraZoom = 1;
  private robotCenteredCamera = false;
  private lidarVisible = SIM_LIDAR_VISIBLE_DEFAULT;
  private highlightedRay = -1;
  private running = false;
  private sharedRuntimeOwner = true;
  private animationFrame = 0;
  private unsubscribeCallbacks: Array<() => void> = [];

  private constructor(canvas: HTMLCanvasElement, transport: TransportAdapter, callbacks: SimulationCallbacks, world: RAPIER.World, robotBody: RAPIER.RigidBody, robotCollider: RAPIER.Collider) {
    this.canvas = canvas;
    this.canvas.dataset.cameraMode = this.cameraMode;
    this.canvas.dataset.robotCentered = String(this.robotCenteredCamera);
    this.canvas.dataset.topCameraZoom = String(this.topCameraZoom);
    this.canvas.dataset.scanRayCount = String(RAY_COUNT);
    this.canvas.dataset.visibleRayCount = String(VISIBLE_RAY_COUNT);
    this.canvas.dataset.targetFps = String(RENDER_FRAME_RATE);
    this.transport = transport;
    this.callbacks = callbacks;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xaedfd5);
    this.scene.fog = this.defaultSceneFog;
    this.camera = new THREE.PerspectiveCamera(42, 1, .1, 50);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.visionCamera = new THREE.PerspectiveCamera(VISION_CAMERA.verticalFieldOfViewDegrees, VISION_CAMERA.width / VISION_CAMERA.height, VISION_CAMERA.nearMeters, VISION_CAMERA.farMeters);
    this.rgbRenderTarget = new THREE.WebGLRenderTarget(VISION_CAMERA.width, VISION_CAMERA.height, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true });
    this.depthRenderTarget = new THREE.WebGLRenderTarget(VISION_CAMERA.width, VISION_CAMERA.height, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true });
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.visionCanvas.width = VISION_CAMERA.width;
    this.visionCanvas.height = VISION_CAMERA.height;
    this.world = world;
    this.robotBody = robotBody;
    this.robotCollider = robotCollider;
    this.robotVisual = new THREE.Group();
    this.wheelMeshes = [];
    this.rayPositions = new Float32Array(VISIBLE_RAY_COUNT * 2 * 3);
    this.rayColors = new Float32Array(VISIBLE_RAY_COUNT * 2 * 3);
    this.rayGeometry = new THREE.BufferGeometry();
    this.rayGeometry.setAttribute('position', new THREE.BufferAttribute(this.rayPositions, 3));
    this.rayGeometry.setAttribute('color', new THREE.BufferAttribute(this.rayColors, 3));
    this.rayLines = new THREE.LineSegments(this.rayGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .72 }));
    this.hitPositions = new Float32Array(VISIBLE_RAY_COUNT * 3);
    this.hitGeometry = new THREE.BufferGeometry();
    this.hitGeometry.setAttribute('position', new THREE.BufferAttribute(this.hitPositions, 3));
    this.hitPoints = new THREE.Points(this.hitGeometry, new THREE.PointsMaterial({ color: 0xffd166, size: .08, sizeAttenuation: true }));
    for (let index = 0; index < RAY_COUNT; index += 1) this.rayAngles[index] = lidarAngleAt(index, RAY_COUNT);
    this.setupScene();
    this.setLidarVisible(this.lidarVisible);
    this.setupTransport();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  static async create(canvas: HTMLCanvasElement, transport: TransportAdapter, callbacks: SimulationCallbacks): Promise<Simulation> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const robotBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(TRAINING_START.x, ROBOT_GEOMETRY.bodyCenterHeight, TRAINING_START.z).setGravityScale(0).lockRotations());
    robotBody.setEnabledRotations(false, false, false, true);
    const robotCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(.25, ROBOT_GEOMETRY.colliderHalfHeight, .2).setFriction(.9).setRestitution(.05), robotBody);
    return new Simulation(canvas, transport, callbacks, world, robotBody, robotCollider);
  }

  private setupScene(): void {
    const hemi = new THREE.HemisphereLight(0xf9fff9, 0x568b82, 2.4);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff5d3, 3.4);
    key.position.set(-4, 8, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);

    const floor = new THREE.Mesh(new THREE.BoxGeometry(PLAYGROUND_STAGE_PRESETS.medium.worldSize, .08, PLAYGROUND_STAGE_PRESETS.medium.worldSize), new THREE.MeshStandardMaterial({ color: 0xe7f1e8, roughness: .85 }));
    floor.position.y = -.04;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.stageFloor = floor;
    this.stageFloorCollider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(PLAYGROUND_STAGE_PRESETS.medium.worldSize / 2, .04, PLAYGROUND_STAGE_PRESETS.medium.worldSize / 2).setTranslation(0, -.04, 0));

    const grid = new THREE.GridHelper(PLAYGROUND_STAGE_PRESETS.medium.worldSize, PLAYGROUND_STAGE_PRESETS.medium.gridCells, 0xa8cfc4, 0xcce3d8);
    grid.position.y = .015;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => { material.opacity = .65; material.transparent = true; });
    this.scene.add(grid);
    this.stageGrid = grid;

    this.scene.add(this.playgroundGroup);
    this.applyPlayground(DEFAULT_PLAYGROUND);
    this.createRobotVisual();
    this.scene.add(this.rayLines, this.hitPoints);
    this.stageCamera.position.set(0, STAGE_CAMERA_HEIGHT, 0);
    this.stageCamera.up.set(0, 0, -1);
    this.stageCamera.lookAt(0, 0, 0);
    this.updateCamera();
  }

  applyPlayground(definition: PlaygroundDefinition, selectedId = ''): void {
    const revision = ++this.playgroundRevision;
    this.applyStageSize(definition.stageSize);
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper.geometry.dispose();
      (this.selectionHelper.material as THREE.Material).dispose();
      this.selectionHelper = null;
    }
    this.playgroundColliders.forEach((collider) => this.world.removeCollider(collider, true));
    this.playgroundColliders = [];
    this.playgroundGroup.traverse((child) => {
      if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Sprite)) return;
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if ('map' in material && material.map instanceof THREE.Texture) {
          const video = material.map.userData.stageImageVideo as HTMLVideoElement | undefined;
          if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
          }
          material.map.dispose();
        }
        material.dispose();
      });
    });
    this.playgroundGroup.clear();
    let selectedGroup: THREE.Group | null = null;
    definition.objects.forEach((object) => {
      const group = this.createPlaygroundObject(object, revision);
      group.userData.playgroundId = object.id;
      this.playgroundGroup.add(group);
      if (object.id === selectedId) selectedGroup = group;
    });
    if (selectedGroup) {
      this.selectionHelper = new THREE.BoxHelper(selectedGroup, 0xffbd42);
      this.selectionHelper.material.depthTest = false;
      this.selectionHelper.renderOrder = 10;
      this.scene.add(this.selectionHelper);
    }
  }

  private applyStageSize(size: PlaygroundStageSize): void {
    const preset = PLAYGROUND_STAGE_PRESETS[size];
    if (this.stageSize === size && this.stageFloor && this.stageGrid && this.stageFloorCollider) return;
    this.stageSize = size;
    if (this.stageFloor) {
      const previousGeometry = this.stageFloor.geometry;
      this.stageFloor.geometry = new THREE.BoxGeometry(preset.worldSize, .08, preset.worldSize);
      previousGeometry.dispose();
    }
    if (this.stageGrid) {
      const replacement = new THREE.GridHelper(preset.worldSize, preset.gridCells, 0xa8cfc4, 0xcce3d8);
      const previousGeometry = this.stageGrid.geometry;
      this.stageGrid.geometry = replacement.geometry;
      previousGeometry.dispose();
      const materials = Array.isArray(replacement.material) ? replacement.material : [replacement.material];
      materials.forEach((material) => material.dispose());
    }
    if (this.stageFloorCollider) this.world.removeCollider(this.stageFloorCollider, true);
    this.stageFloorCollider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(preset.worldSize / 2, .04, preset.worldSize / 2).setTranslation(0, -.04, 0),
    );
    if (this.stageView === 'plan') this.fitStagePlanView();
  }

  private createPlaygroundObject(object: PlaygroundObject, revision: number): THREE.Group {
    const group = new THREE.Group();
    group.position.set(object.position.x, 0, object.position.z);
    group.rotation.y = object.rotation;
    group.userData.baseSize = { width: object.size.width, height: object.size.height, depth: object.size.depth };
    if (object.kind === 'gate') {
      const postWidth = Math.min(object.size.depth, object.size.width / 4);
      const postOffset = Math.max(0, object.size.width / 2 - postWidth / 2);
      const signHeight = Math.max(.1, Math.min(.18, object.size.height * .2));
      const material = new THREE.MeshStandardMaterial({ color: object.color, roughness: .55 });
      const signMaterial = new THREE.MeshStandardMaterial({ color: 0xf4cf70, roughness: .6 });
      for (const localX of [-postOffset, postOffset]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(postWidth, object.size.height, object.size.depth), material.clone());
        post.position.set(localX, object.size.height / 2, 0);
        post.castShadow = true;
        post.receiveShadow = true;
        group.add(post);
        this.addPlaygroundCollider(object, localX, object.size.height / 2, 0, postWidth, object.size.height, object.size.depth);
      }
      const sign = new THREE.Mesh(new THREE.BoxGeometry(object.size.width, signHeight, object.size.depth), signMaterial);
      sign.position.set(0, object.size.height - signHeight / 2, 0);
      sign.castShadow = true;
      group.add(sign);
      this.addPlaygroundCollider(object, 0, object.size.height - signHeight / 2, 0, object.size.width, signHeight, object.size.depth);
    } else {
      let material: THREE.Material | THREE.Material[] = new THREE.MeshStandardMaterial({ color: object.color, roughness: object.kind === 'wall' ? .8 : .62 });
      if (object.kind === 'vision_target') {
        const fallback = this.makeVisionTargetTexture();
        const side = new THREE.MeshStandardMaterial({ color: 0x253b42, roughness: .8 });
        const back = side.clone();
        const front = new THREE.MeshBasicMaterial({ map: fallback, color: 0xffffff });
        material = [side.clone(), side.clone(), side.clone(), side.clone(), front, back];
        const uploadedAsset = getRegisteredStageImageByReference(object.asset);
        const localAsset = getVisionTargetAssetByUrl(object.asset);
        const assetUrl = uploadedAsset?.url ?? localAsset?.url;
        if (uploadedAsset?.mimeType === 'video/webm' && assetUrl) {
          this.loadPlaygroundVideoTexture(assetUrl, fallback, front, revision, uploadedAsset.fileName);
        } else if (assetUrl) {
          new THREE.TextureLoader().load(assetUrl, (texture) => {
            if (revision !== this.playgroundRevision) {
              texture.dispose();
              return;
            }
            texture.colorSpace = THREE.SRGBColorSpace;
            fallback.dispose();
            front.map = texture;
            front.needsUpdate = true;
          }, undefined, () => {
            this.callbacks.onNarration(`${uploadedAsset?.fileName ?? localAsset?.label ?? '画像'}を読み込めません。ファイルの配置と内容を確認してください。`);
          });
        }
      }
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(object.size.width, object.size.height, object.size.depth), material);
      mesh.position.y = object.size.height / 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      this.addPlaygroundCollider(object, 0, object.size.height / 2, 0, object.size.width, object.size.height, object.size.depth);
    }
    return group;
  }

  private loadPlaygroundVideoTexture(url: string, fallback: THREE.CanvasTexture, front: THREE.MeshBasicMaterial, revision: number, label: string): void {
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.userData.stageImageVideo = video;
    const dispose = (): void => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      texture.dispose();
    };
    video.addEventListener('loadeddata', () => {
      if (revision !== this.playgroundRevision) {
        dispose();
        return;
      }
      fallback.dispose();
      front.map = texture;
      front.needsUpdate = true;
      void video.play().catch(() => undefined);
    }, { once: true });
    video.addEventListener('error', () => {
      dispose();
      this.callbacks.onNarration(`${label}を読み込めません。WEBMの内容を確認してください。`);
    }, { once: true });
    video.load();
  }

  private addPlaygroundCollider(object: PlaygroundObject, localX: number, localY: number, localZ: number, width: number, height: number, depth: number): void {
    const cosine = Math.cos(object.rotation);
    const sine = Math.sin(object.rotation);
    const worldX = object.position.x + localX * cosine + localZ * sine;
    const worldZ = object.position.z - localX * sine + localZ * cosine;
    const rotation = { x: 0, y: Math.sin(object.rotation / 2), z: 0, w: Math.cos(object.rotation / 2) };
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2)
        .setTranslation(worldX, localY, worldZ)
        .setRotation(rotation),
    );
    this.playgroundColliders.push(collider);
  }

  private makeVisionTargetTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = '#172d32';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#8ce1c7';
      context.font = '700 38px sans-serif';
      context.textAlign = 'center';
      context.fillText('VISION TARGET', 256, 165);
      context.fillStyle = '#ffffff';
      context.font = '600 22px sans-serif';
      context.fillText('pixi run vision-assets', 256, 220);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createRobotVisual(): void {
    const starterRobot = createStarterRobotModel();
    this.robotVisual.add(starterRobot.group);
    this.wheelMeshes.push(...starterRobot.wheels);
    const signShape = new THREE.Shape();
    const signHalfWidth = ROBOT_GEOMETRY.frontArrowRadius * 1.15;
    const signHalfLength = ROBOT_GEOMETRY.frontArrowHeight / 2 * 1.15;
    signShape.moveTo(0, signHalfLength);
    signShape.lineTo(-signHalfWidth, -signHalfLength * .1);
    signShape.lineTo(-signHalfWidth * .36, -signHalfLength * .1);
    signShape.lineTo(-signHalfWidth * .36, -signHalfLength);
    signShape.lineTo(signHalfWidth * .36, -signHalfLength);
    signShape.lineTo(signHalfWidth * .36, -signHalfLength * .1);
    signShape.lineTo(signHalfWidth, -signHalfLength * .1);
    signShape.closePath();
    const sign = new THREE.Mesh(new THREE.ShapeGeometry(signShape), new THREE.MeshBasicMaterial({ color: 0xf04444, side: THREE.DoubleSide, depthWrite: false }));
    sign.name = 'directionSign';
    sign.rotation.x = -Math.PI / 2;
    // Keep the flat sign just above the shared floor, at the bottom edge of
    // the treads rather than in the middle of the lower body.
    const signLocalY = ROBOT_GEOMETRY.frontArrowLocalY - ROBOT_GEOMETRY.bodyCenterHeight + 0.025;
    sign.position.set(0, signLocalY, ROBOT_GEOMETRY.frontArrowLocalZ);
    sign.renderOrder = 5;
    sign.userData.sculptPart = 'directionSign';
    this.robotVisual.add(sign);
    this.scene.add(this.robotVisual);
  }

  private setupTransport(): void {
    this.unsubscribeCallbacks.push(this.transport.subscribe('/cmd_vel', topicType('/cmd_vel'), (message) => {
      this.safeCommand = message as TwistMessage;
      this.lastSafeCommandAt = performance.now();
      this.safeCommandTimedOut = false;
    }));
    this.unsubscribeCallbacks.push(this.transport.subscribe('/safety/stop', topicType('/safety/stop'), (message) => { this.stopped = unwrapBool(message); }));
    this.unsubscribeCallbacks.push(this.transport.subscribe('/safety/front_distance', topicType('/safety/front_distance'), (message) => { this.safetyFrontDistance = unwrapNumber(message); }));
    this.unsubscribeCallbacks.push(this.transport.subscribe('/control/mode', topicType('/control/mode'), (message) => { this.navigationMode = unwrapString(message) === 'navigation'; }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.lastRenderAt = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const elapsed = now - this.lastRenderAt;
      if (elapsed >= RENDER_FRAME_INTERVAL_MS) {
        this.lastRenderAt = now - elapsed % RENDER_FRAME_INTERVAL_MS;
        this.step();
      }
      this.animationFrame = requestAnimationFrame(loop);
    };
    this.animationFrame = requestAnimationFrame(loop);
  }

  stop(): void { this.running = false; cancelAnimationFrame(this.animationFrame); this.input = { linear: 0, angular: 0 }; this.safeCommand = zeroTwist(); }

  private step(): void {
    if (this.stageEditing) {
      this.applyStageFly(Math.min(this.clock.getDelta(), .05));
      this.updateStageCamera();
      this.renderer.render(this.scene, this.activeStageCamera());
      return;
    }
    const now = performance.now();
    const dt = Math.min(this.clock.getDelta(), .05);
    if (now - this.lastCommandPublishAt >= 50) {
      this.publishRawCommand(now);
      this.lastCommandPublishAt = now;
    }
    if (this.transport.getConnectionState() === 'CONNECTED' && now - this.lastSafeCommandAt >= 500) {
      this.safeCommand = zeroTwist();
      if (!this.safeCommandTimedOut) {
        this.safeCommandTimedOut = true;
        this.callbacks.onNarration('実Safety Controllerの速度が0.5秒以上届かないため停止しました。ROS構成を確認するか、SIMモードへ戻ってください。');
      }
    }
    this.applySafeCommand(dt);
    this.world.step();
    this.syncRobotVisual(dt);
    if (now - this.lastOdomAt >= 50) { this.publishOdom(); this.lastOdomAt = now; }
    if (now - this.lastLidarAt >= 100) { this.updateLidar(now); this.lastLidarAt = now; }
    this.updateCamera();
    if (now - this.lastVisionAt >= 1000 / VISION_CAMERA.frameRate) { this.captureVisionFrame(now); this.lastVisionAt = now; }
    this.renderer.render(this.scene, this.camera);
    this.frameCount += 1;
    if (now - this.lastFpsAt >= 1000) { this.fps = this.frameCount; this.frameCount = 0; this.lastFpsAt = now; }
    if (now - this.lastStatusAt >= 100) { const translation = this.robotBody.translation(); const rosConnected = this.transport.getConnectionState() === 'CONNECTED'; this.callbacks.onStatus({ frontDistance: rosConnected ? this.safetyFrontDistance : this.getFrontDistance(), speed: Math.hypot(this.robotBody.linvel().x, this.robotBody.linvel().z), fps: this.fps, stopped: this.stopped }); this.lastStatusAt = now; void translation; }
  }

  private publishRawCommand(now: number): void {
    const command = makeTwist(this.input.linear, this.input.angular);
    if (this.transport.getConnectionState() === 'CONNECTED') {
      this.transport.publish('/cmd_vel_manual', topicType('/cmd_vel_manual'), this.navigationMode ? zeroTwist() : command);
      this.lastRawAt = now;
      return;
    }
    this.transport.publish('/cmd_vel_raw', topicType('/cmd_vel_raw'), command);
    this.lastRawAt = now;
    const scan = this.makeScanMessage();
    const decision = decideSafeCommand(this.input, scan, now, this.lastScanAt, this.lastRawAt, this.stopped, DEFAULT_SAFETY_CONFIG);
    this.stopped = decision.stopped;
    this.safeCommand = decision.command;
    this.transport.publish('/cmd_vel', topicType('/cmd_vel'), decision.command);
    this.transport.publish('/safety/stop', topicType('/safety/stop'), decision.stopped);
    this.transport.publish('/safety/front_distance', topicType('/safety/front_distance'), decision.frontDistance);
  }

  private applySafeCommand(dt: number): void {
    const velocity = this.safeCommand.linear.x;
    const rotation = this.safeCommand.angular.z;
    this.yaw += rotation * dt;
    const forward = rosYawToThreeForward(this.yaw);
    const rotationQuaternion = rosYawToThreeQuaternion(this.yaw);
    this.robotBody.setLinvel({ x: forward.x * velocity, y: 0, z: forward.z * velocity }, true);
    this.robotBody.setRotation(rotationQuaternion, true);
  }

  private syncRobotVisual(dt: number): void {
    const translation = this.robotBody.translation();
    this.robotVisual.position.set(translation.x, translation.y, translation.z);
    this.robotVisual.quaternion.copy(rosYawToThreeQuaternion(this.yaw));
    const distance = Math.hypot(this.robotBody.linvel().x, this.robotBody.linvel().z) * dt;
    this.wheelMeshes.forEach((wheel) => { wheel.rotation.x += distance * 5; });
  }

  private updateLidar(now: number): void {
    const translation = this.robotBody.translation();
    this.rayOrigin.set(translation.x, lidarWorldHeight(translation.y), translation.z);
    this.lidarRay.origin.x = this.rayOrigin.x;
    this.lidarRay.origin.y = this.rayOrigin.y;
    this.lidarRay.origin.z = this.rayOrigin.z;
    for (let index = 0; index < RAY_COUNT; index += 1) {
      setRosYawToThreeForward(this.rayDirection, this.yaw + this.rayAngles[index]);
      this.lidarRay.dir.x = this.rayDirection.x;
      this.lidarRay.dir.y = this.rayDirection.y;
      this.lidarRay.dir.z = this.rayDirection.z;
      const hit = this.world.castRay(this.lidarRay, RANGE_MAX, true);
      const hitDistance = hit && hit.collider !== this.robotCollider ? hit.timeOfImpact : null;
      const distance = hitDistance === null ? RANGE_MAX : Math.max(RANGE_MIN, hitDistance);
      this.rayRanges[index] = distance;
      this.scanRanges[index] = lidarScanRange(hitDistance, RANGE_MIN, RANGE_MAX);
    }
    if (this.lidarVisible) {
      const highlightedVisibleRay = this.highlightedRay >= 0 ? nearestVisibleLidarRayIndex(this.highlightedRay) : -1;
      for (let visibleIndex = 0; visibleIndex < VISIBLE_RAY_COUNT; visibleIndex += 1) {
        const scanIndex = lidarVisibleScanIndex(visibleIndex);
        const distance = this.rayRanges[scanIndex];
        setRosYawToThreeForward(this.rayDirection, this.yaw + this.rayAngles[scanIndex]);
        const base = visibleIndex * 6;
        const hitBase = visibleIndex * 3;
        this.rayPositions[base] = this.rayOrigin.x; this.rayPositions[base + 1] = this.rayOrigin.y; this.rayPositions[base + 2] = this.rayOrigin.z;
        this.rayPositions[base + 3] = this.rayOrigin.x + this.rayDirection.x * distance; this.rayPositions[base + 4] = this.rayOrigin.y; this.rayPositions[base + 5] = this.rayOrigin.z + this.rayDirection.z * distance;
        const color = visibleIndex === highlightedVisibleRay
          ? RAY_COLOR_HIGHLIGHT
          : distance < DEFAULT_SAFETY_CONFIG.stopDistance ? RAY_COLOR_STOP : RAY_COLOR_CLEAR;
        this.rayColors[base] = color.r; this.rayColors[base + 1] = color.g; this.rayColors[base + 2] = color.b;
        this.rayColors[base + 3] = color.r; this.rayColors[base + 4] = color.g; this.rayColors[base + 5] = color.b;
        this.hitPositions[hitBase] = this.rayPositions[base + 3]; this.hitPositions[hitBase + 1] = this.rayPositions[base + 4]; this.hitPositions[hitBase + 2] = this.rayPositions[base + 5];
      }
      this.rayGeometry.attributes.position.needsUpdate = true; this.rayGeometry.attributes.color.needsUpdate = true; this.hitGeometry.attributes.position.needsUpdate = true;
    }
    this.rayLines.visible = this.lidarVisible; this.hitPoints.visible = this.lidarVisible;
    const scan: LaserScanMessage = { header: { frame_id: 'laser_frame', stamp: this.timestamp() }, angle_min: -Math.PI, angle_max: lidarAngleMax(RAY_COUNT), angle_increment: lidarAngleIncrement(RAY_COUNT), time_increment: 0, scan_time: 0.1, range_min: RANGE_MIN, range_max: RANGE_MAX, ranges: Array.from(this.scanRanges), intensities: [] };
    this.lastScanAt = now;
    this.transport.publish('/scan', topicType('/scan'), scan);
    this.callbacks.onScan(scan);
  }

  private makeScanMessage(): LaserScanMessage {
    const ranges = Array.from(this.scanRanges, (range) => Number.isFinite(range) && range > 0 ? range : lidarScanRange(null, RANGE_MIN, RANGE_MAX));
    return { header: { frame_id: 'laser_frame', stamp: this.timestamp() }, angle_min: -Math.PI, angle_max: lidarAngleMax(RAY_COUNT), angle_increment: lidarAngleIncrement(RAY_COUNT), time_increment: 0, scan_time: 0.1, range_min: RANGE_MIN, range_max: RANGE_MAX, ranges, intensities: [] };
  }

  private publishOdom(): void {
    const translation = this.robotBody.translation();
    const velocity = this.robotBody.linvel();
    const stamp = this.timestamp();
    const position = { x: -translation.z, y: -translation.x, z: translation.y };
    const orientation = rosYawToRosQuaternion(this.yaw);
    const covariance = Array<number>(36).fill(0);
    covariance[0] = 0.01; covariance[7] = 0.01; covariance[35] = 0.02;
    const odom: OdometryMessage = { header: { frame_id: 'odom', stamp }, child_frame_id: 'base_link', pose: { pose: { position, orientation }, covariance }, twist: { twist: makeTwist(Math.hypot(velocity.x, velocity.z), this.safeCommand.angular.z), covariance: [...covariance] } };
    this.transport.publish('/odom', topicType('/odom'), odom);
    if (this.transport.getConnectionState() === 'CONNECTED') {
      const tf: TfMessage = { transforms: [{ header: { frame_id: 'odom', stamp }, child_frame_id: 'base_link', transform: { translation: position, rotation: orientation } }] };
      this.transport.publish('/tf', topicType('/tf'), tf);
    }
    this.callbacks.onOdom(odom);
  }

  private timestamp(): { sec: number; nanosec: number } { const milliseconds = Date.now(); return { sec: Math.floor(milliseconds / 1000), nanosec: (milliseconds % 1000) * 1_000_000 }; }
  private getFrontDistance(): number { const frontIndex = Math.round(RAY_COUNT / 2); return this.rayRanges[frontIndex] ?? RANGE_MAX; }

  private captureVisionFrame(now: number): void {
    const translation = this.robotBody.translation();
    const rotation = rosYawToThreeQuaternion(this.yaw);
    this.followPosition.set(0, ROBOT_GEOMETRY.cameraCenterLocalY, ROBOT_GEOMETRY.cameraViewLocalZ).applyQuaternion(rotation);
    this.visionCamera.position.set(translation.x + this.followPosition.x, translation.y + this.followPosition.y, translation.z + this.followPosition.z);
    const forward = rosYawToThreeForward(this.yaw);
    this.target.set(this.visionCamera.position.x + forward.x * 4, this.visionCamera.position.y, this.visionCamera.position.z + forward.z * 4);
    this.visionCamera.up.set(0, 1, 0);
    this.visionCamera.lookAt(this.target);

    const robotVisible = this.robotVisual.visible;
    const rayVisible = this.rayLines.visible;
    const hitVisible = this.hitPoints.visible;
    const selectionVisible = this.selectionHelper?.visible ?? false;
    this.robotVisual.visible = false;
    this.rayLines.visible = false;
    this.hitPoints.visible = false;
    if (this.selectionHelper) this.selectionHelper.visible = false;

    this.renderer.setRenderTarget(this.rgbRenderTarget);
    this.renderer.render(this.scene, this.visionCamera);
    this.renderer.readRenderTargetPixels(this.rgbRenderTarget, 0, 0, VISION_CAMERA.width, VISION_CAMERA.height, this.rgbReadBuffer);

    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    const previousClearColor = this.renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = this.renderer.getClearAlpha();
    this.scene.overrideMaterial = this.depthMaterial;
    this.scene.background = null;
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.setRenderTarget(this.depthRenderTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.visionCamera);
    this.renderer.readRenderTargetPixels(this.depthRenderTarget, 0, 0, VISION_CAMERA.width, VISION_CAMERA.height, this.depthReadBuffer);
    this.renderer.setRenderTarget(null);
    this.scene.overrideMaterial = previousOverride;
    this.scene.background = previousBackground;
    this.renderer.setClearColor(previousClearColor, previousClearAlpha);

    this.robotVisual.visible = robotVisible;
    this.rayLines.visible = rayVisible;
    this.hitPoints.visible = hitVisible;
    if (this.selectionHelper) this.selectionHelper.visible = selectionVisible;

    for (let y = 0; y < VISION_CAMERA.height; y += 1) {
      const sourceY = VISION_CAMERA.height - 1 - y;
      for (let x = 0; x < VISION_CAMERA.width; x += 1) {
        const source = (sourceY * VISION_CAMERA.width + x) * 4;
        const target = (y * VISION_CAMERA.width + x) * 4;
        this.visionRgb[target] = this.rgbReadBuffer[source];
        this.visionRgb[target + 1] = this.rgbReadBuffer[source + 1];
        this.visionRgb[target + 2] = this.rgbReadBuffer[source + 2];
        this.visionRgb[target + 3] = 255;
        this.visionDepth[y * VISION_CAMERA.width + x] = packedDepthBytesToMeters(
          this.depthReadBuffer[source],
          this.depthReadBuffer[source + 1],
          this.depthReadBuffer[source + 2],
          this.depthReadBuffer[source + 3],
          VISION_CAMERA.nearMeters,
          VISION_CAMERA.farMeters,
        );
      }
    }

    const capturedAtMs = Date.now();
    const stamp = { sec: Math.floor(capturedAtMs / 1000), nanosec: (capturedAtMs % 1000) * 1_000_000 };
    const context = this.visionCanvas.getContext('2d');
    if (context) context.putImageData(new ImageData(this.visionRgb, VISION_CAMERA.width, VISION_CAMERA.height), 0, 0);
    const jpeg = this.visionCanvas.toDataURL('image/jpeg', .78).split(',')[1] ?? '';
    this.transport.publish('/camera/rgb/image_raw/compressed', topicType('/camera/rgb/image_raw/compressed'), {
      header: { frame_id: VISION_CAMERA.frameId, stamp }, format: 'jpeg; rgb8', data: jpeg,
    });
    this.transport.publish('/camera/camera_info', topicType('/camera/camera_info'), makeCameraInfo(stamp));
    if (now - this.lastDepthTopicAt >= 1000 / VISION_CAMERA.depthTopicRate) {
      this.transport.publish('/camera/depth/image_raw', topicType('/camera/depth/image_raw'), {
        header: { frame_id: VISION_CAMERA.frameId, stamp },
        height: VISION_CAMERA.depthTopicHeight,
        width: VISION_CAMERA.depthTopicWidth,
        encoding: '32FC1',
        is_bigendian: 0,
        step: VISION_CAMERA.depthTopicWidth * 4,
        data: downsampleDepthToBytes(this.visionDepth, VISION_CAMERA.width, VISION_CAMERA.height, VISION_CAMERA.depthTopicWidth, VISION_CAMERA.depthTopicHeight),
      });
      this.lastDepthTopicAt = now;
    }
    this.callbacks.onVisionFrame({
      width: VISION_CAMERA.width,
      height: VISION_CAMERA.height,
      rgb: this.visionRgb,
      depthMeters: this.visionDepth,
      stamp,
      capturedAtMs,
    });
  }

  private updateCamera(): void {
    const translation = this.robotBody.translation();
    if (this.cameraMode === 'robot') {
      this.camera.up.set(0, 1, 0);
      const rotation = rosYawToThreeQuaternion(this.yaw);
      this.followPosition.set(0, ROBOT_GEOMETRY.cameraCenterLocalY, ROBOT_GEOMETRY.cameraViewLocalZ).applyQuaternion(rotation);
      this.camera.position.set(translation.x + this.followPosition.x, translation.y + this.followPosition.y, translation.z + this.followPosition.z);
      const forward = rosYawToThreeForward(this.yaw);
      this.target.set(this.camera.position.x + forward.x * 4, this.camera.position.y, this.camera.position.z + forward.z * 4);
      this.camera.lookAt(this.target);
      return;
    }
    this.target.set(translation.x, .2, translation.z);
    if (this.cameraMode === 'top') {
      const mapUp = this.robotCenteredCamera ? rosYawToThreeForward(this.yaw) : rosMapNorthToThree();
      this.camera.up.copy(mapUp);
      this.camera.position.set(translation.x, simTopCameraHeight(this.topCameraZoom), translation.z);
      this.camera.lookAt(this.target);
      return;
    }
    this.camera.up.set(0, 1, 0);
    const backward = this.robotCenteredCamera ? rosYawToThreeForward(this.yaw).multiplyScalar(-1) : new THREE.Vector3(0, 0, 1);
    // Keep a consistent three-quarter overview of the neutral starter robot.
    // Robot-centered mode instead follows the current heading.
    if (!this.robotCenteredCamera) {
      this.followPosition.set(translation.x, translation.y + 3.6, translation.z - 3.9);
    } else {
      this.followPosition.set(translation.x + backward.x * 3.9, translation.y + 3.6, translation.z + backward.z * 3.9);
    }
    this.camera.position.lerp(this.followPosition, .1);
    this.camera.lookAt(this.target);
  }

  resize = (): void => { const rect = this.canvas.parentElement?.getBoundingClientRect(); if (!rect) return; this.camera.aspect = rect.width / rect.height; this.camera.updateProjectionMatrix(); this.renderer.setSize(rect.width, rect.height, false); if (this.stageEditing) this.updateStageCamera(); };
  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.canvas.dataset.cameraMode = mode;
    if (!this.stageEditing) this.scene.fog = mode === 'top' ? null : this.defaultSceneFog;
    this.camera.fov = mode === 'robot' ? 64 : 42;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }
  setTopCameraZoom(zoom: number): void { this.topCameraZoom = clampSimTopCameraZoom(zoom); this.canvas.dataset.topCameraZoom = String(this.topCameraZoom); this.updateCamera(); }
  setRobotCenteredCamera(enabled: boolean): void { this.robotCenteredCamera = enabled; this.canvas.dataset.robotCentered = String(enabled); this.updateCamera(); }
  setLidarVisible(visible: boolean): void { this.lidarVisible = visible; this.rayLines.visible = visible; this.hitPoints.visible = visible; }
  private resetToRosPose(pose: RosPose): void {
    this.robotBody.setTranslation({ x: -pose.y, y: ROBOT_GEOMETRY.bodyCenterHeight, z: -pose.x }, true);
    this.robotBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.robotBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.robotBody.setRotation(rosYawToThreeQuaternion(pose.yaw), true);
    this.yaw = pose.yaw;
    this.input = { linear: 0, angular: 0 };
    this.safeCommand = zeroTwist();
    this.stopped = false;
    this.syncRobotVisual(0);
    this.updateCamera();
  }

  private resetToTrainingStart(): void { this.resetToRosPose(TRAINING_START_ROS_POSE); }

  reset(): void {
    this.resetToTrainingStart();
    this.callbacks.onNarration('ロボットをスタート地点へ戻しました。まずはWキーで前進してみましょう。');
  }

  resetForNavigation(announce = true): void {
    this.resetToTrainingStart();
    if (announce) this.callbacks.onNarration('保存地図とLiDARの原点を合わせるため、自機を地図作成時の開始位置へ戻しました。');
  }
  stopMotion(): void {
    this.input = { linear: 0, angular: 0 };
    this.safeCommand = zeroTwist();
    if (this.transport.getConnectionState() === 'CONNECTED') {
      this.transport.publish('/cmd_vel_manual', topicType('/cmd_vel_manual'), zeroTwist());
    } else {
      this.transport.publish('/cmd_vel_raw', topicType('/cmd_vel_raw'), zeroTwist());
    }
  }
  setSharedRuntimeOwner(owner: boolean): void {
    this.sharedRuntimeOwner = owner;
    if (!owner) this.input = { linear: 0, angular: 0 };
  }
  syncExternalOdometry(odom: OdometryMessage): void {
    if (this.sharedRuntimeOwner) return;
    const pose = odom.pose.pose;
    this.yaw = quaternionToYaw(pose.orientation);
    this.robotBody.setTranslation({ x: -pose.position.y, y: ROBOT_GEOMETRY.bodyCenterHeight, z: -pose.position.x }, true);
    const forward = rosYawToThreeForward(this.yaw);
    this.robotBody.setLinvel({ x: forward.x * odom.twist.twist.linear.x, y: 0, z: forward.z * odom.twist.twist.linear.x }, true);
    this.robotBody.setAngvel({ x: 0, y: odom.twist.twist.angular.z, z: 0 }, true);
    this.robotBody.setRotation(rosYawToThreeQuaternion(this.yaw), true);
    this.syncRobotVisual(0);
    this.updateCamera();
  }
  setInput(input: ControlInput): void { this.input = input; }
  enterStageEditor(): void {
    this.savedCameraMode = this.cameraMode;
    this.stageEditing = true;
    this.canvas.dataset.cameraMode = 'stage';
    this.savedFog = this.scene.fog;
    this.scene.fog = null;
    this.rayLines.visible = false;
    this.hitPoints.visible = false;
    this.setStageView('plan');
    this.fitStagePlanView();
    this.updateStageCamera();
  }

  exitStageEditor(): void {
    if (!this.stageEditing) return;
    this.stageEditing = false;
    this.flyInput = { forward: 0, strafe: 0, vertical: 0 };
    const now = performance.now();
    this.lastRawAt = now;
    this.lastSafeCommandAt = now;
    this.lastScanAt = now;
    this.safeCommandTimedOut = false;
    this.scene.fog = this.savedFog;
    this.rayLines.visible = this.lidarVisible;
    this.hitPoints.visible = this.lidarVisible;
    this.setCameraMode(this.savedCameraMode);
  }

  refreshLayout(): void {
    this.resize();
    if (this.stageEditing) this.updateStageCamera();
  }

  isStageEditing(): boolean { return this.stageEditing; }

  getStageView(): 'plan' | 'orbit' { return this.stageView; }

  setStageView(view: 'plan' | 'orbit'): void {
    if (this.stageView === view) return;
    this.stageView = view;
    this.flyInput = { forward: 0, strafe: 0, vertical: 0 };
    if (view === 'orbit') {
      this.orbitYaw = 0;
      this.orbitPitch = Math.PI / 3;
      this.orbitDistance = 11;
      this.orbitTarget.set(0, .3, 0);
    } else {
      this.fitStagePlanView();
    }
    this.updateStageCamera();
  }

  private fitStagePlanView(): void {
    this.planCenter.set(0, 0);
    if (typeof window === 'undefined' || !window.matchMedia('(min-width: 3008px)').matches) {
      this.planScale = 1;
      return;
    }
    const preset = PLAYGROUND_STAGE_PRESETS[this.stageSize];
    const targetHalfView = preset.worldSize / (2 * .88);
    this.planScale = Math.max(.35, Math.min(1.6, targetHalfView / STAGE_VIEW_MARGIN));
  }

  planPan(deltaX: number, deltaY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const base = STAGE_VIEW_MARGIN * this.planScale;
    const aspect = rect.width / rect.height;
    const worldPerPixelX = (2 * Math.max(base, base * aspect)) / rect.width;
    const worldPerPixelZ = (2 * Math.max(base, base / aspect)) / rect.height;
    this.planCenter.x -= deltaX * worldPerPixelX;
    this.planCenter.y += deltaY * worldPerPixelZ;
    this.planCenter.x = Math.max(-10, Math.min(10, this.planCenter.x));
    this.planCenter.y = Math.max(-10, Math.min(10, this.planCenter.y));
    this.updateStageCamera();
  }

  orbitRotate(deltaX: number, deltaY: number): void {
    this.orbitYaw -= deltaX * .005;
    this.orbitPitch = Math.max(.08, Math.min(1.5, this.orbitPitch + deltaY * .005));
    this.updateStageCamera();
  }

  orbitPan(deltaX: number, deltaY: number): void {
    const forward = this.groundForward(this.workVectorA);
    const right = this.workVectorB.crossVectors(forward, STAGE_UP).normalize();
    const scale = this.orbitDistance * .0016;
    this.orbitTarget.addScaledVector(right, -deltaX * scale);
    this.orbitTarget.addScaledVector(forward, -deltaY * scale);
    this.clampOrbitTarget();
    this.updateStageCamera();
  }

  orbitZoom(deltaY: number): void {
    this.orbitDistance = Math.max(1.5, Math.min(45, this.orbitDistance * Math.exp(deltaY * .0012)));
    this.updateStageCamera();
  }

  planZoom(deltaY: number): void {
    this.planScale = Math.max(.35, Math.min(1.6, this.planScale * Math.exp(deltaY * .0012)));
    this.updateStageCamera();
  }

  screenDeltaToHeightDelta(deltaYPixels: number): number {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    if (this.stageView === 'orbit') {
      const worldPerPixel = 2 * this.orbitDistance * Math.tan(THREE.MathUtils.degToRad(this.stageOrbitCamera.fov / 2)) / rect.height;
      return -deltaYPixels * worldPerPixel;
    }
    const base = STAGE_VIEW_MARGIN * this.planScale;
    const worldPerPixel = (2 * Math.max(base, base / (rect.width / rect.height))) / rect.height;
    return -deltaYPixels * worldPerPixel;
  }

  setFlyInput(forward: number, strafe: number, vertical: number): void {
    this.flyInput = { forward, strafe, vertical };
  }

  private applyStageFly(dt: number): void {
    if (this.stageView !== 'orbit') return;
    if (this.flyInput.forward === 0 && this.flyInput.strafe === 0 && this.flyInput.vertical === 0) return;
    const forward = this.groundForward(this.workVectorA);
    const right = this.workVectorB.crossVectors(forward, STAGE_UP).normalize();
    const speed = this.orbitDistance * 1.2;
    this.orbitTarget.addScaledVector(forward, this.flyInput.forward * speed * dt);
    this.orbitTarget.addScaledVector(right, this.flyInput.strafe * speed * dt);
    this.orbitTarget.y = Math.max(.2, Math.min(15, this.orbitTarget.y + this.flyInput.vertical * speed * dt));
    this.clampOrbitTarget();
  }

  private groundForward(target: THREE.Vector3): THREE.Vector3 {
    this.stageOrbitCamera.getWorldDirection(target);
    target.y = 0;
    return target.lengthSq() < 1e-6 ? target.set(0, 0, -1) : target.normalize();
  }

  private clampOrbitTarget(): void {
    this.orbitTarget.x = Math.max(-10, Math.min(10, this.orbitTarget.x));
    this.orbitTarget.z = Math.max(-10, Math.min(10, this.orbitTarget.z));
    this.orbitTarget.y = Math.max(.2, Math.min(15, this.orbitTarget.y));
  }

  private activeStageCamera(): THREE.Camera {
    return this.stageView === 'plan' ? this.stageCamera : this.stageOrbitCamera;
  }

  private updateStageCamera(): void {
    if (this.stageView === 'orbit') {
      this.updateOrbitCamera();
      this.callbacks.onStageCameraChange?.();
      return;
    }
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const aspect = rect && rect.height > 0 ? rect.width / rect.height : 4 / 3;
    const base = STAGE_VIEW_MARGIN * this.planScale;
    const halfWidth = Math.max(base, base * aspect);
    const halfHeight = Math.max(base, base / aspect);
    this.stageCamera.left = -halfWidth;
    this.stageCamera.right = halfWidth;
    this.stageCamera.top = halfHeight;
    this.stageCamera.bottom = -halfHeight;
    this.stageCamera.updateProjectionMatrix();
    this.stageCamera.position.set(this.planCenter.x, STAGE_CAMERA_HEIGHT, this.planCenter.y);
    this.stageCamera.lookAt(this.planCenter.x, 0, this.planCenter.y);
    this.callbacks.onStageCameraChange?.();
  }

  private updateOrbitCamera(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const aspect = rect && rect.height > 0 ? rect.width / rect.height : 4 / 3;
    this.stageOrbitCamera.aspect = aspect;
    this.stageOrbitCamera.updateProjectionMatrix();
    const cosine = Math.cos(this.orbitPitch);
    this.stageOrbitCamera.position.set(
      this.orbitTarget.x + this.orbitDistance * cosine * Math.sin(this.orbitYaw),
      this.orbitTarget.y + this.orbitDistance * Math.sin(this.orbitPitch),
      this.orbitTarget.z + this.orbitDistance * cosine * Math.cos(this.orbitYaw),
    );
    this.stageOrbitCamera.up.copy(STAGE_UP);
    this.stageOrbitCamera.lookAt(this.orbitTarget);
  }

  pickPlaygroundIdAt(clientX: number, clientY: number): string | null {
    if (!this.setPointerFromClient(clientX, clientY)) return null;
    this.raycaster.setFromCamera(this.pointerNdc, this.activeStageCamera());
    const hits = this.raycaster.intersectObjects(this.playgroundGroup.children, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node && !node.userData.playgroundId) node = node.parent;
      const id = node?.userData.playgroundId;
      if (typeof id === 'string') return id;
    }
    return null;
  }

  groundPointAt(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!this.setPointerFromClient(clientX, clientY)) return null;
    this.raycaster.setFromCamera(this.pointerNdc, this.activeStageCamera());
    const point = this.raycaster.ray.intersectPlane(this.groundPlane, this.projectionVector);
    if (!point) return null;
    return { x: point.x, z: point.z };
  }

  projectToCanvas(x: number, y: number, z: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.projectionVector.set(x, y, z).project(this.activeStageCamera());
    return { x: (this.projectionVector.x * .5 + .5) * rect.width, y: (-this.projectionVector.y * .5 + .5) * rect.height };
  }

  updateStageObjectTransform(id: string, x: number, z: number, rotation: number, size: { width: number; height: number; depth: number }): boolean {
    const group = this.playgroundGroup.children.find((child) => child.userData.playgroundId === id);
    if (!(group instanceof THREE.Group)) return false;
    group.position.set(x, 0, z);
    group.rotation.y = rotation;
    const base = group.userData.baseSize as { width: number; height: number; depth: number } | undefined;
    if (base && base.width > 0 && base.height > 0 && base.depth > 0) group.scale.set(size.width / base.width, size.height / base.height, size.depth / base.depth);
    this.selectionHelper?.update();
    return true;
  }

  private setPointerFromClient(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    this.pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    return true;
  }

  getRobotPlanarPosition(): { x: number; z: number } { const translation = this.robotBody.translation(); return { x: translation.x, z: translation.z }; }
  setNavigationMode(enabled: boolean): void { this.navigationMode = enabled; if (enabled) this.input = { linear: 0, angular: 0 }; }
  selectRay(index: number): void { if (index < 0 || index >= RAY_COUNT) return; this.highlightedRay = index; this.callbacks.onRaySelection(index, this.rayRanges[index]); }
  getRayCount(): number { return RAY_COUNT; }
  getRayRange(index: number): number { return this.rayRanges[index] ?? RANGE_MAX; }
  getRayAngle(index: number): number { return this.rayAngles[index] ?? 0; }
  getResourceDiagnostics(): { geometries: number; textures: number; playgroundColliders: number; sceneObjects: number } {
    return {
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      playgroundColliders: this.playgroundColliders.length,
      sceneObjects: this.scene.children.length,
    };
  }
  dispose(): void { this.stop(); window.removeEventListener('resize', this.resize); this.unsubscribeCallbacks.forEach((unsubscribe) => unsubscribe()); this.rgbRenderTarget.dispose(); this.depthRenderTarget.dispose(); this.depthMaterial.dispose(); this.renderer.dispose(); this.rayGeometry.dispose(); this.hitGeometry.dispose(); }
}
