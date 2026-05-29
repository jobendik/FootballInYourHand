/**
 * The single source of truth for world ↔ screen mapping and orientation.
 *
 * Orientation (faithful to portrait mobile football): the pitch LENGTH runs up the screen.
 * The user's team attacks toward the TOP. Therefore:
 *   - world +x (toward the opponent goal for HOME) maps to screen UP
 *   - world +y maps to screen RIGHT
 *
 * Both the renderer (drawing) and the input system (translating the joystick) import from
 * here so they can never disagree about which way is "forward".
 */
import type { Camera, PitchDims, Vec2 } from './types';
import { PITCH_MARGIN } from './constants';
import { clamp } from '@/utils/math';

/** Minimum world-units of pitch length kept visible along the screen's height. */
export const MIN_VISIBLE_LENGTH = 560;

export interface ViewTransform {
  cx: number; // screen-space centre x (px)
  cy: number; // screen-space centre y (px)
  scale: number; // px per world unit
  camX: number; // camera centre in world space
  camY: number;
}

/**
 * Pixels-per-world-unit. Fits the full pitch WIDTH across the screen width while keeping at
 * least MIN_VISIBLE_LENGTH of length on screen, so it looks right in both portrait and
 * landscape.
 */
export function computeScale(viewW: number, viewH: number, pitch: PitchDims): number {
  const fitWidth = viewW / (pitch.width + 2 * PITCH_MARGIN);
  const fitLength = viewH / MIN_VISIBLE_LENGTH;
  return Math.min(fitWidth, fitLength);
}

export function makeTransform(viewW: number, viewH: number, camera: Camera, scale: number): ViewTransform {
  return {
    cx: viewW / 2,
    cy: viewH / 2,
    scale,
    camX: camera.position.x + camera.offset.x,
    camY: camera.position.y + camera.offset.y,
  };
}

/** World position → screen pixels. */
export function worldToScreen(t: ViewTransform, wx: number, wy: number): Vec2 {
  return {
    x: t.cx + (wy - t.camY) * t.scale,
    y: t.cy - (wx - t.camX) * t.scale,
  };
}

/** Screen pixels → world position. */
export function screenToWorld(t: ViewTransform, sx: number, sy: number): Vec2 {
  return {
    x: t.camX - (sy - t.cy) / t.scale,
    y: t.camY + (sx - t.cx) / t.scale,
  };
}

/**
 * Rotate a screen-space direction (x right, y down) into world space.
 * screen UP → world +x; screen RIGHT → world +y. Magnitude is preserved.
 */
export function screenDirToWorld(sdx: number, sdy: number): Vec2 {
  return { x: -sdy, y: sdx };
}

/** Rotate a world-space direction into a screen-space direction (x right, y down). */
export function worldDirToScreen(wx: number, wy: number): Vec2 {
  return { x: wy, y: -wx };
}

/**
 * Clamp the camera centre so the view never drifts too far beyond the pitch ends.
 * Returns the clamped world centre.
 */
export function clampCameraCenter(center: Vec2, viewW: number, viewH: number, scale: number, pitch: PitchDims): Vec2 {
  const halfViewWorldX = viewH / 2 / scale; // along length (screen vertical)
  const halfViewWorldY = viewW / 2 / scale; // along width (screen horizontal)
  const slackX = pitch.goalDepth + 60;
  const slackY = PITCH_MARGIN;
  const maxX = Math.max(0, pitch.halfLength + slackX - halfViewWorldX);
  const maxY = Math.max(0, pitch.halfWidth + slackY - halfViewWorldY);
  return {
    x: clamp(center.x, -maxX, maxX),
    y: clamp(center.y, -maxY, maxY),
  };
}
