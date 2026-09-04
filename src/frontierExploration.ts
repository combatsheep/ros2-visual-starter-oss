/**
 * ROS/DOM-independent frontier extraction and goal selection for an
 * OccupancyGrid-like row-major array.
 *
 * A frontier cell is a known-free cell with at least one in-bounds unknown
 * cell in its 8-neighbourhood. Map edges are not treated as unknown space.
 */

export interface FrontierPoint {
  x: number;
  y: number;
}

export interface FrontierGridOrigin extends FrontierPoint {
  yaw?: number;
}

export interface FrontierGrid {
  width: number;
  height: number;
  resolution: number;
  origin?: FrontierGridOrigin;
  data: ArrayLike<number>;
}

export interface FrontierCell extends FrontierPoint {
  index: number;
}

export type FrontierCellKind = 'out-of-bounds' | 'unknown' | 'free' | 'occupied';

export interface FrontierDetection {
  frontierMask: Uint8Array;
  cellIndices: Int32Array;
  knownCellCount: number;
  freeCellCount: number;
}

export interface FrontierCluster {
  id: string;
  anchorIndex: number;
  cellIndices: Int32Array;
  cellCount: number;
  centroidCell: FrontierPoint;
  unknownCellCount: number;
  unknownCentroidCell: FrontierPoint;
}

export interface FrontierScoreWeights {
  informationGain: number;
  pathDistance: number;
  clearance: number;
}

export interface FrontierCandidateMetrics {
  informationGain: number;
  pathDistanceMeters: number;
  clearanceMeters: number;
  score: number;
}

export interface FrontierCandidate {
  id: string;
  clusterId: string;
  clusterCellIndices: Int32Array;
  cell: FrontierCell;
  world: FrontierPoint & { yaw: number };
  metrics: FrontierCandidateMetrics;
}

export type FrontierRejectionReason =
  | 'noise'
  | 'no-safe-free-goal'
  | 'unreachable'
  | 'too-close'
  | 'blacklisted'
  | 'candidate-limit';

export interface FrontierRejection {
  clusterId: string;
  clusterCellIndices: Int32Array;
  reason: FrontierRejectionReason;
  candidate: FrontierCandidate | null;
  blacklistStatus?: Exclude<FrontierBlacklistStatus, 'available'>;
}

export type FrontierSelectionReason =
  | 'open-clearance-priority'
  | 'coverage-corner-sweep'
  | 'no-frontiers'
  | 'robot-out-of-bounds'
  | 'robot-not-free'
  | 'robot-insufficient-clearance'
  | 'no-eligible-candidates';

export interface FrontierRobotFootprint {
  lengthMeters: number;
  widthMeters: number;
}

export interface FrontierAnalysisOptions {
  freeOccupancyMax?: number;
  minClusterCells?: number;
  robotFootprint?: FrontierRobotFootprint;
  safetyMarginMeters?: number;
  maxGoalSearchDistanceMeters?: number;
  minGoalPathDistanceMeters?: number;
  maxCandidates?: number;
  maxRejectedClusters?: number;
  scoreWeights?: FrontierScoreWeights;
}

export interface FrontierOptions {
  freeOccupancyMax: number;
  minClusterCells: number;
  robotFootprint: FrontierRobotFootprint;
  safetyMarginMeters: number;
  maxGoalSearchDistanceMeters: number;
  minGoalPathDistanceMeters: number;
  maxCandidates: number;
  maxRejectedClusters: number;
  scoreWeights: FrontierScoreWeights;
}

export type FrontierAttemptOutcome = 'failed' | 'canceled';

export interface FrontierHistoryEntry {
  candidateId: string;
  world: FrontierPoint;
  generation: number;
  knownCellCount: number;
  attempts: number;
  lastOutcome: FrontierAttemptOutcome;
  lastAttemptAtMs: number;
  blockedUntilMs: number;
}

export interface FrontierHistory {
  entries: readonly FrontierHistoryEntry[];
}

export interface FrontierBlacklistPolicy {
  radiusMeters: number;
  cooldownMs: number;
  maxAttempts: number;
  maxEntries: number;
  minKnownCellGrowth: number;
}

export interface FrontierBlacklistQuery {
  world: FrontierPoint;
  generation: number;
  knownCellCount: number;
  nowMs: number;
}

export type FrontierBlacklistStatus = 'available' | 'cooldown' | 'max-attempts';

export interface FrontierAttemptRecord extends FrontierBlacklistQuery {
  candidateId: string;
  outcome: FrontierAttemptOutcome;
}

export interface FrontierAnalysisInput {
  grid: FrontierGrid;
  robotWorld: FrontierPoint;
  generation?: number;
  nowMs?: number;
  history?: FrontierHistory;
  blacklistPolicy?: Partial<FrontierBlacklistPolicy>;
  options?: FrontierAnalysisOptions;
}

export interface FrontierAnalysis {
  frontierMask: Uint8Array;
  frontierCellIndices: Int32Array;
  safeCellMask: Uint8Array;
  clearanceMeters: Float64Array;
  pathDistanceMeters: Float64Array;
  clusters: FrontierCluster[];
  candidates: FrontierCandidate[];
  selected: FrontierCandidate | null;
  selectionReason: FrontierSelectionReason;
  rejected: FrontierRejection[];
  omittedRejectionCount: number;
  blacklistStatusCounts: Readonly<Record<Exclude<FrontierBlacklistStatus, 'available'>, number>>;
  knownCellCount: number;
  freeCellCount: number;
  reachableCellCount: number;
  requiredClearanceMeters: number;
}

export interface OpenFrontierCandidatePriority {
  candidates: FrontierCandidate[];
  clearanceFloorMeters: number;
  maximumClearanceMeters: number;
  preferredClearanceAvailable: boolean;
  relaxedClearanceUsed: boolean;
  spatiallyDistinctCandidateCount: number;
}

export interface ExplorationGoalVisit {
  candidateId: string;
  world: FrontierPoint;
  cornerIndex: number | null;
}

export interface ExplorationGoalVisitHistory {
  entries: readonly ExplorationGoalVisit[];
}

export type FrontierGoalSelectionMode = 'open-space' | 'corner-sweep' | 'post-corner-frontier' | 'object-search';

export type FrontierGoalSelectionPolicy = 'coverage' | 'object-search';

export interface FrontierGoalSelectionPlan {
  mode: FrontierGoalSelectionMode;
  candidates: FrontierCandidate[];
  selected: FrontierCandidate | null;
  clearanceFloorMeters: number;
  preferredClearanceAvailable: boolean;
  relaxedClearanceUsed: boolean;
}

export interface MapCornerGoalCandidateInput {
  grid: FrontierGrid;
  safeCellMask: ArrayLike<number>;
  clearanceMeters: ArrayLike<number>;
  pathDistanceMeters: ArrayLike<number>;
  minGoalPathDistanceMeters?: number;
}

/** Robot circumscribed radius (0.32 m) plus a small map/discretization margin. */
export const EXPLORATION_REQUIRED_CLEARANCE_METERS = .34;
/** Avoid no-op goals inside or just beyond Nav2's 0.28 m goal tolerance. */
export const EXPLORATION_MIN_GOAL_PATH_DISTANCE_METERS = .8;
/** Prefer goals with enough open space to turn and replan without touching the hard Safety margin. */
export const EXPLORATION_PREFERRED_GOAL_CLEARANCE_METERS = .65;
/** Keep candidates in the widest 80% clearance band when genuinely open goals exist. */
export const EXPLORATION_OPEN_CLEARANCE_BAND_RATIO = .8;
/** If every candidate is constrained, expose only the best available 5 cm clearance band. */
export const EXPLORATION_CONSTRAINED_CLEARANCE_BAND_METERS = .05;
/** Backfill a small preferred band before giving up on spatial goal diversity. */
export const EXPLORATION_OPEN_TARGET_CANDIDATE_COUNT = 4;
export const EXPLORATION_RELAXED_GOAL_CLEARANCE_METERS = [.55, .5] as const;
export const EXPLORATION_OPEN_CANDIDATE_SEPARATION_METERS = 1;
/** Keep ordinary goals local enough to avoid long room-diagonal turns near obstacles. */
export const EXPLORATION_LOCAL_GOAL_HORIZON_METERS = 3;
/** A successful LiDAR observation suppresses equivalent goals in this radius for the current run. */
export const EXPLORATION_VISITED_GOAL_RADIUS_METERS = 1;
export const EXPLORATION_MAX_VISITED_GOALS = 32;

