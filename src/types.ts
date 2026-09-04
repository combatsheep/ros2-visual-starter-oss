export type TopicName =
  | '/cmd_vel_manual'
  | '/cmd_vel_nav'
  | '/cmd_vel_raw'
  | '/cmd_vel'
  | '/scan'
  | '/odom'
  | '/tf'
  | '/map'
  | '/initialpose'
  | '/pose'
  | '/amcl_pose'
  | '/plan'
  | '/local_plan'
  | '/backup/_action/status'
  | '/safety/stop'
  | '/safety/front_distance'
  | '/control/navigation_mode'
  | '/control/navigation_goal_distance'
  | '/control/mode'
  | '/system/runtime_mode'
  | '/map_library/request'
  | '/map_library/state'
  | '/camera/rgb/image_raw/compressed'
  | '/camera/depth/image_raw'
  | '/camera/camera_info'
  | '/vision/detections'
  | '/vision/annotated/compressed'
  | '/vision/status';

export interface RosTime { sec: number; nanosec: number }
export interface Header { frame_id: string; stamp: RosTime }
export interface Vector3Message { x: number; y: number; z: number }
export interface QuaternionMessage { x: number; y: number; z: number; w: number }
export interface PoseMessage { position: Vector3Message; orientation: QuaternionMessage }

export interface TwistMessage {
  linear: Vector3Message;
  angular: Vector3Message;
}

export interface LaserScanMessage {
  header: Header;
  angle_min: number;
  angle_max: number;
  angle_increment: number;
  time_increment: number;
  scan_time: number;
  range_min: number;
  range_max: number;
  ranges: number[];
  intensities: number[];
}

export interface OdometryMessage {
  header: Header;
  child_frame_id: string;
  pose: { pose: PoseMessage; covariance: number[] };
  twist: { twist: TwistMessage; covariance: number[] };
}

export interface TransformStampedMessage {
  header: Header;
  child_frame_id: string;
  transform: { translation: Vector3Message; rotation: QuaternionMessage };
}

export interface TfMessage { transforms: TransformStampedMessage[] }

export interface OccupancyGridMessage {
  header: Header;
  info: {
    map_load_time: RosTime;
    resolution: number;
    width: number;
    height: number;
    origin: PoseMessage;
  };
  data: number[];
}

export interface PoseStampedMessage { header: Header; pose: PoseMessage }
export interface PoseWithCovarianceStampedMessage {
  header: Header;
  pose: { pose: PoseMessage; covariance: number[] };
}
export interface PathMessage { header: Header; poses: PoseStampedMessage[] }
export interface GoalStatusMessage {
  goal_info: { goal_id: { uuid: number[] | string }; stamp: RosTime };
  status: number;
}
export interface GoalStatusArrayMessage { status_list: GoalStatusMessage[] }
export interface BoolMessage { data: boolean }
export interface Float32Message { data: number }
export interface StringMessage { data: string }

export interface CompressedImageMessage {
  header: Header;
  format: string;
  data: string | number[];
}

export interface ImageMessage {
  header: Header;
  height: number;
  width: number;
  encoding: string;
  is_bigendian: number;
  step: number;
  data: string | number[];
}

export interface CameraInfoMessage {
  header: Header;
  height: number;
  width: number;
  distortion_model: string;
  d: number[];
  k: number[];
  r: number[];
  p: number[];
  binning_x: number;
  binning_y: number;
  roi: { x_offset: number; y_offset: number; height: number; width: number; do_rectify: boolean };
}

export interface Detection2DMessage {
  header: Header;
  results: Array<{
    hypothesis: { class_id: string; score: number };
    pose: { pose: PoseMessage; covariance: number[] };
  }>;
  bbox: {
    center: { position: { x: number; y: number }; theta: number };
    size_x: number;
    size_y: number;
  };
  id: string;
}

export interface Detection2DArrayMessage { header: Header; detections: Detection2DMessage[] }

export type TopicMessage =
  | TwistMessage
  | LaserScanMessage
  | OdometryMessage
  | TfMessage
  | OccupancyGridMessage
  | PoseWithCovarianceStampedMessage
  | PathMessage
  | GoalStatusArrayMessage
  | BoolMessage
  | Float32Message
  | StringMessage
  | CompressedImageMessage
  | ImageMessage
  | CameraInfoMessage
  | Detection2DArrayMessage
  | boolean
  | number
  | string;

export interface TopicDefinition {
  name: TopicName;
  type: string;
  category: 'command' | 'sensor' | 'safety' | 'state' | 'navigation' | 'vision';
}

