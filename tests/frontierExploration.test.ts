import { describe, expect, it } from 'vitest';
import {
  analyzeFrontiers,
  cellCenterToWorld,
  classifyFrontierCell,
  clusterFrontierCells,
  compareFrontierCandidates,
  compareFrontierCandidatesByClearance,
  computeClearanceMeters,
  createExplorationGoalVisitHistory,
  createMapCornerGoalCandidates,
  createObjectSearchRoamingGoalCandidates,
  createFrontierHistory,
  DEFAULT_FRONTIER_OPTIONS,
  detectFrontierCells,
  EXPLORATION_MIN_GOAL_PATH_DISTANCE_METERS,
  EXPLORATION_LOCAL_GOAL_HORIZON_METERS,
  EXPLORATION_OPEN_CANDIDATE_SEPARATION_METERS,
  EXPLORATION_OPEN_CLEARANCE_BAND_RATIO,
  EXPLORATION_OPEN_TARGET_CANDIDATE_COUNT,
  EXPLORATION_PREFERRED_GOAL_CLEARANCE_METERS,
  EXPLORATION_REQUIRED_CLEARANCE_METERS,
  EXPLORATION_VISITED_GOAL_RADIUS_METERS,
  filterUnvisitedGoalCandidates,
  getFrontierBlacklistStatus,
  isFrontierBlacklisted,
  planFrontierGoalSelection,
  prioritizeOpenFrontierCandidates,
  recordExplorationGoalVisit,
  recordFrontierAttempt,
  scoreFrontierCandidate,
  selectFarthestFrontierCandidate,
  selectNextCornerSweepCandidate,
  selectObjectSearchRoamingCandidate,
  selectProgressiveFrontierCandidate,
  type FrontierCandidate,
  type FrontierGrid,
} from '../src/frontierExploration';
import { DEFAULT_SAFETY_CONFIG } from '../src/safetyLogic';

function makeGrid(rows: readonly string[], resolution = 1, origin?: FrontierGrid['origin']): FrontierGrid {
  const width = rows[0]?.length ?? 0;
  if (rows.some((row) => row.length !== width)) throw new Error('fixture rows must have one width');
  const data = new Int8Array(width * rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x += 1) {
      const value = row[x];
      data[y * width + x] = value === '?' ? -1 : value === '#' ? 100 : 0;
    }
  });
  return { width, height: rows.length, resolution, origin, data };
}

const smallRobot = {
  robotFootprint: { lengthMeters: .2, widthMeters: .2 },
  safetyMarginMeters: 0,
  minClusterCells: 1,
  minGoalPathDistanceMeters: 0,
} as const;

function candidate(index: number, overrides: Partial<FrontierCandidate['metrics']> = {}): FrontierCandidate {
  const metrics = { informationGain: 4, pathDistanceMeters: 2, clearanceMeters: 1, score: 4, ...overrides };
  return {
    id: `candidate-${index}`,
    clusterId: `frontier-${index}`,
    clusterCellIndices: Int32Array.of(index),
    cell: { index, x: index, y: 0 },
    world: { x: index + .5, y: .5, yaw: 0 },
    metrics,
  };
}

function cornerCandidate(cornerIndex: number, x: number, y: number): FrontierCandidate {
  return {
    ...candidate(cornerIndex + 100, { clearanceMeters: .5 }),
    id: `corner-${cornerIndex}`,
    clusterId: `corner-sweep-${cornerIndex}`,
    world: { x, y, yaw: 0 },
  };
}

describe('frontier extraction and clustering', () => {
  it('defines a frontier as known free with an in-bounds unknown 8-neighbour', () => {
    const grid = makeGrid([
      '?..',
      '...',
      '...',
    ]);
    const detection = detectFrontierCells(grid);

    expect([...detection.cellIndices]).toEqual([1, 3, 4]);
    expect(classifyFrontierCell(grid, 0, 0)).toBe('unknown');
    expect(detection.frontierMask[0]).toBe(0);
    // A map edge by itself is not implicit unknown space.
    expect(detection.frontierMask[8]).toBe(0);
  });

  it('uses deterministic 8-connected clusters and rejects a small noise cluster', () => {
    const grid = makeGrid([
      '?.........',
      '..........',
      '..........',
      '.......??.',
      '.......??.',
      '..........',
    ]);
    const detection = detectFrontierCells(grid);
    const clusters = clusterFrontierCells(grid, detection.frontierMask);
    expect(clusters.map((cluster) => cluster.cellCount)).toEqual([3, 12]);
    expect([...clusters[0].cellIndices]).toEqual([...clusters[0].cellIndices].sort((left, right) => left - right));

    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 4, y: 2 }),
      options: { ...smallRobot, minClusterCells: 4 },
    });
    expect(result.rejected.some((rejection) => rejection.clusterId === clusters[0].id && rejection.reason === 'noise')).toBe(true);
    expect(result.candidates.every((entry) => entry.clusterId !== clusters[0].id)).toBe(true);
  });
});