const DEFAULT_ROBOT_FOOTPRINT: Readonly<FrontierRobotFootprint> = {
  lengthMeters: .4,
  widthMeters: .5,
};

export const DEFAULT_FRONTIER_OPTIONS: Readonly<FrontierOptions> = {
  freeOccupancyMax: 20,
  minClusterCells: 3,
  robotFootprint: DEFAULT_ROBOT_FOOTPRINT,
  safetyMarginMeters: EXPLORATION_REQUIRED_CLEARANCE_METERS - Math.hypot(
    DEFAULT_ROBOT_FOOTPRINT.lengthMeters / 2,
    DEFAULT_ROBOT_FOOTPRINT.widthMeters / 2,
  ),
  maxGoalSearchDistanceMeters: 1.5,
  minGoalPathDistanceMeters: EXPLORATION_MIN_GOAL_PATH_DISTANCE_METERS,
  maxCandidates: 32,
  maxRejectedClusters: 128,
  scoreWeights: { informationGain: 1, pathDistance: .35, clearance: 1 },
};

export const DEFAULT_FRONTIER_BLACKLIST_POLICY: Readonly<FrontierBlacklistPolicy> = {
  radiusMeters: .5,
  cooldownMs: 10_000,
  maxAttempts: 2,
  maxEntries: 32,
  minKnownCellGrowth: 20,
};

const CARDINAL_DIRECTIONS = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
] as const;

function validateGrid(grid: FrontierGrid): void {
  if (!Number.isInteger(grid.width) || grid.width <= 0 || !Number.isInteger(grid.height) || grid.height <= 0) {
    throw new RangeError('Frontier grid width and height must be positive integers.');
  }
  if (!Number.isFinite(grid.resolution) || grid.resolution <= 0) {
    throw new RangeError('Frontier grid resolution must be a positive finite number.');
  }
  if (grid.data.length !== grid.width * grid.height) {
    throw new RangeError('Frontier grid data length must equal width * height.');
  }
  const origin = grid.origin;
  if (origin && (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.yaw ?? 0))) {
    throw new RangeError('Frontier grid origin must contain finite coordinates.');
  }
}

function resolveOptions(options: FrontierAnalysisOptions = {}): FrontierOptions {
  const resolved: FrontierOptions = {
    ...DEFAULT_FRONTIER_OPTIONS,
    ...options,
    robotFootprint: { ...DEFAULT_FRONTIER_OPTIONS.robotFootprint, ...options.robotFootprint },
    scoreWeights: { ...DEFAULT_FRONTIER_OPTIONS.scoreWeights, ...options.scoreWeights },
  };
  if (!Number.isFinite(resolved.freeOccupancyMax) || resolved.freeOccupancyMax < 0 || resolved.freeOccupancyMax >= 100) {
    throw new RangeError('freeOccupancyMax must be between 0 and 99.');
  }
  if (!Number.isInteger(resolved.minClusterCells) || resolved.minClusterCells < 1) {
    throw new RangeError('minClusterCells must be a positive integer.');
  }
  if (!Number.isFinite(resolved.robotFootprint.lengthMeters) || resolved.robotFootprint.lengthMeters <= 0
    || !Number.isFinite(resolved.robotFootprint.widthMeters) || resolved.robotFootprint.widthMeters <= 0
    || !Number.isFinite(resolved.safetyMarginMeters) || resolved.safetyMarginMeters < 0
    || !Number.isFinite(resolved.maxGoalSearchDistanceMeters) || resolved.maxGoalSearchDistanceMeters < 0
    || !Number.isFinite(resolved.minGoalPathDistanceMeters) || resolved.minGoalPathDistanceMeters < 0) {
    throw new RangeError('Frontier footprint, safety margin, and goal distances must be finite and non-negative.');
  }
  if (!Number.isInteger(resolved.maxCandidates) || resolved.maxCandidates < 1
    || !Number.isInteger(resolved.maxRejectedClusters) || resolved.maxRejectedClusters < 0) {
    throw new RangeError('Frontier candidate and rejection limits must be non-negative integers.');
  }
  if (!Object.values(resolved.scoreWeights).every(Number.isFinite)) {
    throw new RangeError('Frontier score weights must be finite.');
  }
  return resolved;
}

function resolveBlacklistPolicy(policy: Partial<FrontierBlacklistPolicy> = {}): FrontierBlacklistPolicy {
  const resolved = { ...DEFAULT_FRONTIER_BLACKLIST_POLICY, ...policy };
  if (!Number.isFinite(resolved.radiusMeters) || resolved.radiusMeters < 0
    || !Number.isFinite(resolved.cooldownMs) || resolved.cooldownMs < 0
    || !Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1
    || !Number.isInteger(resolved.maxEntries) || resolved.maxEntries < 1
    || !Number.isInteger(resolved.minKnownCellGrowth) || resolved.minKnownCellGrowth < 0) {
    throw new RangeError('Frontier blacklist policy values are outside their supported ranges.');
  }
  return resolved;
}

function cellIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

function cellCoordinates(width: number, index: number): FrontierCell {
  return { index, x: index % width, y: Math.floor(index / width) };
}

function isInBounds(grid: FrontierGrid, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < grid.width && y >= 0 && y < grid.height;
}

function isKnownFreeValue(value: number, freeOccupancyMax: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= freeOccupancyMax;
}

function isUnknownValue(value: number): boolean {
  return Number.isFinite(value) && value < 0;
}

function validateFreeOccupancyMax(freeOccupancyMax: number): void {
  if (!Number.isFinite(freeOccupancyMax) || freeOccupancyMax < 0 || freeOccupancyMax >= 100) {
    throw new RangeError('freeOccupancyMax must be between 0 and 99.');
  }
}

export function classifyFrontierCell(grid: FrontierGrid, x: number, y: number, freeOccupancyMax = DEFAULT_FRONTIER_OPTIONS.freeOccupancyMax): FrontierCellKind {
  validateGrid(grid);
  validateFreeOccupancyMax(freeOccupancyMax);
  if (!isInBounds(grid, x, y)) return 'out-of-bounds';
  const value = Number(grid.data[cellIndex(grid.width, x, y)]);
  if (isUnknownValue(value)) return 'unknown';
  return isKnownFreeValue(value, freeOccupancyMax) ? 'free' : 'occupied';
}

function createFreeMask(grid: FrontierGrid, freeOccupancyMax: number): { mask: Uint8Array; knownCellCount: number; freeCellCount: number } {
  const mask = new Uint8Array(grid.data.length);
  let knownCellCount = 0;
  let freeCellCount = 0;
  for (let index = 0; index < grid.data.length; index += 1) {
    const value = Number(grid.data[index]);
    if (Number.isFinite(value) && value >= 0) knownCellCount += 1;
    if (isKnownFreeValue(value, freeOccupancyMax)) {
      mask[index] = 1;
      freeCellCount += 1;
    }
  }
  return { mask, knownCellCount, freeCellCount };
}

export function detectFrontierCells(grid: FrontierGrid, freeOccupancyMax = DEFAULT_FRONTIER_OPTIONS.freeOccupancyMax): FrontierDetection {
  validateGrid(grid);
  validateFreeOccupancyMax(freeOccupancyMax);
  const free = createFreeMask(grid, freeOccupancyMax);
  const frontierMask = new Uint8Array(grid.data.length);
  const indices = new Int32Array(grid.data.length);
  let count = 0;

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const index = cellIndex(grid.width, x, y);
      if (free.mask[index] === 0) continue;
      let adjacentUnknown = false;
      for (let dy = -1; dy <= 1 && !adjacentUnknown; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx === 0 && dy === 0) || !isInBounds(grid, x + dx, y + dy)) continue;
          if (isUnknownValue(Number(grid.data[cellIndex(grid.width, x + dx, y + dy)]))) {
            adjacentUnknown = true;
            break;
          }
        }
      }
      if (adjacentUnknown) {
        frontierMask[index] = 1;
        indices[count] = index;
        count += 1;
      }
    }
  }

  return {
    frontierMask,
    cellIndices: indices.slice(0, count),
    knownCellCount: free.knownCellCount,
    freeCellCount: free.freeCellCount,
  };
}

