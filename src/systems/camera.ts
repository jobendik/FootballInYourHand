/**
 * Camera system — a ball-follow camera with look-ahead, eased zoom, event-driven screen
 * shake and hit-stop. Pure feel: it never touches gameplay state beyond `world.camera`
 * and `world.hitStop`.
 *
 * Orientation note (see core/viewport.ts): `camera.position` is the world-space centre of
 * the viewport; the renderer maps it to the screen and is responsible for clamping it to
 * the pitch once it knows the viewport size. We deliberately do NOT clamp here.
 */
import type { GameWorld } from '@/core/types';
import { MatchState } from '@/core/types';
import { CAMERA } from '@/core/constants';
import { clamp, clone, dampVec, damp } from '@/utils/math';
import { uiRng } from '@/utils/rng';

/** Largest world-space look-ahead offset we allow, so a fast ball never yanks the view. */
const MAX_LOOKAHEAD_OFFSET = 140;

/** Below this magnitude the shake is treated as zero (no jitter). */
const SHAKE_EPSILON = 0.05;

export function updateCamera(world: GameWorld, dt: number): void {
  const cam = world.camera;
  const ball = world.ball;
  const setPiece = world.setPiece;

  // ── Target selection ───────────────────────────────────────────────
  // During a set piece we frame the dead ball (penalties follow the aiming reticle so the
  // user sees where the shot is going); otherwise we follow the ball with velocity-based
  // look-ahead.
  if (setPiece && (world.state === MatchState.PENALTY || world.state === MatchState.FREE_KICK)) {
    const focus = world.state === MatchState.PENALTY ? setPiece.reticle : setPiece.position;
    cam.target.x = focus.x;
    cam.target.y = focus.y;
  } else {
    let aheadX = ball.velocity.x * CAMERA.lookAhead;
    let aheadY = ball.velocity.y * CAMERA.lookAhead;
    const aheadLen = Math.hypot(aheadX, aheadY);
    if (aheadLen > MAX_LOOKAHEAD_OFFSET) {
      const s = MAX_LOOKAHEAD_OFFSET / aheadLen;
      aheadX *= s;
      aheadY *= s;
    }
    cam.target.x = ball.position.x + aheadX;
    cam.target.y = ball.position.y + aheadY;
  }

  // ── Position follow ────────────────────────────────────────────────
  cam.position = dampVec(cam.position, cam.target, CAMERA.smooth, dt);

  // ── Zoom ───────────────────────────────────────────────────────────
  // Punch in a little for celebrations / penalties to add drama; relax to base otherwise.
  const dramatic = world.state === MatchState.GOAL_CELEBRATION || world.state === MatchState.PENALTY;
  cam.targetZoom = dramatic ? CAMERA.baseZoom * 1.06 : CAMERA.baseZoom;
  cam.zoom = damp(cam.zoom, cam.targetZoom, CAMERA.zoomSmooth, dt);

  // ── Events → shake + hit-stop ──────────────────────────────────────
  const shakeOn = world.config.screenShakeEnabled && !world.config.reducedMotion;
  let addShake = 0;
  let addHitStop = 0;

  for (const ev of world.events) {
    switch (ev.type) {
      case 'shot': {
        const power = ev.power ?? 1;
        addShake = Math.max(addShake, CAMERA.shotShake * power);
        break;
      }
      case 'post': {
        addShake = Math.max(addShake, CAMERA.postShake);
        addHitStop = Math.max(addHitStop, CAMERA.hitStopPost);
        break;
      }
      case 'goal': {
        addShake = Math.max(addShake, CAMERA.goalShake);
        addHitStop = Math.max(addHitStop, CAMERA.hitStopGoal);
        break;
      }
      case 'tackle': {
        addShake = Math.max(addShake, CAMERA.tackleShake);
        if ((ev.power ?? 0) > 0.5) addHitStop = Math.max(addHitStop, CAMERA.hitStopTackle);
        break;
      }
      // Other events have no camera feel.
      case 'kick':
      case 'pass':
      case 'foul':
      case 'whistle':
      case 'save':
      case 'cheer':
      case 'switch':
      case 'bounce':
      case 'kickoff':
      case 'button':
        break;
      default:
        break;
    }
  }

  if (shakeOn && addShake > 0) {
    cam.shake = Math.min(CAMERA.shakeMaxOffset, Math.max(cam.shake, addShake));
  }
  // Hit-stop respects reduced motion (it freezes the sim, which can feel jarring) but is
  // independent of the shake toggle — it is a timing effect, not a visual jolt.
  if (!world.config.reducedMotion && addHitStop > 0) {
    world.hitStop = Math.max(world.hitStop, addHitStop);
  }

  // ── Resolve shake ──────────────────────────────────────────────────
  // Decay toward zero, then sample a fresh jittered offset for this frame.
  cam.shake = Math.max(0, cam.shake - CAMERA.shakeDecay * dt);
  if (cam.shake > SHAKE_EPSILON) {
    // Use the non-sim UI RNG: the hit-stop branch in the game loop calls updateCamera at a
    // variable, wall-clock cadence, so drawing the shake offset from the seeded sim RNG would
    // advance it a framerate-dependent number of times and break determinism.
    cam.offset.x = uiRng.jitter(cam.shake);
    cam.offset.y = uiRng.jitter(cam.shake);
  } else {
    cam.shake = 0;
    cam.offset.x = 0;
    cam.offset.y = 0;
  }

  // Defensive clamp in case a stray event over-drove the magnitude.
  cam.offset.x = clamp(cam.offset.x, -CAMERA.shakeMaxOffset, CAMERA.shakeMaxOffset);
  cam.offset.y = clamp(cam.offset.y, -CAMERA.shakeMaxOffset, CAMERA.shakeMaxOffset);
}

/** Hard-cut the camera onto the ball (kickoffs, resets) with no shake or zoom carry-over. */
export function snapCameraToBall(world: GameWorld): void {
  const cam = world.camera;
  cam.position = clone(world.ball.position);
  cam.target = clone(world.ball.position);
  cam.offset = { x: 0, y: 0 };
  cam.shake = 0;
  cam.zoom = CAMERA.baseZoom;
  cam.targetZoom = CAMERA.baseZoom;
}
