/**
 * Pure pitch-geometry helpers shared by the AI and the match controller.
 * See core/types.ts for the coordinate convention (centre origin, +x toward AWAY goal).
 */
import type { PitchDims, Vec2 } from '@/core/types';
import { TeamSide } from '@/core/types';
import { clamp } from './math';

/** Direction along x that a side attacks: HOME → +1 (attacks +x), AWAY → -1. */
export function attackDir(side: TeamSide): 1 | -1 {
  return side === TeamSide.HOME ? 1 : -1;
}

/**
 * Resolve a normalised formation slot to world space.
 * `norm.x` is depth (0 = own goal line, 1 = opponent goal line) and `norm.y` is width
 * (0..1 across the pitch). The whole formation is point-reflected for the AWAY side so a
 * single HOME-perspective definition serves both teams.
 */
export function baseAnchor(norm: Vec2, dir: 1 | -1, pitch: PitchDims): Vec2 {
  return {
    x: dir * (norm.x - 0.5) * pitch.length,
    y: dir * (norm.y - 0.5) * pitch.width,
  };
}

/** Centre of the goal a side defends. */
export function ownGoalCenter(side: TeamSide, pitch: PitchDims): Vec2 {
  return { x: -attackDir(side) * pitch.halfLength, y: 0 };
}

/** Centre of the goal a side attacks. */
export function oppGoalCenter(side: TeamSide, pitch: PitchDims): Vec2 {
  return { x: attackDir(side) * pitch.halfLength, y: 0 };
}

/** The x of the goal line a side defends. */
export function ownGoalLineX(side: TeamSide, pitch: PitchDims): number {
  return -attackDir(side) * pitch.halfLength;
}

/** The x of the goal line a side attacks. */
export function oppGoalLineX(side: TeamSide, pitch: PitchDims): number {
  return attackDir(side) * pitch.halfLength;
}

/** Is point `p` inside the penalty box that `side` DEFENDS? */
export function isInDefensiveBox(p: Vec2, side: TeamSide, pitch: PitchDims): boolean {
  const dir = attackDir(side);
  const lineX = -dir * pitch.halfLength;
  const innerX = lineX + dir * pitch.penaltyBoxDepth;
  const minX = Math.min(lineX, innerX);
  const maxX = Math.max(lineX, innerX);
  return (
    p.x >= minX &&
    p.x <= maxX &&
    Math.abs(p.y) <= pitch.penaltyBoxWidth / 2
  );
}

/** Is point `p` inside the penalty box that `side` ATTACKS? */
export function isInAttackingBox(p: Vec2, side: TeamSide, pitch: PitchDims): boolean {
  const opp = side === TeamSide.HOME ? TeamSide.AWAY : TeamSide.HOME;
  return isInDefensiveBox(p, opp, pitch);
}

/** The penalty spot a side shoots toward (for penalties awarded TO `side`). */
export function attackingPenaltySpot(side: TeamSide, pitch: PitchDims): Vec2 {
  const dir = attackDir(side);
  return { x: dir * (pitch.halfLength - pitch.penaltySpotDist), y: 0 };
}

/** Clamp a position to the playable area plus an optional margin. */
export function clampToPitch(p: Vec2, pitch: PitchDims, margin = 0): Vec2 {
  return {
    x: clamp(p.x, -pitch.halfLength - margin, pitch.halfLength + margin),
    y: clamp(p.y, -pitch.halfWidth - margin, pitch.halfWidth + margin),
  };
}

/** Is the ball position within the goal mouth width (used for goal detection)? */
export function withinGoalMouth(y: number, pitch: PitchDims): boolean {
  return Math.abs(y) <= pitch.goalWidth / 2;
}