export function clusterFrontierCells(
  grid: FrontierGrid,
  frontierMask: Uint8Array,
  freeOccupancyMax = DEFAULT_FRONTIER_OPTIONS.freeOccupancyMax,
): FrontierCluster[] {
  validateGrid(grid);
  validateFreeOccupancyMax(freeOccupancyMax);
  if (frontierMask.length !== grid.data.length) throw new RangeError('Frontier mask length must equal grid data length.');
  const visited = new Uint8Array(grid.data.length);
  const queue = new Int32Array(grid.data.length);
  const unknownMarks = new Uint32Array(grid.data.length);
  const clusters: FrontierCluster[] = [];

  for (let start = 0; start < frontierMask.length; start += 1) {
    if (frontierMask[start] === 0 || visited[start] !== 0 || !isKnownFreeValue(Number(grid.data[start]), freeOccupancyMax)) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let sumX = 0;
    let sumY = 0;

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % grid.width;
      const y = Math.floor(index / grid.width);
      sumX += x + .5;
      sumY += y + .5;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx === 0 && dy === 0) || !isInBounds(grid, x + dx, y + dy)) continue;
          const neighbour = cellIndex(grid.width, x + dx, y + dy);
          if (frontierMask[neighbour] !== 0 && visited[neighbour] === 0
            && isKnownFreeValue(Number(grid.data[neighbour]), freeOccupancyMax)) {
            visited[neighbour] = 1;
            queue[tail] = neighbour;
            tail += 1;
          }
        }
      }
    }

    const clusterIndices = queue.slice(0, tail);
    clusterIndices.sort();
    const mark = clusters.length + 1;
    let unknownCellCount = 0;
    let unknownSumX = 0;
    let unknownSumY = 0;
    for (const index of clusterIndices) {
      const x = index % grid.width;
      const y = Math.floor(index / grid.width);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx === 0 && dy === 0) || !isInBounds(grid, x + dx, y + dy)) continue;
          const neighbourX = x + dx;
          const neighbourY = y + dy;
          const neighbour = cellIndex(grid.width, neighbourX, neighbourY);
          if (unknownMarks[neighbour] === mark || !isUnknownValue(Number(grid.data[neighbour]))) continue;
          unknownMarks[neighbour] = mark;
          unknownCellCount += 1;
          unknownSumX += neighbourX + .5;
          unknownSumY += neighbourY + .5;
        }
      }
    }
    const anchorIndex = clusterIndices[0];
    clusters.push({
      id: `frontier-${anchorIndex}`,
      anchorIndex,
      cellIndices: clusterIndices,
      cellCount: clusterIndices.length,
      centroidCell: { x: sumX / clusterIndices.length, y: sumY / clusterIndices.length },
      unknownCellCount,
      unknownCentroidCell: unknownCellCount > 0
        ? { x: unknownSumX / unknownCellCount, y: unknownSumY / unknownCellCount }
        : { x: sumX / clusterIndices.length, y: sumY / clusterIndices.length },
    });
  }

  return clusters;
}

function distanceTransform1d(
  values: Float64Array,
  length: number,
  output: Float64Array,
  sites: Int32Array,
  intersections: Float64Array,
): void {
  let siteCount = 0;
  for (let q = 0; q < length; q += 1) {
    if (!Number.isFinite(values[q])) continue;
    if (siteCount === 0) {
      sites[0] = q;
      intersections[0] = Number.NEGATIVE_INFINITY;
      intersections[1] = Number.POSITIVE_INFINITY;
      siteCount = 1;
      continue;
    }
    let intersection = 0;
    while (siteCount > 0) {
      const previous = sites[siteCount - 1];
      intersection = ((values[q] + q * q) - (values[previous] + previous * previous)) / (2 * (q - previous));
      if (intersection > intersections[siteCount - 1]) break;
      siteCount -= 1;
    }
    sites[siteCount] = q;
    intersections[siteCount] = siteCount === 0 ? Number.NEGATIVE_INFINITY : intersection;
    intersections[siteCount + 1] = Number.POSITIVE_INFINITY;
    siteCount += 1;
  }

  if (siteCount === 0) {
    output.fill(Number.POSITIVE_INFINITY, 0, length);
    return;
  }
  let envelopeIndex = 0;
  for (let q = 0; q < length; q += 1) {
    while (intersections[envelopeIndex + 1] < q) envelopeIndex += 1;
    const nearest = sites[envelopeIndex];
    const delta = q - nearest;
    output[q] = delta * delta + values[nearest];
  }
}

/** Returns a conservative clearance from occupied/unknown cells and map bounds. */
export function computeClearanceMeters(grid: FrontierGrid, freeOccupancyMax = DEFAULT_FRONTIER_OPTIONS.freeOccupancyMax): Float64Array {
  validateGrid(grid);
  const freeMask = createFreeMask(grid, freeOccupancyMax).mask;
  const cellCount = grid.data.length;
  const horizontal = new Float64Array(cellCount);
  const squaredDistance = new Float64Array(cellCount);
  const maxLineLength = Math.max(grid.width, grid.height);
  const values = new Float64Array(maxLineLength);
  const transformed = new Float64Array(maxLineLength);
  const sites = new Int32Array(maxLineLength);
  const intersections = new Float64Array(maxLineLength + 1);

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      values[x] = freeMask[cellIndex(grid.width, x, y)] === 0 ? 0 : Number.POSITIVE_INFINITY;
    }
    distanceTransform1d(values, grid.width, transformed, sites, intersections);
    for (let x = 0; x < grid.width; x += 1) horizontal[cellIndex(grid.width, x, y)] = transformed[x];
  }

  for (let x = 0; x < grid.width; x += 1) {
    for (let y = 0; y < grid.height; y += 1) values[y] = horizontal[cellIndex(grid.width, x, y)];
    distanceTransform1d(values, grid.height, transformed, sites, intersections);
    for (let y = 0; y < grid.height; y += 1) squaredDistance[cellIndex(grid.width, x, y)] = transformed[y];
  }

  const clearance = new Float64Array(cellCount);
  const unsafeCellHalfDiagonal = grid.resolution * Math.SQRT2 / 2;
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const index = cellIndex(grid.width, x, y);
      if (freeMask[index] === 0) continue;
      const unsafeDistance = Number.isFinite(squaredDistance[index])
        ? Math.max(0, Math.sqrt(squaredDistance[index]) * grid.resolution - unsafeCellHalfDiagonal)
        : Number.POSITIVE_INFINITY;
      const boundaryDistance = Math.min(x + .5, grid.width - x - .5, y + .5, grid.height - y - .5) * grid.resolution;
      clearance[index] = Math.min(unsafeDistance, boundaryDistance);
    }
  }
  return clearance;
}

export function cellCenterToWorld(grid: FrontierGrid, cell: FrontierPoint): FrontierPoint {
  validateGrid(grid);
  const yaw = grid.origin?.yaw ?? 0;
  const localX = (cell.x + .5) * grid.resolution;
  const localY = (cell.y + .5) * grid.resolution;
  return {
    x: (grid.origin?.x ?? 0) + Math.cos(yaw) * localX - Math.sin(yaw) * localY,
    y: (grid.origin?.y ?? 0) + Math.sin(yaw) * localX + Math.cos(yaw) * localY,
  };
}

export function worldToGridCell(grid: FrontierGrid, world: FrontierPoint): FrontierCell | null {
  validateGrid(grid);
  const yaw = grid.origin?.yaw ?? 0;
  const dx = world.x - (grid.origin?.x ?? 0);
  const dy = world.y - (grid.origin?.y ?? 0);
  const x = Math.floor((Math.cos(yaw) * dx + Math.sin(yaw) * dy) / grid.resolution);
  const y = Math.floor((-Math.sin(yaw) * dx + Math.cos(yaw) * dy) / grid.resolution);
  return isInBounds(grid, x, y) ? { x, y, index: cellIndex(grid.width, x, y) } : null;
}