describe('safe reachable goal selection', () => {
  it('excludes occupied, unknown, out-of-bounds, and insufficient-clearance cells', () => {
    const grid = makeGrid([
      '....#...?',
      '........?',
      '........?',
      '........?',
      '........?',
      '........?',
      '........?',
    ]);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 2, y: 3 }),
      options: {
        minClusterCells: 2,
        robotFootprint: { lengthMeters: 2, widthMeters: 2 },
        safetyMarginMeters: 0,
        maxGoalSearchDistanceMeters: 4,
      },
    });

    expect(classifyFrontierCell(grid, -1, 3)).toBe('out-of-bounds');
    expect(classifyFrontierCell(grid, 4, 0)).toBe('occupied');
    expect(classifyFrontierCell(grid, 8, 3)).toBe('unknown');
    expect(result.safeCellMask[4]).toBe(0);
    expect(result.safeCellMask[3 * grid.width + 8]).toBe(0);
    expect(result.selected).not.toBeNull();
    expect(classifyFrontierCell(grid, result.selected!.cell.x, result.selected!.cell.y)).toBe('free');
    expect(result.selected!.metrics.clearanceMeters).toBeGreaterThanOrEqual(result.requiredClearanceMeters);
    expect(result.selected!.cell.x).toBeLessThan(7);
  });

  it('computes conservative clearance from unsafe cells and the map boundary', () => {
    const grid = makeGrid([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ]);
    const clearance = computeClearanceMeters(grid);
    expect(clearance[0]).toBeCloseTo(.5);
    expect(clearance[2 * grid.width + 2]).toBe(0);
    expect(clearance[2 * grid.width + 3]).toBeCloseTo(1 - Math.SQRT2 / 2);
  });

  it('keeps default exploration paths outside the physical footprint and hard stop distance', () => {
    const footprintRadius = Math.hypot(
      DEFAULT_FRONTIER_OPTIONS.robotFootprint.lengthMeters / 2,
      DEFAULT_FRONTIER_OPTIONS.robotFootprint.widthMeters / 2,
    );
    expect(footprintRadius + DEFAULT_FRONTIER_OPTIONS.safetyMarginMeters).toBeCloseTo(EXPLORATION_REQUIRED_CLEARANCE_METERS);
    expect(EXPLORATION_REQUIRED_CLEARANCE_METERS).toBeGreaterThanOrEqual(DEFAULT_SAFETY_CONFIG.stopDistance);
    expect(EXPLORATION_REQUIRED_CLEARANCE_METERS).toBeLessThan(DEFAULT_SAFETY_CONFIG.resumeDistance);
    expect(DEFAULT_FRONTIER_OPTIONS.minGoalPathDistanceMeters).toBe(EXPLORATION_MIN_GOAL_PATH_DISTANCE_METERS);
    expect(EXPLORATION_MIN_GOAL_PATH_DISTANCE_METERS).toBeGreaterThan(.28);
  });

  it('rejects a no-op nearby frontier and selects a farther reachable cluster', () => {
    const grid = makeGrid([
      '...............',
      '...............',
      '...............',
      '....?......?...',
      '...............',
      '...............',
      '...............',
    ]);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 2, y: 3 }),
      options: { ...smallRobot, minGoalPathDistanceMeters: 3 },
    });

    expect(result.rejected.some((rejection) => rejection.reason === 'too-close'
      && rejection.candidate !== null
      && rejection.candidate.metrics.pathDistanceMeters < 3)).toBe(true);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.metrics.pathDistanceMeters).toBeGreaterThanOrEqual(3);
  });

  it('routes through known-free clearance that fits the robot but was blocked by the old 0.80 m margin', () => {
    const grid = makeGrid([
      '###################',
      '#.......#?????????#',
      '#.......#........?#',
      '#................?#',
      '#................?#',
      '#................?#',
      '#.......#........?#',
      '#.......#?????????#',
      '###################',
    ], .5);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 4, y: 4 }),
    });

    expect(result.requiredClearanceMeters).toBeCloseTo(EXPLORATION_REQUIRED_CLEARANCE_METERS);
    expect(result.safeCellMask[3 * grid.width + 8]).toBe(0);
    expect(result.safeCellMask[4 * grid.width + 8]).toBe(1);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('uses separated safe goals when the robot starts in a narrow known-free pocket', () => {
    const grid = makeGrid([
      '........?',
      '........?',
      '..#.....?',
      '........?',
      '........?',
    ]);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 3, y: 2 }),
      options: {
        minClusterCells: 2,
        robotFootprint: { lengthMeters: 1, widthMeters: 1 },
        safetyMarginMeters: 0,
      },
    });

    expect(result.safeCellMask[2 * grid.width + 1]).toBe(0);
    expect(result.reachableCellCount).toBeGreaterThan(0);
    expect(result.selected).not.toBeNull();
    expect(result.selectionReason).toBe('open-clearance-priority');
    expect(result.selected!.metrics.clearanceMeters).toBeGreaterThanOrEqual(result.requiredClearanceMeters);
  });

  it('does not route through a long clearance-violating corridor from an unsafe start', () => {
    const grid = makeGrid([
      '........?',
      '........?',
      '..#.....?',
      '........?',
      '........?',
    ]);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 1, y: 2 }),
      options: {
        minClusterCells: 2,
        robotFootprint: { lengthMeters: 1, widthMeters: 1 },
        safetyMarginMeters: 0,
      },
    });

    expect(result.safeCellMask[2 * grid.width + 1]).toBe(0);
    expect(result.reachableCellCount).toBe(3);
    expect(result.selected).toBeNull();
    expect(result.pathDistanceMeters[2 * grid.width + 5]).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects a frontier whose safe free-side goal is unreachable through known free cells', () => {
    const grid = makeGrid([
      '....#....?.',
      '....#....?.',
      '....#....?.',
      '....#....?.',
      '....#....?.',
      '....#....?.',
      '....#....?.',
    ]);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 1, y: 3 }),
      options: smallRobot,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.rejected.some((rejection) => rejection.reason === 'unreachable')).toBe(true);
    expect(result.pathDistanceMeters[3 * grid.width + 8]).toBe(Number.POSITIVE_INFINITY);
  });

  it('faces the selected open-space goal toward unknown space, including a rotated map origin', () => {
    const grid = makeGrid([
      '.......',
      '.......',
      '.......',
      '.....?.',
      '.......',
      '.......',
      '.......',
    ], 1, { x: 10, y: -3, yaw: Math.PI / 2 });
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 1, y: 3 }),
      options: smallRobot,
    });

    expect(result.selected?.cell).toMatchObject({ x: 2, y: 3 });
    expect(result.selected?.metrics.clearanceMeters).toBeGreaterThanOrEqual(EXPLORATION_PREFERRED_GOAL_CLEARANCE_METERS);
    expect(result.selected?.world.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('places each cluster goal in the widest reachable free-side cell instead of the nearest narrow cell', () => {
    const grid = makeGrid([
      '#############',
      '#..........?#',
      '#..........?#',
      '#..........?#',
      '#..........?#',
      '#..........?#',
      '#..........?#',
      '#..........?#',
      '#############',
    ], .5);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 2, y: 4 }),
      options: { minClusterCells: 1, maxGoalSearchDistanceMeters: 1.5 },
    });

    expect(result.selected).not.toBeNull();
    expect(result.selected?.cell).toMatchObject({ x: 7, y: 4 });
    expect(result.selected!.metrics.clearanceMeters).toBeGreaterThan(1.5);
  });
});

