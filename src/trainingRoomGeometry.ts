export interface TrainingRoomPart {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  kind: 'post' | 'sign';
}

export const GATE_PARTS: readonly TrainingRoomPart[] = [
  { x: -2.8, y: 0.575, z: 1.15, width: 0.12, height: 1.15, depth: 0.12, kind: 'post' },
  { x: -1.95, y: 0.575, z: 1.15, width: 0.12, height: 1.15, depth: 0.12, kind: 'post' },
  { x: -2.38, y: 1.1, z: 1.15, width: 0.95, height: 0.15, depth: 0.08, kind: 'sign' },
] as const;

export function partContainsHeight(part: TrainingRoomPart, height: number): boolean {
  return height >= part.y - part.height / 2 && height <= part.y + part.height / 2;
}