function computePathDistances(grid: FrontierGrid, start: FrontierCell | null, freeMask: Uint8Array, safeMask: Uint8Array): { distances: Float64Array; reachableCellCount: number } {
  const distances = new Float64Array(grid.data.length);
  distances.fill(Number.POSITIVE_INFINITY);
  if (!start || freeMask[start.index] === 0) return { distances, reachableCellCount: 0 };
  const queue = new Int32Array(grid.data.length);
  let head = 0;
  let tail = 1;
  let reachableCellCount = 1;
  queue[0] = start.index;
  distances[start.index] = 0;
  // A robot may start in a narrow but known-free pocket. Keep that one cell
  // as the path origin, then require every exit and subsequent transit cell to
  // satisfy safeMask. This permits a local escape without routing a goal
  // through an arbitrarily long clearance-violating corridor.
  const pathMask = safeMask;

  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % grid.width;
    const y = Math.floor(index / grid.width);
    const nextDistance = distances[index] + grid.resolution;
    for (const direction of CARDINAL_DIRECTIONS) {
      const nextX = x + direction.x;
      const nextY = y + direction.y;
      if (!isInBounds(grid, nextX, nextY)) continue;
      const next = cellIndex(grid.width, nextX, nextY);
      if (pathMask[next] === 0 || Number.isFinite(distances[next])) continue;
      distances[next] = nextDistance;
      queue[tail] = next;
      tail += 1;
      reachableCellCount += 1;
    }
  }
  return { distances, reachableCellCount };
}

export function scoreFrontierCandidate(
  metrics: Omit<FrontierCandidateMetrics, 'score'>,
  weights: FrontierScoreWeights = DEFAULT_FRONTIER_OPTIONS.scoreWeights,
): number {
  return metrics.informationGain * weights.informationGain
    - metrics.pathDistanceMeters * weights.pathDistance
    + metrics.clearanceMeters * weights.clearance;
}

/** Sort comparator: best score first, then deterministic safety-oriented ties. */
export function compareFrontierCandidates(left: FrontierCandidate, right: FrontierCandidate): number {
  if (left.metrics.score !== right.metrics.score) return left.metrics.score > right.metrics.score ? -1 : 1;
  if (left.metrics.informationGain !== right.metrics.informationGain) return left.metrics.informationGain > right.metrics.informationGain ? -1 : 1;
  if (left.metrics.pathDistanceMeters !== right.metrics.pathDistanceMeters) return left.metrics.pathDistanceMeters < right.metrics.pathDistanceMeters ? -1 : 1;
  if (left.metrics.clearanceMeters !== right.metrics.clearanceMeters) return left.metrics.clearanceMeters > right.metrics.clearanceMeters ? -1 : 1;
  if (left.cell.index !== right.cell.index) return left.cell.index - right.cell.index;
  if (left.clusterId === right.clusterId) return 0;
  return left.clusterId < right.clusterId ? -1 : 1;
}

/** Sort comparator used by the open-space policy: clearance first, score only inside a clearance tie. */
export function compareFrontierCandidatesByClearance(left: FrontierCandidate, right: FrontierCandidate): number {
  if (left.metrics.clearanceMeters !== right.metrics.clearanceMeters) {
    return left.metrics.clearanceMeters > right.metrics.clearanceMeters ? -1 : 1;
  }
  return compareFrontierCandidates(left, right);
}

/**
 * Stage 1: expose only candidates in the widest available clearance band.
 * The hard robot clearance remains mandatory. When no goal reaches the
 * preferred open-space threshold, the policy progressively falls back to the
 * safest currently available band instead of declaring candidate exhaustion.
 */
export function prioritizeOpenFrontierCandidates(
  candidates: readonly FrontierCandidate[],
  requiredClearanceMeters = EXPLORATION_REQUIRED_CLEARANCE_METERS,
  preferredClearanceMeters = EXPLORATION_PREFERRED_GOAL_CLEARANCE_METERS,
  openBandRatio = EXPLORATION_OPEN_CLEARANCE_BAND_RATIO,
): OpenFrontierCandidatePriority {
  if (!Number.isFinite(requiredClearanceMeters) || requiredClearanceMeters < 0
    || !Number.isFinite(preferredClearanceMeters) || preferredClearanceMeters < requiredClearanceMeters
    || !Number.isFinite(openBandRatio) || openBandRatio <= 0 || openBandRatio > 1) {
    throw new RangeError('Open frontier clearance policy is outside its supported range.');
  }
  const safeCandidates = candidates.filter((candidate) => Number.isFinite(candidate.metrics.clearanceMeters)
    && candidate.metrics.clearanceMeters + Number.EPSILON >= requiredClearanceMeters);
  if (safeCandidates.length === 0) {
    return {
      candidates: [],
      clearanceFloorMeters: requiredClearanceMeters,
      maximumClearanceMeters: 0,
      preferredClearanceAvailable: false,
      relaxedClearanceUsed: false,
      spatiallyDistinctCandidateCount: 0,
    };
  }
  const maximumClearanceMeters = Math.max(...safeCandidates.map((candidate) => candidate.metrics.clearanceMeters));
  const preferredClearanceAvailable = maximumClearanceMeters + Number.EPSILON >= preferredClearanceMeters;
  const clearanceFloorMeters = preferredClearanceAvailable
    ? Math.max(preferredClearanceMeters, maximumClearanceMeters * openBandRatio)
    : Math.max(requiredClearanceMeters, maximumClearanceMeters - EXPLORATION_CONSTRAINED_CLEARANCE_BAND_METERS);
  const sortedCandidates = safeCandidates.sort(compareFrontierCandidatesByClearance);
  const selectedCandidates = sortedCandidates
    .filter((candidate) => candidate.metrics.clearanceMeters + Number.EPSILON >= clearanceFloorMeters);
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.id));
  const spatialAnchors: FrontierCandidate[] = [];
  const addSpatialAnchor = (candidate: FrontierCandidate): boolean => {
    if (spatialAnchors.some((anchor) => Math.hypot(
      candidate.world.x - anchor.world.x,
      candidate.world.y - anchor.world.y,
    ) + Number.EPSILON < EXPLORATION_OPEN_CANDIDATE_SEPARATION_METERS)) return false;
    spatialAnchors.push(candidate);
    return true;
  };
  selectedCandidates.forEach(addSpatialAnchor);
  if (preferredClearanceAvailable && spatialAnchors.length < EXPLORATION_OPEN_TARGET_CANDIDATE_COUNT) {
    for (const relaxedClearance of EXPLORATION_RELAXED_GOAL_CLEARANCE_METERS) {
      const relaxedFloor = Math.max(requiredClearanceMeters, relaxedClearance);
      for (const candidate of sortedCandidates) {
        if (spatialAnchors.length >= EXPLORATION_OPEN_TARGET_CANDIDATE_COUNT) break;
        if (selectedIds.has(candidate.id)
          || candidate.metrics.clearanceMeters + Number.EPSILON < relaxedFloor
          || !addSpatialAnchor(candidate)) continue;
        selectedCandidates.push(candidate);
        selectedIds.add(candidate.id);
      }
      if (spatialAnchors.length >= EXPLORATION_OPEN_TARGET_CANDIDATE_COUNT) break;
    }
  }
  selectedCandidates.sort(compareFrontierCandidatesByClearance);
  const effectiveClearanceFloorMeters = selectedCandidates.length > 0
    ? Math.min(...selectedCandidates.map((candidate) => candidate.metrics.clearanceMeters))
    : clearanceFloorMeters;
  return {
    candidates: selectedCandidates,
    clearanceFloorMeters: effectiveClearanceFloorMeters,
    maximumClearanceMeters,
    preferredClearanceAvailable,
    relaxedClearanceUsed: effectiveClearanceFloorMeters + Number.EPSILON < clearanceFloorMeters,
    spatiallyDistinctCandidateCount: spatialAnchors.length,
  };
}

/** Select the farthest candidate from the current pose with deterministic safety-oriented ties. */
export function selectFarthestFrontierCandidate(
  candidates: readonly FrontierCandidate[],
  robotWorld: FrontierPoint,
): FrontierCandidate | null {
  let selected: FrontierCandidate | null = null;
  let selectedDistance = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.world.x - robotWorld.x, candidate.world.y - robotWorld.y);
    if (!Number.isFinite(distance)) continue;
    if (distance > selectedDistance + Number.EPSILON
      || (Math.abs(distance - selectedDistance) <= Number.EPSILON
        && selected !== null
        && compareFrontierCandidatesByClearance(candidate, selected) < 0)) {
      selected = candidate;
      selectedDistance = distance;
    }
  }
  return selected;
}