export interface TransportEvent { topic: TopicName; message: TopicMessage; at: number }
export type ConnectionState = 'SIMULATED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'ERROR';
export interface ControlInput { linear: number; angular: number }
export interface SafetyDecision {
  command: TwistMessage;
  stopped: boolean;
  frontDistance: number;
  reason: 'clear' | 'obstacle' | 'scan-timeout' | 'command-timeout';
}

export type RuntimeMode = 'sim' | 'base' | 'mapping' | 'navigation' | 'exploration';
export type NavigationState = 'idle' | 'sending' | 'moving' | 'succeeded' | 'canceled' | 'failed';
export interface RosLifecycleManagerActivity {
  mapping: boolean | null;
  navigation: boolean | null;
}
export interface RosGraphSnapshot {
  nodes: string[];
  topics: string[];
  actions: string[];
  lifecycleManagers: RosLifecycleManagerActivity;
}
export type NavigationGoalErrorStatus = 'canceled' | 'aborted' | 'failed';
export interface NavigationGoalError {
  status: NavigationGoalErrorStatus;
  message: string;
}
export interface NavigationGoalCallbacks {
  onFeedback: (feedback: unknown) => void;
  onResult: (result: unknown) => void;
  onError: (error: NavigationGoalError) => void;
}

export const TOPICS: TopicDefinition[] = [
  { name: '/cmd_vel_manual', type: 'geometry_msgs/msg/Twist', category: 'command' },
  { name: '/cmd_vel_nav', type: 'geometry_msgs/msg/Twist', category: 'command' },
  { name: '/cmd_vel_raw', type: 'geometry_msgs/msg/Twist', category: 'command' },
  { name: '/cmd_vel', type: 'geometry_msgs/msg/Twist', category: 'command' },
  { name: '/scan', type: 'sensor_msgs/msg/LaserScan', category: 'sensor' },
  { name: '/odom', type: 'nav_msgs/msg/Odometry', category: 'state' },
  { name: '/tf', type: 'tf2_msgs/msg/TFMessage', category: 'state' },
  { name: '/map', type: 'nav_msgs/msg/OccupancyGrid', category: 'navigation' },
  { name: '/initialpose', type: 'geometry_msgs/msg/PoseWithCovarianceStamped', category: 'navigation' },
  { name: '/pose', type: 'geometry_msgs/msg/PoseWithCovarianceStamped', category: 'navigation' },
  { name: '/amcl_pose', type: 'geometry_msgs/msg/PoseWithCovarianceStamped', category: 'navigation' },
  { name: '/plan', type: 'nav_msgs/msg/Path', category: 'navigation' },
  { name: '/local_plan', type: 'nav_msgs/msg/Path', category: 'navigation' },
  { name: '/backup/_action/status', type: 'action_msgs/msg/GoalStatusArray', category: 'navigation' },
  { name: '/safety/stop', type: 'std_msgs/msg/Bool', category: 'safety' },
  { name: '/safety/front_distance', type: 'std_msgs/msg/Float32', category: 'safety' },
  { name: '/control/navigation_mode', type: 'std_msgs/msg/Bool', category: 'navigation' },
  { name: '/control/navigation_goal_distance', type: 'std_msgs/msg/Float32', category: 'navigation' },
  { name: '/control/mode', type: 'std_msgs/msg/String', category: 'navigation' },
  { name: '/system/runtime_mode', type: 'std_msgs/msg/String', category: 'navigation' },
  { name: '/map_library/request', type: 'std_msgs/msg/String', category: 'navigation' },
  { name: '/map_library/state', type: 'std_msgs/msg/String', category: 'navigation' },
  { name: '/camera/rgb/image_raw/compressed', type: 'sensor_msgs/msg/CompressedImage', category: 'vision' },
  { name: '/camera/depth/image_raw', type: 'sensor_msgs/msg/Image', category: 'vision' },
  { name: '/camera/camera_info', type: 'sensor_msgs/msg/CameraInfo', category: 'vision' },
  { name: '/vision/detections', type: 'vision_msgs/msg/Detection2DArray', category: 'vision' },
  { name: '/vision/annotated/compressed', type: 'sensor_msgs/msg/CompressedImage', category: 'vision' },
  { name: '/vision/status', type: 'std_msgs/msg/String', category: 'vision' },
];

export const zeroTwist = (): TwistMessage => ({
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
});

export const makeTwist = (linear: number, angular: number): TwistMessage => ({
  linear: { x: linear, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: angular },
});

export const unwrapBool = (message: TopicMessage): boolean => typeof message === 'boolean' ? message : Boolean((message as BoolMessage).data);
export const unwrapNumber = (message: TopicMessage): number => typeof message === 'number' ? message : Number((message as Float32Message).data);
export const unwrapString = (message: TopicMessage): string => typeof message === 'string' ? message : String((message as StringMessage).data);
