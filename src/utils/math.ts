/**
 * Vector & scalar maths used across every gameplay system.
 *
 * Vectors are plain `{ x, y }` objects (see `Vec2` in core/types) so they can live
 * inside the data-oriented `GameWorld` and serialise trivially. The helpers here are
 * mostly pure and return new objects; the `*Mut` variants mutate in place to avoid
 * allocations inside the hot physics loop.
 */
import type { Vec2 } from '@/core/types';

export const TAU = Math.PI * 2;

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function clone(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function lengthSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Returns a unit vector; the zero vector is returned unchanged. */
export function normalize(a: Vec2): Vec2 {
  const len = Math.hypot(a.x, a.y);
  if (len < 1e-6) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

/** Add `b * s` into `a`, mutating `a`. Hot-path friendly. */
export function addScaledMut(a: Vec2, b: Vec2, s: number): Vec2 {
  a.x += b.x * s;
  a.y += b.y * s;
  return a;
}

export function setMut(a: Vec2, x: number, y: number): Vec2 {
  a.x = x;
  a.y = y;
  return a;
}

export function copyMut(a: Vec2, b: Vec2): Vec2 {
  a.x = b.x;
  a.y = b.y;
  return a;
}

export function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

export function fromAngle(rad: number, len = 1): Vec2 {
  return { x: Math.cos(rad) * len, y: Math.sin(rad) * len };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Frame-rate independent exponential smoothing toward a target. */
export function damp(current: number, target: number, smoothing: number, dt: number): number {
  return lerp(current, target, 1 - Math.pow(smoothing, dt));
}

export function dampVec(current: Vec2, target: Vec2, smoothing: number, dt: number): Vec2 {
  const t = 1 - Math.pow(smoothing, dt);
  return { x: lerp(current.x, target.x, t), y: lerp(current.y, target.y, t) };
}

/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d < -Math.PI) d += TAU;
  else if (d > Math.PI) d -= TAU;
  return d;
}

/** Rotate `current` toward `target` by at most `maxStep` radians. */
export function rotateToward(current: number, target: number, maxStep: number): number {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

/** Move a scalar toward target by at most maxDelta. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

export function clampVecLength(v: Vec2, max: number): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len <= max || len < 1e-6) return { x: v.x, y: v.y };
  const s = max / len;
  return { x: v.x * s, y: v.y * s };
}

/** Remap a value from one range to another (unclamped). */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ---- Easing functions (UI transitions, set-piece reticles) ----
export const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t: number) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
};

/** Closest point on segment AB to point P. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = clamp01(t);
  return { x: a.x + abx * t, y: a.y + aby * t };
}