/**
 * When an object-search roaming loop has visited every current waypoint,
 * prefer a waypoint away from the latest successful visit. Reusing a bounded
 * interior set is intentional, but immediately selecting the previous point
 * creates a visible back-and-forth loop when the map has not grown yet.
 */
export function selectObjectSearchRoamingCandidate(
  candidates: readonly FrontierCandidate[],
  robotWorld: FrontierPoint,
  history: ExplorationGoalVisitHistory,
  minimumSeparationMeters = EXPLORATION_OPEN_CANDIDATE_SEPARATION_METERS,
): FrontierCandidate | null {
  if (!Number.isFinite(minimumSeparationMeters) || minimumSeparationMeters < 0) {
    throw new RangeError('Object Search roaming separation must be finite and non-negative.');
  }
  if (candidates.length === 0) return null;
  const lastVisit = history.entries[history.entries.length - 1];
  if (!lastVisit) return selectFarthestFrontierCandidate(candidates, robotWorld);
  const nonBacktrackingCandidates = candidates.filter((candidate) => Math.hypot(
    candidate.world.x - lastVisit.world.x,
    candidate.world.y - lastVisit.world.y,
  ) + Number.EPSILON >= minimumSeparationMeters);
  return selectFarthestFrontierCandidate(
    nonBacktrackingCandidates.length > 0 ? nonBacktrackingCandidates : candidates,
    robotWorld,
  );
}

/**
 * Prefer steady outward progress inside a local path-distance horizon. When
 * the horizon contains no candidate, take the nearest reachable candidate
 * beyond it instead of jumping to the room's opposite side.
 */
export function selectProgressiveFrontierCandidate(
  candidates: readonly FrontierCandidate[],
  localHorizonMeters = EXPLORATION_LOCAL_GOAL_HORIZON_METERS,
): FrontierCandidate | null {
  if (!Number.isFinite(localHorizonMeters) || localHorizonMeters <= 0) {
    throw new RangeError('Local goal horizon must be a positive finite distance.');
  }
  let local: FrontierCandidate | null = null;
  let localDistance = Number.NEGATIVE_INFINITY;
  let fallback: FrontierCandidate | null = null;
  let fallbackDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = candidate.metrics.pathDistanceMeters;
    if (!Number.isFinite(distance) || distance < 0) continue;
    if (distance <= localHorizonMeters + Number.EPSILON) {
      if (distance > localDistance + Number.EPSILON
        || (Math.abs(distance - localDistance) <= Number.EPSILON
          && (local === null || compareFrontierCandidatesByClearance(candidate, local) < 0))) {
        local = candidate;
        localDistance = distance;
      }
      continue;
    }
    if (distance < fallbackDistance - Number.EPSILON
      || (Math.abs(distance - fallbackDistance) <= Number.EPSILON
        && (fallback === null || compareFrontierCandidatesByClearance(candidate, fallback) < 0))) {
      fallback = candidate;
      fallbackDistance = distance;
    }
  }
  return local ?? fallback;
}

export function createExplorationGoalVisitHistory(): ExplorationGoalVisitHistory {
  return { entries: [] };
}

export function cornerIndexForCandidate(candidate: FrontierCandidate): number | null {
  const match = /^corner-sweep-([0-3])$/.exec(candidate.clusterId);
  return match ? Number(match[1]) : null;
}

/**
 * Successful goals are remembered by world-space radius because frontier IDs
 * can change whenever the live OccupancyGrid grows. Corner visits additionally
 * retain their logical corner index so regenerated safe cells are not revisited.
 */
export function recordExplorationGoalVisit(
  history: ExplorationGoalVisitHistory,
  candidate: FrontierCandidate,
  radiusMeters = EXPLORATION_VISITED_GOAL_RADIUS_METERS,
  maxEntries = EXPLORATION_MAX_VISITED_GOALS,
): ExplorationGoalVisitHistory {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0
    || !Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('Exploration goal visit policy is outside its supported range.');
  }
  const cornerIndex = cornerIndexForCandidate(candidate);
  const alreadyVisited = cornerIndex !== null
    ? history.entries.some((entry) => entry.cornerIndex === cornerIndex)
    : history.entries.some((entry) => Math.hypot(
      entry.world.x - candidate.world.x,
      entry.world.y - candidate.world.y,
    ) + Number.EPSILON < radiusMeters);
  if (alreadyVisited) return history;
  return {
    entries: [...history.entries, {
      candidateId: candidate.id,
      world: { x: candidate.world.x, y: candidate.world.y },
      cornerIndex,
    }].slice(-maxEntries),
  };
}

/** Exclude places already observed by a successful visit, independent of regenerated candidate IDs. */
export function filterUnvisitedGoalCandidates(
  candidates: readonly FrontierCandidate[],
  history: ExplorationGoalVisitHistory,
  radiusMeters = EXPLORATION_VISITED_GOAL_RADIUS_METERS,
): FrontierCandidate[] {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new RangeError('Visited goal radius must be finite and non-negative.');
  }
  return candidates.filter((candidate) => history.entries.every((entry) => Math.hypot(
    entry.world.x - candidate.world.x,
    entry.world.y - candidate.world.y,
  ) + Number.EPSILON >= radiusMeters));
}

/**
 * Start at the nearest safe corner, then visit adjacent map corners clockwise
 * (0 -> 1 -> 2 -> 3) exactly once. Missing/unsafe corners are skipped without
 * jumping back to a previously visited diagonal corner.
 */
export function selectNextCornerSweepCandidate(
  candidates: readonly FrontierCandidate[],
  robotWorld: FrontierPoint,
  history: ExplorationGoalVisitHistory,
): FrontierCandidate | null {
  const visitedCorners = history.entries
    .map((entry) => entry.cornerIndex)
    .filter((cornerIndex): cornerIndex is number => cornerIndex !== null);
  const visitedSet = new Set(visitedCorners);
  const remaining = candidates.filter((candidate) => {
    const cornerIndex = cornerIndexForCandidate(candidate);
    return cornerIndex !== null && !visitedSet.has(cornerIndex);
  });
  if (remaining.length === 0) return null;
  if (visitedCorners.length === 0) {
    let selected: FrontierCandidate | null = null;
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (const candidate of remaining) {
      const distance = Math.hypot(candidate.world.x - robotWorld.x, candidate.world.y - robotWorld.y);
      if (!Number.isFinite(distance)) continue;
      if (distance < selectedDistance - Number.EPSILON
        || (Math.abs(distance - selectedDistance) <= Number.EPSILON
          && (selected === null
            || (cornerIndexForCandidate(candidate) ?? 4) < (cornerIndexForCandidate(selected) ?? 4)))) {
        selected = candidate;
        selectedDistance = distance;
      }
    }
    return selected;
  }
  const lastCornerIndex = visitedCorners[visitedCorners.length - 1];
  for (let offset = 1; offset <= 4; offset += 1) {
    const desiredCornerIndex = (lastCornerIndex + offset) % 4;
    if (visitedSet.has(desiredCornerIndex)) continue;
    const matches = remaining
      .filter((candidate) => cornerIndexForCandidate(candidate) === desiredCornerIndex)
      .sort(compareFrontierCandidatesByClearance);
    if (matches.length > 0) return matches[0];
  }
  return null;
}

/**
 * Build one direct navigation goal for each map corner. Literal corner cells
 * may be occupied or unknown, so each goal is the closest known-free cell that
 * already passed clearance and reachability checks. These goals deliberately
 * do not depend on the frontier cluster shortlist.
 */