describe('deterministic ranking and bounded policies', () => {
  it('scores information gain, path distance, and clearance with explicit weights', () => {
    expect(scoreFrontierCandidate(
      { informationGain: 10, pathDistanceMeters: 4, clearanceMeters: 1 },
      { informationGain: 2, pathDistance: .5, clearance: 3 },
    )).toBe(21);
  });

  it('breaks a complete metric tie by the lower row-major goal index', () => {
    expect(compareFrontierCandidates(candidate(7), candidate(11))).toBeLessThan(0);
    expect([candidate(11), candidate(7)].sort(compareFrontierCandidates).map((entry) => entry.cell.index)).toEqual([7, 11]);
  });

  it('backfills a small wide band to four spatially distinct candidates', () => {
    const widest = candidate(1, { clearanceMeters: 1, score: -100 });
    const wide = candidate(2, { clearanceMeters: .85, score: -50 });
    const narrowHighScore = candidate(3, { clearanceMeters: .64, score: 999 });
    const relaxed = candidate(4, { clearanceMeters: .52, score: 500 });
    const priority = prioritizeOpenFrontierCandidates([relaxed, narrowHighScore, wide, widest]);

    expect(EXPLORATION_PREFERRED_GOAL_CLEARANCE_METERS).toBe(.65);
    expect(EXPLORATION_OPEN_CLEARANCE_BAND_RATIO).toBe(.8);
    expect(priority).toMatchObject({
      clearanceFloorMeters: .52,
      maximumClearanceMeters: 1,
      preferredClearanceAvailable: true,
      relaxedClearanceUsed: true,
      spatiallyDistinctCandidateCount: 4,
    });
    expect(EXPLORATION_OPEN_TARGET_CANDIDATE_COUNT).toBe(4);
    expect(EXPLORATION_OPEN_CANDIDATE_SEPARATION_METERS).toBe(1);
    expect(priority.candidates.map((entry) => entry.id)).toEqual([widest.id, wide.id, narrowHighScore.id, relaxed.id]);
    expect(compareFrontierCandidatesByClearance(widest, narrowHighScore)).toBeLessThan(0);
    expect(selectFarthestFrontierCandidate(priority.candidates, { x: 0, y: .5 })?.id).toBe(relaxed.id);
    expect(selectFarthestFrontierCandidate([], { x: 0, y: 0 })).toBeNull();
  });

  it('makes steady local progress and falls back to the nearest reachable remote candidate', () => {
    const localNear = candidate(1, { pathDistanceMeters: 1.2, clearanceMeters: .8 });
    const localFar = candidate(2, { pathDistanceMeters: 2.8, clearanceMeters: .7 });
    const diagonal = candidate(3, { pathDistanceMeters: 7, clearanceMeters: 1 });

    expect(EXPLORATION_LOCAL_GOAL_HORIZON_METERS).toBe(3);
    expect(selectProgressiveFrontierCandidate([localNear, diagonal, localFar])?.id).toBe(localFar.id);
    expect(selectProgressiveFrontierCandidate([
      candidate(4, { pathDistanceMeters: 5, clearanceMeters: .7 }),
      candidate(5, { pathDistanceMeters: 8, clearanceMeters: 1 }),
    ])?.id).toBe('candidate-4');
    expect(selectProgressiveFrontierCandidate([])).toBeNull();
    expect(() => selectProgressiveFrontierCandidate([localNear], 0)).toThrow(RangeError);
  });

  it('falls back progressively to the safest available band when no genuinely open goal exists', () => {
    const safest = candidate(1, { clearanceMeters: .55 });
    const close = candidate(2, { clearanceMeters: .52 });
    const constrained = candidate(3, { clearanceMeters: .4 });
    const priority = prioritizeOpenFrontierCandidates([constrained, close, safest]);

    expect(priority.preferredClearanceAvailable).toBe(false);
    expect(priority.clearanceFloorMeters).toBeCloseTo(.52);
    expect(priority.candidates.map((entry) => entry.id)).toEqual([safest.id, close.id]);
  });

  it('builds direct safe reachable goals nearest all four map corners without a frontier shortlist', () => {
    const grid = makeGrid(Array<string>(7).fill('.......'));
    const safeCellMask = new Uint8Array(grid.data.length);
    const clearanceMeters = new Float64Array(grid.data.length);
    const pathDistanceMeters = new Float64Array(grid.data.length);
    pathDistanceMeters.fill(Number.POSITIVE_INFINITY);
    const goalCells = [
      { x: 1, y: 1, path: 2 },
      { x: 5, y: 1, path: 6 },
      { x: 5, y: 5, path: 10 },
      { x: 1, y: 5, path: 6 },
      { x: 3, y: 3, path: 1 },
    ];
    for (const cell of goalCells) {
      const index = cell.y * grid.width + cell.x;
      safeCellMask[index] = 1;
      clearanceMeters[index] = 1;
      pathDistanceMeters[index] = cell.path;
    }

    const corners = createMapCornerGoalCandidates({
      grid,
      safeCellMask,
      clearanceMeters,
      pathDistanceMeters,
    });

    expect(corners.map((entry) => [entry.cell.x, entry.cell.y])).toEqual([[1, 1], [5, 1], [5, 5], [1, 5]]);
    expect(corners.every((entry) => safeCellMask[entry.cell.index] === 1
      && Number.isFinite(pathDistanceMeters[entry.cell.index]))).toBe(true);
  });

  it('suppresses regenerated goals near a successfully observed location by world-space radius', () => {
    const reached = candidate(1);
    const regeneratedNear = { ...candidate(99), world: { x: reached.world.x + .4, y: reached.world.y + .2, yaw: 0 } };
    const genuinelyNew = { ...candidate(100), world: { x: reached.world.x + 1.4, y: reached.world.y, yaw: 0 } };
    const history = recordExplorationGoalVisit(createExplorationGoalVisitHistory(), reached);

    expect(EXPLORATION_VISITED_GOAL_RADIUS_METERS).toBe(1);
    expect(history.entries).toHaveLength(1);
    expect(filterUnvisitedGoalCandidates([regeneratedNear, genuinelyNew], history).map((entry) => entry.id))
      .toEqual([genuinelyNew.id]);
    expect(recordExplorationGoalVisit(history, regeneratedNear)).toBe(history);
  });

  it('starts at the nearest corner and then visits adjacent corners clockwise without returning diagonally', () => {
    const corners = [
      cornerCandidate(0, 0, 0),
      cornerCandidate(1, 8, 0),
      cornerCandidate(2, 8, 8),
      cornerCandidate(3, 0, 8),
    ];
    let history = createExplorationGoalVisitHistory();
    const first = selectNextCornerSweepCandidate(corners, { x: 7.5, y: 7.5 }, history);
    expect(first?.clusterId).toBe('corner-sweep-2');
    history = recordExplorationGoalVisit(history, first!);
    const second = selectNextCornerSweepCandidate(corners, { x: 8, y: 8 }, history);
    expect(second?.clusterId).toBe('corner-sweep-3');
    history = recordExplorationGoalVisit(history, second!);
    expect(selectNextCornerSweepCandidate(corners, { x: 0, y: 8 }, history)?.clusterId).toBe('corner-sweep-0');
    history = recordExplorationGoalVisit(history, corners[0]);
    expect(selectNextCornerSweepCandidate(corners, { x: 0, y: 0 }, history)?.clusterId).toBe('corner-sweep-1');
    history = recordExplorationGoalVisit(history, corners[1]);
    expect(selectNextCornerSweepCandidate(corners, { x: 8, y: 0 }, history)).toBeNull();
  });

  it('switches only after the progress tracker latches and follows the unvisited corner tour', () => {
    const frontierNear = candidate(1, { clearanceMeters: 1, pathDistanceMeters: 2.5 });
    const frontierFar = candidate(4, { clearanceMeters: .9, pathDistanceMeters: 7 });
    const cornerNear = cornerCandidate(0, 0, 0);
    const cornerFar = cornerCandidate(1, 20, 0);
    const robotWorld = { x: 0, y: .5 };

    const openPlan = planFrontierGoalSelection(
      [frontierNear, frontierFar],
      [cornerNear, cornerFar],
      robotWorld,
      false,
    );
    const cornerPlan = planFrontierGoalSelection(
      [frontierNear, frontierFar],
      [cornerNear, cornerFar],
      robotWorld,
      true,
    );

    expect(openPlan).toMatchObject({ mode: 'open-space', selected: { id: frontierNear.id } });
    expect(cornerPlan).toMatchObject({ mode: 'corner-sweep', selected: { id: cornerNear.id } });
    expect(cornerPlan.candidates.map((entry) => entry.id)).toEqual([cornerNear.id, cornerFar.id]);

    const reachedNear = recordExplorationGoalVisit(createExplorationGoalVisitHistory(), cornerNear);
    const adjacentPlan = planFrontierGoalSelection(
      [frontierNear, frontierFar],
      [cornerNear, cornerFar],
      robotWorld,
      true,
      EXPLORATION_REQUIRED_CLEARANCE_METERS,
      reachedNear,
    );
    expect(adjacentPlan).toMatchObject({ mode: 'corner-sweep', selected: { id: cornerFar.id } });
  });

  it('excludes an exact-blacklisted failed corner before selecting the next corner goal', () => {
    const failedCorner = cornerCandidate(0, 0, 0);
    const alternateCorner = cornerCandidate(1, 20, 0);

    const plan = planFrontierGoalSelection(
      [],
      [failedCorner, alternateCorner],
      { x: 0, y: .5 },
      true,
      EXPLORATION_REQUIRED_CLEARANCE_METERS,
      createExplorationGoalVisitHistory(),
      [failedCorner.id],
    );

    expect(plan).toMatchObject({ mode: 'corner-sweep', selected: { id: alternateCorner.id } });
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual([alternateCorner.id]);
  });

  it('returns to unvisited frontier goals after every currently safe corner has been visited', () => {
    const frontierVisited = candidate(1, { clearanceMeters: 1 });
    const frontierNew = candidate(5, { clearanceMeters: .9 });
    const corner = cornerCandidate(0, 0, 0);
    let history = recordExplorationGoalVisit(createExplorationGoalVisitHistory(), frontierVisited);
    history = recordExplorationGoalVisit(history, corner);

    const plan = planFrontierGoalSelection(
      [frontierVisited, frontierNew],
      [corner],
      { x: 0, y: 0 },
      true,
      EXPLORATION_REQUIRED_CLEARANCE_METERS,
      history,
    );

    expect(plan.mode).toBe('post-corner-frontier');
    expect(plan.candidates.map((entry) => entry.id)).toEqual([frontierNew.id]);
    expect(plan.selected?.id).toBe(frontierNew.id);
  });

  it('does not reuse a visited normal frontier when object-search candidates are exhausted', () => {
    const frontier = candidate(1, { clearanceMeters: 1, pathDistanceMeters: 2.5 });
    const corner = cornerCandidate(0, 0, 0);
    const history = recordExplorationGoalVisit(createExplorationGoalVisitHistory(), frontier);

    const plan = planFrontierGoalSelection(
      [frontier],
      [corner],
      { x: 0, y: .5 },
      true,
      EXPLORATION_REQUIRED_CLEARANCE_METERS,
      history,
      [],
      'object-search',
    );

    expect(plan).toMatchObject({ mode: 'object-search', selected: null });
    expect(plan.candidates).toEqual([]);
  });

  it('allows explicit roaming reuse without selecting the corner sweep', () => {
    const frontier = candidate(1, { clearanceMeters: 1, pathDistanceMeters: 2.5 });
    const corner = cornerCandidate(0, 0, 0);
    const history = recordExplorationGoalVisit(createExplorationGoalVisitHistory(), frontier);

    const plan = planFrontierGoalSelection(
      [frontier],
      [corner],
      { x: 0, y: .5 },
      true,
      EXPLORATION_REQUIRED_CLEARANCE_METERS,
      history,
      [],
      'object-search',
      true,
    );

    expect(plan).toMatchObject({ mode: 'object-search', selected: { id: frontier.id } });
    expect(plan.candidates.map((entry) => entry.id)).toEqual([frontier.id]);
  });

  it('selects a non-backtracking interior waypoint after a roaming loop is exhausted', () => {
    const previous = candidate(1, { pathDistanceMeters: 2, clearanceMeters: 1 });
    previous.world = { x: 1.5, y: .5, yaw: 0 };
    const nearPrevious = candidate(2, { pathDistanceMeters: 2, clearanceMeters: 1 });
    nearPrevious.world = { x: 2.2, y: .5, yaw: 0 };
    const far = candidate(8, { pathDistanceMeters: 2, clearanceMeters: 1 });
    far.world = { x: 5.5, y: .5, yaw: 0 };
    const history = recordExplorationGoalVisit(createExplorationGoalVisitHistory(), previous);

    expect(selectObjectSearchRoamingCandidate(
      [nearPrevious, far],
      previous.world,
      history,
    )?.id).toBe(far.id);
  });

  it('creates bounded safe interior roaming goals for object search after frontiers are exhausted', () => {
    const width = 9;
    const height = 9;
    const grid = makeGrid(Array<string>(height).fill('.'.repeat(width)), .5);
    const safeCellMask = new Uint8Array(grid.data.length);
    safeCellMask.fill(1);
    const clearanceMeters = new Float64Array(grid.data.length);
    clearanceMeters.fill(1);
    const pathDistanceMeters = new Float64Array(grid.data.length);
    pathDistanceMeters.fill(1);

    const candidates = createObjectSearchRoamingGoalCandidates({
      grid,
      safeCellMask,
      clearanceMeters,
      pathDistanceMeters,
      robotWorld: cellCenterToWorld(grid, { x: 4, y: 4 }),
      requiredClearanceMeters: EXPLORATION_REQUIRED_CLEARANCE_METERS,
      maxCandidates: 9,
    });

    expect(candidates).toHaveLength(9);
    expect(new Set(candidates.map((entry) => entry.cell.index)).size).toBe(candidates.length);
    expect(candidates.every((entry) => entry.cell.x > 0
      && entry.cell.x < grid.width - 1
      && entry.cell.y > 0
      && entry.cell.y < grid.height - 1)).toBe(true);
    expect(candidates.every((entry) => entry.clusterId.startsWith('object-search-roaming-'))).toBe(true);
    expect(candidates.some((entry) => entry.clusterId.includes('corner-sweep'))).toBe(false);
  });

  it('bounds selected candidates and reports candidates displaced by the limit', () => {
    const grid = makeGrid([
      '....................',
      '....................',
      '....................',
      '....?.....?.....?...',
      '....................',
      '....................',
      '....................',
    ]);
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 1, y: 3 }),
      options: { ...smallRobot, maxCandidates: 2 },
    });

    expect(result.clusters).toHaveLength(3);
    expect(result.candidates).toHaveLength(2);
    expect(result.rejected.some((rejection) => rejection.reason === 'candidate-limit')).toBe(true);
  });

  it('bounds failure history and combines radius, cooldown, attempts, generation, and map growth', () => {
    const policy = { radiusMeters: 1, cooldownMs: 100, maxAttempts: 2, maxEntries: 2, minKnownCellGrowth: 5 };
    let history = createFrontierHistory();
    history = recordFrontierAttempt(history, {
      candidateId: 'a', world: { x: 1, y: 1 }, generation: 1, knownCellCount: 10, nowMs: 0, outcome: 'failed',
    }, policy);
    expect(isFrontierBlacklisted(history, { world: { x: 1.5, y: 1 }, generation: 1, knownCellCount: 10, nowMs: 99 }, policy)).toBe(true);
    expect(isFrontierBlacklisted(history, { world: { x: 1.5, y: 1 }, generation: 1, knownCellCount: 10, nowMs: 100 }, policy)).toBe(false);

    history = recordFrontierAttempt(history, {
      candidateId: 'a-retry', world: { x: 1.25, y: 1 }, generation: 1, knownCellCount: 10, nowMs: 120, outcome: 'canceled',
    }, policy);
    expect(history.entries[0].attempts).toBe(2);
    expect(isFrontierBlacklisted(history, { world: { x: 1, y: 1 }, generation: 1, knownCellCount: 10, nowMs: 1_000 }, policy)).toBe(true);
    expect(isFrontierBlacklisted(history, { world: { x: 1, y: 1 }, generation: 2, knownCellCount: 14, nowMs: 1_000 }, policy)).toBe(true);
    expect(isFrontierBlacklisted(history, { world: { x: 1, y: 1 }, generation: 2, knownCellCount: 15, nowMs: 1_000 }, policy)).toBe(false);

    history = recordFrontierAttempt(history, {
      candidateId: 'b', world: { x: 10, y: 0 }, generation: 2, knownCellCount: 15, nowMs: 200, outcome: 'failed',
    }, policy);
    history = recordFrontierAttempt(history, {
      candidateId: 'c', world: { x: 20, y: 0 }, generation: 2, knownCellCount: 15, nowMs: 300, outcome: 'failed',
    }, policy);
    expect(history.entries).toHaveLength(2);
    expect(history.entries.map((entry) => entry.candidateId)).toEqual(['b', 'c']);
  });

  it('filters a cooling-down frontier out of analysis by its world-space blacklist radius', () => {
    const grid = makeGrid([
      '.......',
      '.......',
      '.......',
      '.....?.',
      '.......',
      '.......',
      '.......',
    ]);
    const initial = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 1, y: 3 }),
      generation: 1,
      options: smallRobot,
    });
    expect(initial.selected).not.toBeNull();
    const policy = { radiusMeters: 1, cooldownMs: 100, maxAttempts: 2, maxEntries: 4, minKnownCellGrowth: 5 };
    const history = recordFrontierAttempt(createFrontierHistory(), {
      candidateId: initial.selected!.id,
      world: initial.selected!.world,
      generation: 1,
      knownCellCount: initial.knownCellCount,
      nowMs: 0,
      outcome: 'failed',
    }, policy);
    const coolingDown = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 1, y: 3 }),
      generation: 1,
      nowMs: 50,
      history,
      blacklistPolicy: policy,
      options: smallRobot,
    });

    expect(coolingDown.selected).toBeNull();
    expect(coolingDown.rejected.some((rejection) => rejection.reason === 'blacklisted' && rejection.blacklistStatus === 'cooldown')).toBe(true);
    expect(coolingDown.blacklistStatusCounts).toEqual({ cooldown: 1, 'max-attempts': 0 });

    const cappedRejections = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 1, y: 3 }),
      generation: 1,
      nowMs: 50,
      history,
      blacklistPolicy: policy,
      options: { ...smallRobot, maxRejectedClusters: 0 },
    });
    expect(cappedRejections.rejected).toHaveLength(0);
    expect(cappedRejections.omittedRejectionCount).toBeGreaterThan(0);
    expect(cappedRejections.blacklistStatusCounts).toEqual({ cooldown: 1, 'max-attempts': 0 });
  });

  it('does not select the failed goal again when another normal frontier is available', () => {
    const grid = makeGrid([
      '.............',
      '.............',
      '.............',
      '...?...?...?.',
      '.............',
      '.............',
      '.............',
    ]);
    const robotWorld = cellCenterToWorld(grid, { x: 1, y: 3 });
    const policy = { radiusMeters: 1, cooldownMs: 1_000, maxAttempts: 2, maxEntries: 8, minKnownCellGrowth: 5 };
    const initial = analyzeFrontiers({
      grid,
      robotWorld,
      generation: 1,
      nowMs: 0,
      options: { ...smallRobot, maxCandidates: 8 },
      blacklistPolicy: policy,
    });
    expect(initial.selected).not.toBeNull();
    expect(initial.candidates.length).toBeGreaterThan(1);

    const failedGoal = initial.selected!;
    const history = recordFrontierAttempt(createFrontierHistory(), {
      candidateId: failedGoal.id,
      world: failedGoal.world,
      generation: 1,
      knownCellCount: initial.knownCellCount,
      nowMs: 0,
      outcome: 'failed',
    }, policy);
    const recovered = analyzeFrontiers({
      grid,
      robotWorld,
      generation: 1,
      nowMs: 50,
      history,
      options: { ...smallRobot, maxCandidates: 8 },
      blacklistPolicy: policy,
    });

    expect(recovered.selected).not.toBeNull();
    expect(recovered.selected?.id).not.toBe(failedGoal.id);
    expect(Math.hypot(
      recovered.selected!.world.x - failedGoal.world.x,
      recovered.selected!.world.y - failedGoal.world.y,
    )).toBeGreaterThanOrEqual(policy.radiusMeters);
  });

  it('separates temporary cooldown from max-attempt exhaustion and releases both after map growth', () => {
    const grid = makeGrid([
      '.......',
      '.......',
      '.......',
      '.....?.',
      '.......',
      '.......',
      '.......',
    ]);
    const robotWorld = cellCenterToWorld(grid, { x: 1, y: 3 });
    const initial = analyzeFrontiers({ grid, robotWorld, generation: 1, options: smallRobot });
    const selected = initial.selected!;
    const policy = { radiusMeters: 1, cooldownMs: 100, maxAttempts: 2, maxEntries: 4, minKnownCellGrowth: 5 };
    let history = recordFrontierAttempt(createFrontierHistory(), {
      candidateId: selected.id,
      world: selected.world,
      generation: 1,
      knownCellCount: initial.knownCellCount,
      nowMs: 0,
      outcome: 'failed',
    }, policy);
    expect(getFrontierBlacklistStatus(history, {
      world: selected.world, generation: 1, knownCellCount: initial.knownCellCount, nowMs: 50,
    }, policy)).toBe('cooldown');
    expect(getFrontierBlacklistStatus(history, {
      world: selected.world,
      generation: 2,
      knownCellCount: initial.knownCellCount + policy.minKnownCellGrowth,
      nowMs: 50,
    }, policy)).toBe('cooldown');

    history = recordFrontierAttempt(history, {
      candidateId: selected.id,
      world: selected.world,
      generation: 1,
      knownCellCount: initial.knownCellCount,
      nowMs: 100,
      outcome: 'failed',
    }, policy);
    const exhausted = analyzeFrontiers({
      grid,
      robotWorld,
      generation: 1,
      nowMs: 1_000,
      history,
      blacklistPolicy: policy,
      options: smallRobot,
    });
    expect(exhausted.selected).toBeNull();
    expect(exhausted.rejected.some((rejection) => rejection.reason === 'blacklisted' && rejection.blacklistStatus === 'max-attempts')).toBe(true);
    expect(exhausted.blacklistStatusCounts).toEqual({ cooldown: 0, 'max-attempts': 1 });

    expect(getFrontierBlacklistStatus(history, {
      world: selected.world,
      generation: 2,
      knownCellCount: initial.knownCellCount + policy.minKnownCellGrowth,
      nowMs: 1_000,
    }, policy)).toBe('available');
  });

  it('keeps a 400×400 OccupancyGrid analysis and all exposed collections bounded', () => {
    const width = 400;
    const height = 400;
    const data = new Int8Array(width * height);
    data.fill(-1);
    for (let y = 40; y < 360; y += 1) {
      for (let x = 40; x < 360; x += 1) data[y * width + x] = 0;
    }
    const grid: FrontierGrid = { width, height, resolution: .05, data };
    const result = analyzeFrontiers({
      grid,
      robotWorld: cellCenterToWorld(grid, { x: 200, y: 200 }),
      options: { maxCandidates: 8, maxRejectedClusters: 16 },
    });

    expect(result.frontierMask).toBeInstanceOf(Uint8Array);
    expect(result.frontierMask).toHaveLength(width * height);
    expect(result.pathDistanceMeters).toBeInstanceOf(Float64Array);
    expect(result.pathDistanceMeters).toHaveLength(width * height);
    expect(result.candidates.length).toBeLessThanOrEqual(8);
    expect(result.rejected.length).toBeLessThanOrEqual(16);
    expect(result.selected).not.toBeNull();
  });
});