export function createMapCornerGoalCandidates(
  input: MapCornerGoalCandidateInput,
): FrontierCandidate[] {
  const { grid, safeCellMask, clearanceMeters, pathDistanceMeters } = input;
  validateGrid(grid);
  if (safeCellMask.length !== grid.data.length
    || clearanceMeters.length !== grid.data.length
    || pathDistanceMeters.length !== grid.data.length) {
    throw new RangeError('Map corner goal masks must match the OccupancyGrid size.');
  }
  const minGoalPathDistanceMeters = input.minGoalPathDistanceMeters ?? EXPLORATION_MIN_GOAL_PATH_DISTANCE_METERS;
  if (!Number.isFinite(minGoalPathDistanceMeters) || minGoalPathDistanceMeters < 0) {
    throw new RangeError('Map corner minimum goal distance must be finite and non-negative.');
  }
  const corners = [
    cellCenterToWorld(grid, { x: 0, y: 0 }),
    cellCenterToWorld(grid, { x: grid.width - 1, y: 0 }),
    cellCenterToWorld(grid, { x: grid.width - 1, y: grid.height - 1 }),
    cellCenterToWorld(grid, { x: 0, y: grid.height - 1 }),
  ];
  const selected = new Map<number, FrontierCandidate>();
  corners.forEach((corner, cornerIndex) => {
    let closestIndex = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < grid.data.length; index += 1) {
      const pathDistance = Number(pathDistanceMeters[index]);
      if (Number(safeCellMask[index]) === 0
        || !Number.isFinite(pathDistance)
        || pathDistance + Number.EPSILON < minGoalPathDistanceMeters) continue;
      const cell = cellCoordinates(grid.width, index);
      const world = cellCenterToWorld(grid, cell);
      const distance = Math.hypot(world.x - corner.x, world.y - corner.y);
      if (distance < closestDistance - Number.EPSILON
        || (Math.abs(distance - closestDistance) <= Number.EPSILON
          && (closestIndex < 0
            || Number(clearanceMeters[index]) > Number(clearanceMeters[closestIndex]) + Number.EPSILON
            || (Math.abs(Number(clearanceMeters[index]) - Number(clearanceMeters[closestIndex])) <= Number.EPSILON
              && index < closestIndex)))) {
        closestIndex = index;
        closestDistance = distance;
      }
    }
    if (closestIndex < 0 || selected.has(closestIndex)) return;
    const cell = cellCoordinates(grid.width, closestIndex);
    const world = cellCenterToWorld(grid, cell);
    const yaw = normalizedYaw(Math.atan2(corner.y - world.y, corner.x - world.x));
    const metricsWithoutScore = {
      informationGain: 0,
      pathDistanceMeters: Number(pathDistanceMeters[closestIndex]),
      clearanceMeters: Number(clearanceMeters[closestIndex]),
    };
    selected.set(closestIndex, {
      id: `corner-${cornerIndex}-goal-${closestIndex}`,
      clusterId: `corner-sweep-${cornerIndex}`,
      clusterCellIndices: Int32Array.of(closestIndex),
      cell,
      world: { ...world, yaw },
      metrics: {
        ...metricsWithoutScore,
        score: scoreFrontierCandidate(metricsWithoutScore),
      },
    });
  });
  return [...selected.values()];
}

export interface ObjectSearchRoamingGoalCandidateInput {
  grid: FrontierGrid;
  safeCellMask: ArrayLike<number>;
  clearanceMeters: ArrayLike<number>;
  pathDistanceMeters: ArrayLike<number>;
  robotWorld: FrontierPoint;
  requiredClearanceMeters?: number;
  minGoalPathDistanceMeters?: number;
  maxCandidates?: number;
}

/**
 * Select bounded, interior waypoints for a perception mission after normal
 * frontier goals are exhausted. This deliberately uses interior map anchors,
 * never the map-corner tour used by coverage exploration.
 */
export function createObjectSearchRoamingGoalCandidates(
  input: ObjectSearchRoamingGoalCandidateInput,
): FrontierCandidate[] {
  const {
    grid,
    safeCellMask,
    clearanceMeters,
    pathDistanceMeters,
    robotWorld,
  } = input;
  validateGrid(grid);
  if (safeCellMask.length !== grid.data.length
    || clearanceMeters.length !== grid.data.length
    || pathDistanceMeters.length !== grid.data.length) {
    throw new RangeError('Object Search roaming masks must match the OccupancyGrid size.');
  }
  if (!Number.isFinite(robotWorld.x) || !Number.isFinite(robotWorld.y)) {
    throw new RangeError('Object Search roaming robot position must be finite.');
  }
  const requiredClearanceMeters = input.requiredClearanceMeters ?? EXPLORATION_REQUIRED_CLEARANCE_METERS;
  const minGoalPathDistanceMeters = input.minGoalPathDistanceMeters ?? EXPLORATION_MIN_GOAL_PATH_DISTANCE_METERS;
  const maxCandidates = input.maxCandidates ?? 9;
  if (!Number.isFinite(requiredClearanceMeters) || requiredClearanceMeters < 0
    || !Number.isFinite(minGoalPathDistanceMeters) || minGoalPathDistanceMeters < 0
    || !Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new RangeError('Object Search roaming goal policy is outside its supported range.');
  }

  const anchorRatios = [.2, .5, .8];
  const anchors: FrontierPoint[] = [];
  for (const yRatio of anchorRatios) {
    for (const xRatio of anchorRatios) {
      anchors.push({
        x: (grid.width - 1) * xRatio,
        y: (grid.height - 1) * yRatio,
      });
    }
  }
  const isInterior = (cell: FrontierCell): boolean => cell.x > 0
    && cell.x < grid.width - 1
    && cell.y > 0
    && cell.y < grid.height - 1;
  const selectedIndices = new Set<number>();
  const centerWorld = cellCenterToWorld(grid, {
    x: (grid.width - 1) / 2,
    y: (grid.height - 1) / 2,
  });
  const orientationTarget = Math.hypot(centerWorld.x - robotWorld.x, centerWorld.y - robotWorld.y) > Number.EPSILON
    ? centerWorld
    : robotWorld;
  const candidates: FrontierCandidate[] = [];

  anchors.forEach((anchor, anchorIndex) => {
    if (candidates.length >= maxCandidates) return;
    const choose = (allowBoundary: boolean): { index: number; cell: FrontierCell; anchorDistance: number } | null => {
      let selected: { index: number; cell: FrontierCell; anchorDistance: number } | null = null;
      for (let index = 0; index < grid.data.length; index += 1) {
        if (selectedIndices.has(index) || Number(safeCellMask[index]) === 0) continue;
        const pathDistance = Number(pathDistanceMeters[index]);
        const clearance = Number(clearanceMeters[index]);
        if (!Number.isFinite(pathDistance) || pathDistance + Number.EPSILON < minGoalPathDistanceMeters
          || !Number.isFinite(clearance) || clearance + Number.EPSILON < requiredClearanceMeters) continue;
        const cell = cellCoordinates(grid.width, index);
        if (!allowBoundary && !isInterior(cell)) continue;
        const anchorDistance = Math.hypot(cell.x - anchor.x, cell.y - anchor.y);
        if (!Number.isFinite(anchorDistance)) continue;
        if (selected === null
          || anchorDistance < selected.anchorDistance - Number.EPSILON
          || (Math.abs(anchorDistance - selected.anchorDistance) <= Number.EPSILON
            && (clearance > Number(clearanceMeters[selected.index]) + Number.EPSILON
              || (Math.abs(clearance - Number(clearanceMeters[selected.index])) <= Number.EPSILON
                && (pathDistance > Number(pathDistanceMeters[selected.index]) + Number.EPSILON
                  || (Math.abs(pathDistance - Number(pathDistanceMeters[selected.index])) <= Number.EPSILON
                    && index < selected.index)))))) {
          selected = { index, cell, anchorDistance };
        }
      }
      return selected;
    };
    const selected = choose(false) ?? choose(true);
    if (!selected) return;
    selectedIndices.add(selected.index);
    const world = cellCenterToWorld(grid, selected.cell);
    const yaw = normalizedYaw(Math.atan2(
      orientationTarget.y - world.y,
      orientationTarget.x - world.x,
    ));
    const metricsWithoutScore = {
      informationGain: 0,
      pathDistanceMeters: Number(pathDistanceMeters[selected.index]),
      clearanceMeters: Number(clearanceMeters[selected.index]),
    };
    candidates.push({
      id: `object-search-roaming-${anchorIndex}-goal-${selected.index}`,
      clusterId: `object-search-roaming-${anchorIndex}`,
      clusterCellIndices: Int32Array.of(selected.index),
      cell: selected.cell,
      world: { ...world, yaw },
      metrics: {
        ...metricsWithoutScore,
        score: scoreFrontierCandidate(metricsWithoutScore),
      },
    });
    if (candidates.length >= maxCandidates) return;
  });
  return candidates;
}

/** Pure two-phase policy used by the exploration goal producer. */
export function planFrontierGoalSelection(
  frontierCandidates: readonly FrontierCandidate[],
  cornerCandidates: readonly FrontierCandidate[],
  robotWorld: FrontierPoint,
  cornerSweepLatched: boolean,
  requiredClearanceMeters = EXPLORATION_REQUIRED_CLEARANCE_METERS,
  visitHistory: ExplorationGoalVisitHistory = createExplorationGoalVisitHistory(),
  blacklistedCandidateIds: readonly string[] = [],
  policy: FrontierGoalSelectionPolicy = 'coverage',
  reuseVisitedWhenExhausted = false,
): FrontierGoalSelectionPlan {
  const exactBlacklist = new Set(blacklistedCandidateIds);
  const unvisitedFrontierCandidates = filterUnvisitedGoalCandidates(
    frontierCandidates.filter((candidate) => !exactBlacklist.has(candidate.id)),
    visitHistory,
  );
  const availableFrontierCandidates = policy === 'object-search'
    && reuseVisitedWhenExhausted
    && unvisitedFrontierCandidates.length === 0
    ? frontierCandidates.filter((candidate) => !exactBlacklist.has(candidate.id))
    : unvisitedFrontierCandidates;
  if (policy !== 'object-search' && cornerSweepLatched) {
    const safeCandidates = cornerCandidates.filter((candidate) => Number.isFinite(candidate.metrics.clearanceMeters)
      && candidate.metrics.clearanceMeters + Number.EPSILON >= requiredClearanceMeters
      && !exactBlacklist.has(candidate.id));
    const visitedCornerIndices = new Set(visitHistory.entries
      .map((entry) => entry.cornerIndex)
      .filter((cornerIndex): cornerIndex is number => cornerIndex !== null));
    const remainingCornerCandidates = safeCandidates.filter((candidate) => {
      const cornerIndex = cornerIndexForCandidate(candidate);
      return cornerIndex !== null && !visitedCornerIndices.has(cornerIndex);
    });
    const nextCorner = selectNextCornerSweepCandidate(remainingCornerCandidates, robotWorld, visitHistory);
    if (nextCorner) {
      return {
        mode: 'corner-sweep',
        candidates: remainingCornerCandidates,
        selected: nextCorner,
        clearanceFloorMeters: requiredClearanceMeters,
        preferredClearanceAvailable: false,
        relaxedClearanceUsed: false,
      };
    }
  }
  const openPriority = prioritizeOpenFrontierCandidates(availableFrontierCandidates, requiredClearanceMeters);
  return {
    mode: policy === 'object-search' ? 'object-search' : cornerSweepLatched ? 'post-corner-frontier' : 'open-space',
    candidates: openPriority.candidates,
    selected: selectProgressiveFrontierCandidate(openPriority.candidates),
    clearanceFloorMeters: openPriority.clearanceFloorMeters,
    preferredClearanceAvailable: openPriority.preferredClearanceAvailable,
    relaxedClearanceUsed: openPriority.relaxedClearanceUsed,
  };
}

function normalizedYaw(yaw: number): number {
  return Math.atan2(Math.sin(yaw), Math.cos(yaw));
}

function directionToUnknown(grid: FrontierGrid, cluster: FrontierCluster, cell: FrontierCell): FrontierPoint {
  const centroidDirection = {
    x: cluster.unknownCentroidCell.x - (cell.x + .5),
    y: cluster.unknownCentroidCell.y - (cell.y + .5),
  };
  if (Math.hypot(centroidDirection.x, centroidDirection.y) > Number.EPSILON) return centroidDirection;

  // A symmetric unknown region can put its centroid on the goal. Fall back to
  // the first row-major adjacent unknown cell so yaw remains deterministic.
  for (const frontierIndex of cluster.cellIndices) {
    const frontierX = frontierIndex % grid.width;
    const frontierY = Math.floor(frontierIndex / grid.width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const unknownX = frontierX + dx;
        const unknownY = frontierY + dy;
        if (!isInBounds(grid, unknownX, unknownY)) continue;
        if (isUnknownValue(Number(grid.data[cellIndex(grid.width, unknownX, unknownY)]))) {
          return { x: unknownX - cell.x, y: unknownY - cell.y };
        }
      }
    }
  }
  return { x: 1, y: 0 };
}

interface GoalSearchScratch {
  visited: Uint32Array;
  depth: Int32Array;
  queue: Int32Array;
  stamp: number;
}

function findClusterGoal(
  grid: FrontierGrid,
  cluster: FrontierCluster,
  freeMask: Uint8Array,
  safeMask: Uint8Array,
  clearanceMeters: Float64Array,
  pathDistanceMeters: Float64Array,
  options: FrontierOptions,
  scratch: GoalSearchScratch,
): { candidate: FrontierCandidate | null; safeCellSeen: boolean } {
  scratch.stamp += 1;
  const stamp = scratch.stamp;
  let head = 0;
  let tail = 0;
  for (const index of cluster.cellIndices) {
    if (scratch.visited[index] === stamp) continue;
    scratch.visited[index] = stamp;
    scratch.depth[index] = 0;
    scratch.queue[tail] = index;
    tail += 1;
  }
  const maxDepth = Math.ceil(options.maxGoalSearchDistanceMeters / grid.resolution);
  let preferredSelected: FrontierCandidate | null = null;
  let fallbackSelected: FrontierCandidate | null = null;
  let safeCellSeen = false;
  const preferredClearanceMeters = Math.max(
    EXPLORATION_PREFERRED_GOAL_CLEARANCE_METERS,
    Math.hypot(options.robotFootprint.lengthMeters / 2, options.robotFootprint.widthMeters / 2) + options.safetyMarginMeters,
  );

  while (head < tail) {
    const index = scratch.queue[head];
    head += 1;
    const depth = scratch.depth[index];
    if (depth > maxDepth) break;
    if (safeMask[index] !== 0) {
      safeCellSeen = true;
      if (Number.isFinite(pathDistanceMeters[index])) {
        const cell = cellCoordinates(grid.width, index);
        const world = cellCenterToWorld(grid, cell);
        const unknownDirection = directionToUnknown(grid, cluster, cell);
        const gridYaw = Math.atan2(unknownDirection.y, unknownDirection.x);
        const metricsWithoutScore = {
          informationGain: cluster.unknownCellCount,
          pathDistanceMeters: pathDistanceMeters[index],
          clearanceMeters: clearanceMeters[index],
        };
        const candidate: FrontierCandidate = {
          id: `${cluster.id}-goal-${index}`,
          clusterId: cluster.id,
          clusterCellIndices: cluster.cellIndices,
          cell,
          world: { ...world, yaw: normalizedYaw(gridYaw + (grid.origin?.yaw ?? 0)) },
          metrics: {
            ...metricsWithoutScore,
            score: scoreFrontierCandidate(metricsWithoutScore, options.scoreWeights),
          },
        };
        if (!fallbackSelected || compareFrontierCandidatesByClearance(candidate, fallbackSelected) < 0) fallbackSelected = candidate;
        if (candidate.metrics.clearanceMeters + Number.EPSILON >= preferredClearanceMeters
          && (!preferredSelected || compareFrontierCandidates(candidate, preferredSelected) < 0)) {
          preferredSelected = candidate;
        }
      }
    }
    if (depth >= maxDepth) continue;
    const x = index % grid.width;
    const y = Math.floor(index / grid.width);
    for (const direction of CARDINAL_DIRECTIONS) {
      const nextX = x + direction.x;
      const nextY = y + direction.y;
      if (!isInBounds(grid, nextX, nextY)) continue;
      const next = cellIndex(grid.width, nextX, nextY);
      if (freeMask[next] === 0 || scratch.visited[next] === stamp) continue;
      scratch.visited[next] = stamp;
      scratch.depth[next] = depth + 1;
      scratch.queue[tail] = next;
      tail += 1;
    }
  }
  return { candidate: preferredSelected ?? fallbackSelected, safeCellSeen };
}

function appendBoundedRejection(
  rejected: FrontierRejection[],
  rejection: FrontierRejection,
  limit: number,
): number {
  if (rejected.length < limit) {
    rejected.push(rejection);
    return 0;
  }
  return 1;
}

function insertBoundedCandidate(candidates: FrontierCandidate[], candidate: FrontierCandidate, limit: number): FrontierCandidate | null {
  candidates.push(candidate);
  candidates.sort(compareFrontierCandidatesByClearance);
  return candidates.length > limit ? candidates.pop() ?? null : null;
}

export function createFrontierHistory(): FrontierHistory {
  return { entries: [] };
}

function hasSufficientMapGrowth(entry: FrontierHistoryEntry, query: FrontierBlacklistQuery, policy: FrontierBlacklistPolicy): boolean {
  return query.generation > entry.generation
    && query.knownCellCount >= entry.knownCellCount + policy.minKnownCellGrowth;
}

function locationsMatch(left: FrontierPoint, right: FrontierPoint, radiusMeters: number): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y) <= radiusMeters;
}

export function isFrontierBlacklisted(
  history: FrontierHistory,
  query: FrontierBlacklistQuery,
  policyOverrides: Partial<FrontierBlacklistPolicy> = {},
): boolean {
  return getFrontierBlacklistStatus(history, query, policyOverrides) !== 'available';
}

export function getFrontierBlacklistStatus(
  history: FrontierHistory,
  query: FrontierBlacklistQuery,
  policyOverrides: Partial<FrontierBlacklistPolicy> = {},
): FrontierBlacklistStatus {
  const policy = resolveBlacklistPolicy(policyOverrides);
  let status: FrontierBlacklistStatus = 'available';
  for (const entry of history.entries) {
    if (!locationsMatch(entry.world, query.world, policy.radiusMeters)) continue;
    // A small scan update while the robot is backing out must not immediately
    // re-enable the same narrow dead end. Map growth may release a location only
    // after the mandatory cooldown has elapsed.
    if (query.nowMs < entry.blockedUntilMs) {
      status = 'cooldown';
      continue;
    }
    if (hasSufficientMapGrowth(entry, query, policy)) continue;
    if (entry.attempts >= policy.maxAttempts) return 'max-attempts';
  }
  return status;
}

export function recordFrontierAttempt(
  history: FrontierHistory,
  record: FrontierAttemptRecord,
  policyOverrides: Partial<FrontierBlacklistPolicy> = {},
): FrontierHistory {
  const policy = resolveBlacklistPolicy(policyOverrides);
  let matching: FrontierHistoryEntry | undefined;
  const retained = history.entries.filter((entry) => {
    if (!locationsMatch(entry.world, record.world, policy.radiusMeters)) return true;
    if (!hasSufficientMapGrowth(entry, record, policy)
      && (!matching || entry.lastAttemptAtMs >= matching.lastAttemptAtMs)) matching = entry;
    return false;
  });
  const entry: FrontierHistoryEntry = {
    candidateId: record.candidateId,
    world: { ...record.world },
    generation: record.generation,
    knownCellCount: record.knownCellCount,
    attempts: (matching?.attempts ?? 0) + 1,
    lastOutcome: record.outcome,
    lastAttemptAtMs: record.nowMs,
    blockedUntilMs: record.nowMs + policy.cooldownMs,
  };
  return { entries: [...retained, entry].slice(-policy.maxEntries) };
}

export function analyzeFrontiers(input: FrontierAnalysisInput): FrontierAnalysis {
  const { grid } = input;
  validateGrid(grid);
  const options = resolveOptions(input.options);
  const detection = detectFrontierCells(grid, options.freeOccupancyMax);
  const clusters = clusterFrontierCells(grid, detection.frontierMask, options.freeOccupancyMax);
  const freeMask = createFreeMask(grid, options.freeOccupancyMax).mask;
  const clearanceMeters = computeClearanceMeters(grid, options.freeOccupancyMax);
  const requiredClearanceMeters = Math.hypot(
    options.robotFootprint.lengthMeters / 2,
    options.robotFootprint.widthMeters / 2,
  ) + options.safetyMarginMeters;
  const safeCellMask = new Uint8Array(grid.data.length);
  for (let index = 0; index < safeCellMask.length; index += 1) {
    if (freeMask[index] !== 0 && clearanceMeters[index] + Number.EPSILON >= requiredClearanceMeters) safeCellMask[index] = 1;
  }

  const robotCell = worldToGridCell(grid, input.robotWorld);
  const robotCellKind = robotCell ? classifyFrontierCell(grid, robotCell.x, robotCell.y, options.freeOccupancyMax) : 'out-of-bounds';
  const paths = computePathDistances(grid, robotCellKind === 'free' ? robotCell : null, freeMask, safeCellMask);
  const candidates: FrontierCandidate[] = [];
  const rejected: FrontierRejection[] = [];
  let omittedRejectionCount = 0;
  const blacklistStatusCounts = { cooldown: 0, 'max-attempts': 0 };
  const searchScratch: GoalSearchScratch = {
    visited: new Uint32Array(grid.data.length),
    depth: new Int32Array(grid.data.length),
    queue: new Int32Array(grid.data.length),
    stamp: 0,
  };
  const generation = input.generation ?? 0;
  const nowMs = input.nowMs ?? 0;

  for (const cluster of clusters) {
    if (cluster.cellCount < options.minClusterCells) {
      omittedRejectionCount += appendBoundedRejection(rejected, {
        clusterId: cluster.id,
        clusterCellIndices: cluster.cellIndices,
        reason: 'noise',
        candidate: null,
      }, options.maxRejectedClusters);
      continue;
    }
    const goal = findClusterGoal(grid, cluster, freeMask, safeCellMask, clearanceMeters, paths.distances, options, searchScratch);
    if (!goal.candidate) {
      omittedRejectionCount += appendBoundedRejection(rejected, {
        clusterId: cluster.id,
        clusterCellIndices: cluster.cellIndices,
        reason: goal.safeCellSeen ? 'unreachable' : 'no-safe-free-goal',
        candidate: null,
      }, options.maxRejectedClusters);
      continue;
    }
    if (goal.candidate.metrics.pathDistanceMeters + Number.EPSILON < options.minGoalPathDistanceMeters) {
      omittedRejectionCount += appendBoundedRejection(rejected, {
        clusterId: cluster.id,
        clusterCellIndices: cluster.cellIndices,
        reason: 'too-close',
        candidate: goal.candidate,
      }, options.maxRejectedClusters);
      continue;
    }
    const blacklistStatus = input.history ? getFrontierBlacklistStatus(input.history, {
      world: goal.candidate.world,
      generation,
      knownCellCount: detection.knownCellCount,
      nowMs,
    }, input.blacklistPolicy) : 'available';
    if (blacklistStatus !== 'available') {
      blacklistStatusCounts[blacklistStatus] += 1;
      omittedRejectionCount += appendBoundedRejection(rejected, {
        clusterId: cluster.id,
        clusterCellIndices: cluster.cellIndices,
        reason: 'blacklisted',
        candidate: goal.candidate,
        blacklistStatus,
      }, options.maxRejectedClusters);
      continue;
    }
    const displaced = insertBoundedCandidate(candidates, goal.candidate, options.maxCandidates);
    if (displaced) {
      omittedRejectionCount += appendBoundedRejection(rejected, {
        clusterId: displaced.clusterId,
        clusterCellIndices: displaced.clusterCellIndices,
        reason: 'candidate-limit',
        candidate: displaced,
      }, options.maxRejectedClusters);
    }
  }

  let selectionReason: FrontierSelectionReason;
  if (candidates.length > 0) selectionReason = 'open-clearance-priority';
  else if (detection.cellIndices.length === 0) selectionReason = 'no-frontiers';
  else if (!robotCell) selectionReason = 'robot-out-of-bounds';
  else if (robotCellKind !== 'free') selectionReason = 'robot-not-free';
  else selectionReason = 'no-eligible-candidates';

  return {
    frontierMask: detection.frontierMask,
    frontierCellIndices: detection.cellIndices,
    safeCellMask,
    clearanceMeters,
    pathDistanceMeters: paths.distances,
    clusters,
    candidates,
    selected: candidates[0] ?? null,
    selectionReason,
    rejected,
    omittedRejectionCount,
    blacklistStatusCounts,
    knownCellCount: detection.knownCellCount,
    freeCellCount: detection.freeCellCount,
    reachableCellCount: paths.reachableCellCount,
    requiredClearanceMeters,
  };
}
