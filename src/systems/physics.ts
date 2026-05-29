/**
 * Foundational arcade-physics + possession system.
 *
 * One pass per fixed tick mutates the GameWorld in place:
 *   1. Players integrate toward their `steer` (desired velocity) with arcade accel/decel,
 *      respecting stuns, slides, sprint, and a globally-fair stamina model.
 *   2. Soft player-player separation keeps bodies from overlapping.
 *   3. The ball either snaps to the dribbler's foot or runs loose under friction/gravity/
 *      Magnus, bounces, hits posts, gets captured, and can be jostled off the carrier.
 *   4. Slide tackles are arbitrated by a probabilistic referee (foul + card rolls).
 *
 * This module is the SOLE owner of `ball.owner`: only `giveBallTo` / `kickBall` change
 * possession. It is self-contained — no imports from actions/ai/matchController.
 */
import type { GameWorld, Player, Vec2 } from '@/core/types';
import { MatchState, TeamSide } from '@/core/types';
import { PITCH, PLAYER, BALL, POSSESSION, TACKLE, SHOT, CONTROL } from '@/core/constants';
import {
  angleOf,
  clamp,
  clamp01,
  clampVecLength,
  dampVec,
  dist,
  fromAngle,
  length,
  moveToward,
  normalize,
  perp,
  rotateToward,
} from '@/utils/math';
import { clampToPitch, isInDefensiveBox, oppGoalLineX, ownGoalLineX } from '@/utils/pitch';

const PITCH_PLAYER_MARGIN = 8;
/** Below this speed a loose ball on the ground is treated as effectively rolling to a stop. */
const BALL_STOP_EPS = 1.5;
/** Vertical speed below which a ground contact is a settle rather than a bounce. */
const BOUNCE_THRESHOLD = 30;
/** Speed imparted to the ball when a standing challenge knocks it loose. */
const JOSTLE_KNOCK_SPEED = 140;

// ───────────────────────────── Lookups ─────────────────────────────

export function playerById(world: GameWorld, id: string): Player | undefined {
  const players = world.players;
  for (let i = 0; i < players.length; i++) {
    if (players[i].id === id) return players[i];
  }
  return undefined;
}

export function nearestPlayerToPoint(
  world: GameWorld,
  p: Vec2,
  side?: TeamSide,
  excludeId?: string,
): Player | null {
  let best: Player | null = null;
  let bestDistSq = Infinity;
  const players = world.players;
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (pl.sentOff) continue;
    if (side !== undefined && pl.side !== side) continue;
    if (excludeId !== undefined && pl.id === excludeId) continue;
    const dx = pl.position.x - p.x;
    const dy = pl.position.y - p.y;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      best = pl;
    }
  }
  return best;
}

// ───────────────────────────── Possession transfer ─────────────────────────────

export function giveBallTo(world: GameWorld, playerId: string | null): void {
  const ball = world.ball;
  if (playerId === null) {
    ball.owner = null;
    setPossessionBooleans(world, null);
    return;
  }
  const owner = playerById(world, playerId);
  if (!owner || owner.sentOff) {
    ball.owner = null;
    setPossessionBooleans(world, null);
    return;
  }
  // Whoever last touched it before this transfer; a side change here = a turnover/steal.
  const prevSide = ball.lastTouchSide;
  ball.owner = owner.id;
  ball.lastTouch = owner.id;
  ball.lastTouchSide = owner.side;
  ball.velocity.x = owner.velocity.x;
  ball.velocity.y = owner.velocity.y;
  ball.z = 0;
  ball.zVel = 0;
  ball.spin = 0;
  ball.looseTime = 0;
  setPossessionBooleans(world, owner.side);

  // Arm the post-steal action lock (the blueprint "tackle instantly becomes shoot" fix):
  // suppress the action button for a beat whenever possession changes hands. Receiving a
  // pass from a teammate (same side) does not arm it, so quick first-time shots still work.
  if (prevSide !== null && prevSide !== owner.side) {
    world.actionLockTimer = CONTROL.actionLockAfterTackle;
  }
}

export function kickBall(
  world: GameWorld,
  kickerId: string,
  vx: number,
  vy: number,
  zVel: number,
  spin: number,
): void {
  const ball = world.ball;
  const kicker = playerById(world, kickerId);

  ball.owner = null;
  setPossessionBooleans(world, null);
  ball.velocity.x = vx;
  ball.velocity.y = vy;
  ball.zVel = zVel;
  ball.spin = spin;
  ball.looseTime = 0;

  if (kicker) {
    ball.lastTouch = kicker.id;
    ball.lastTouchSide = kicker.side;
    kicker.kickCooldown = POSSESSION.kickCooldown;
    kicker.kickAnimTimer = PLAYER.kickAnimTime;
    // Nudge the ball forward out of the kicker's capture radius so it actually leaves.
    const speed = Math.hypot(vx, vy);
    if (speed > 1e-3) {
      const nudge = kicker.radius + ball.radius + 2;
      ball.position.x += (vx / speed) * nudge;
      ball.position.y += (vy / speed) * nudge;
    }
  } else {
    ball.lastTouch = kickerId;
  }
}

function setPossessionBooleans(world: GameWorld, owningSide: TeamSide | null): void {
  world.teams[TeamSide.HOME].possession = owningSide === TeamSide.HOME;
  world.teams[TeamSide.AWAY].possession = owningSide === TeamSide.AWAY;
}

// ───────────────────────────── Main tick ─────────────────────────────

export function updatePhysics(world: GameWorld, dt: number): void {
  integratePlayers(world, dt);
  resolvePlayerCollisions(world);
  updateBall(world, dt);
  arbitrateSlides(world);
}

// ───────────────────────────── 1) Players ─────────────────────────────

function integratePlayers(world: GameWorld, dt: number): void {
  const players = world.players;
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (pl.sentOff) continue;

    // Decrement timers, clamped >= 0.
    pl.kickCooldown = Math.max(0, pl.kickCooldown - dt);
    pl.actionCooldown = Math.max(0, pl.actionCooldown - dt);
    pl.stunTimer = Math.max(0, pl.stunTimer - dt);
    pl.slideTimer = Math.max(0, pl.slideTimer - dt);
    pl.kickAnimTimer = Math.max(0, pl.kickAnimTimer - dt);

    const vel = pl.velocity;

    if (pl.stunTimer > 0) {
      // Grounded: damp velocity toward zero, ignore steer.
      vel.x = moveToward(vel.x, 0, PLAYER.decel * dt);
      vel.y = moveToward(vel.y, 0, PLAYER.decel * dt);
    } else if (pl.slideTimer > 0) {
      // Committed slide: keep current velocity, decay via decel, ignore steer.
      const cur = length(vel);
      if (cur > 1e-3) {
        const next = Math.max(0, cur - PLAYER.decel * dt);
        const s = next / cur;
        vel.x *= s;
        vel.y *= s;
      }
    } else {
      // Normal steering: integrate toward the controller-supplied desired velocity.
      const lowStamMul =
        pl.stamina < PLAYER.lowStaminaThreshold
          ? PLAYER.lowStaminaSpeedMul +
            (1 - PLAYER.lowStaminaSpeedMul) * (pl.stamina / PLAYER.lowStaminaThreshold)
          : 1;
      const sprintMul = pl.sprintActive ? PLAYER.sprintMultiplier : 1;
      const effectiveMax = pl.maxSpeed * sprintMul * lowStamMul;

      const desired = clampVecLength(pl.steer, effectiveMax);

      const speedNow = length(vel);
      const desiredSpeed = length(desired);
      // Accelerate when speeding up, decelerate when slowing / turning hard.
      const rate = desiredSpeed >= speedNow ? PLAYER.accel : PLAYER.decel;
      const maxStep = rate * dt;
      vel.x = moveToward(vel.x, desired.x, maxStep);
      vel.y = moveToward(vel.y, desired.y, maxStep);
    }

    // Facing follows velocity while moving.
    const movingSpeed = length(vel);
    if (movingSpeed > 1) {
      pl.facing = rotateToward(pl.facing, angleOf(vel), PLAYER.turnRate * dt);
    }

    // Integrate position.
    pl.position.x += vel.x * dt;
    pl.position.y += vel.y * dt;

    // Stamina model (globally fair: identical for AI and user).
    const sprintingForReal = pl.sprintActive && movingSpeed > 0.3 * pl.maxSpeed;
    if (sprintingForReal) {
      pl.stamina -= PLAYER.staminaSprintDrain * dt;
    } else {
      pl.stamina += PLAYER.staminaRegen * dt;
    }
    pl.stamina = clamp(pl.stamina, 0, PLAYER.staminaMax);
    if (pl.stamina < PLAYER.staminaMinToSprint) {
      pl.sprintActive = false;
    }

    // Run-cycle animation accumulation.
    pl.animPhase += movingSpeed * PLAYER.runCycleScale * dt;

    // Keep inside the playable area.
    const clamped = clampToPitch(pl.position, PITCH, PITCH_PLAYER_MARGIN);
    pl.position.x = clamped.x;
    pl.position.y = clamped.y;
  }
}

// ───────────────────────────── 2) Player-player soft collision ─────────────────────────────

function resolvePlayerCollisions(world: GameWorld): void {
  const players = world.players;
  const n = players.length;
  for (let i = 0; i < n; i++) {
    const a = players[i];
    if (a.sentOff) continue;
    for (let j = i + 1; j < n; j++) {
      const b = players[j];
      if (b.sentOff) continue;
      // A sliding player pushes through; skip separation if either is sliding.
      if (a.slideTimer > 0 || b.slideTimer > 0) continue;

      const dx = b.position.x - a.position.x;
      const dy = b.position.y - a.position.y;
      const minDist = a.radius + b.radius;
      const dSq = dx * dx + dy * dy;
      if (dSq >= minDist * minDist) continue;

      let d = Math.sqrt(dSq);
      let nx: number;
      let ny: number;
      if (d < 1e-4) {
        // Coincident — pick a deterministic separation axis.
        nx = 1;
        ny = 0;
        d = 0;
      } else {
        nx = dx / d;
        ny = dy / d;
      }
      const overlap = minDist - d;
      const push = overlap * 0.5;
      a.position.x -= nx * push;
      a.position.y -= ny * push;
      b.position.x += nx * push;
      b.position.y += ny * push;
    }
  }
}

// ───────────────────────────── 3) Ball ─────────────────────────────

function updateBall(world: GameWorld, dt: number): void {
  const ball = world.ball;
  const owner = ball.owner !== null ? playerById(world, ball.owner) : undefined;

  if (owner && !owner.sentOff && ball.z < BALL.controlHeight) {
    dribble(world, owner, dt);
    standingJostle(world, owner, dt);
    return;
  }

  // The owner is gone / sent off, or the ball rose out of control range → it is loose.
  if (ball.owner !== null && (!owner || owner.sentOff)) {
    ball.owner = null;
    setPossessionBooleans(world, null);
  }

  integrateLooseBall(world, dt);
  resolveGoalposts(world);
  captureLooseBall(world);
}

function dribble(world: GameWorld, owner: Player, dt: number): void {
  const ball = world.ball;
  // Foot target: a touch ahead of the owner in their facing direction.
  const dir = fromAngle(owner.facing);
  const target: Vec2 = {
    x: owner.position.x + dir.x * POSSESSION.dribbleOffset,
    y: owner.position.y + dir.y * POSSESSION.dribbleOffset,
  };
  const snapped = dampVec(ball.position, target, POSSESSION.dribbleSnap, dt);
  ball.position.x = snapped.x;
  ball.position.y = snapped.y;
  ball.velocity.x = owner.velocity.x;
  ball.velocity.y = owner.velocity.y;
  ball.z = 0;
  ball.zVel = 0;
  ball.spin = 0;
  ball.looseTime = 0;
  ball.lastTouch = owner.id;
  ball.lastTouchSide = owner.side;
  setPossessionBooleans(world, owner.side);
}

function integrateLooseBall(world: GameWorld, dt: number): void {
  const ball = world.ball;
  const vel = ball.velocity;

  // Vertical motion / bounce.
  ball.zVel -= BALL.gravity * dt;
  ball.z += ball.zVel * dt;
  if (ball.z <= 0) {
    ball.z = 0;
    if (ball.zVel < -BOUNCE_THRESHOLD) {
      ball.zVel = -ball.zVel * BALL.restitution;
      vel.x *= BALL.rollRestitution;
      vel.y *= BALL.rollRestitution;
      world.events.push({ type: 'bounce', position: { x: ball.position.x, y: ball.position.y } });
    } else {
      ball.zVel = 0;
    }
  }

  // Horizontal friction / drag.
  const speed = length(vel);
  if (speed > 1e-4) {
    if (ball.z <= 2) {
      // Rolling on the ground: linear deceleration toward zero.
      const next = Math.max(0, speed - BALL.groundDecel * dt);
      const s = next <= BALL_STOP_EPS ? 0 : next / speed;
      vel.x *= s;
      vel.y *= s;
    } else {
      // Airborne: multiplicative drag per second.
      const drag = Math.pow(BALL.airDrag, dt);
      vel.x *= drag;
      vel.y *= drag;
    }
  }

  // Magnus curve: accelerate perpendicular to travel, scaled by spin × speed.
  const speed2 = length(vel);
  if (speed2 > 1e-4 && Math.abs(ball.spin) > 1e-4) {
    const dir = normalize(vel);
    const p = perp(dir);
    const mag = BALL.magnus * ball.spin * speed2 * dt;
    vel.x += p.x * mag;
    vel.y += p.y * mag;
  }

  // Spin decays toward zero.
  ball.spin = moveToward(ball.spin, 0, BALL.spinDecay * dt);

  // Integrate horizontal position, then clamp speed.
  ball.position.x += vel.x * dt;
  ball.position.y += vel.y * dt;
  const clamped = clampVecLength(vel, BALL.maxSpeed);
  vel.x = clamped.x;
  vel.y = clamped.y;

  ball.looseTime += dt;
}

function resolveGoalposts(world: GameWorld): void {
  const ball = world.ball;
  if (ball.z >= PITCH.goalHeight) return;

  const halfGoal = PITCH.goalWidth / 2;
  const hitRadius = ball.radius + SHOT.postRadius;
  const hitRadiusSq = hitRadius * hitRadius;
  // Posts sit at both goal lines, at y = ±goalWidth/2.
  const postXs = [oppGoalLineX(TeamSide.HOME, PITCH), ownGoalLineX(TeamSide.HOME, PITCH)];
  const postYs = [halfGoal, -halfGoal];

  for (let xi = 0; xi < postXs.length; xi++) {
    const px = postXs[xi];
    for (let yi = 0; yi < postYs.length; yi++) {
      const py = postYs[yi];
      const dx = ball.position.x - px;
      const dy = ball.position.y - py;
      const dSq = dx * dx + dy * dy;
      if (dSq < hitRadiusSq) {
        // Reflect off the post (a goalpost stops the ball's horizontal travel through the line).
        ball.velocity.x = -ball.velocity.x;
        // Push the ball back out so it doesn't stick inside the post.
        const d = Math.sqrt(dSq) || 1e-4;
        const nx = dx / d;
        const ny = dy / d;
        const sep = hitRadius - d + 0.5;
        ball.position.x += nx * sep;
        ball.position.y += ny * sep;
        world.events.push({ type: 'post', position: { x: ball.position.x, y: ball.position.y } });
        return;
      }
    }
  }
}

function captureLooseBall(world: GameWorld): void {
  const ball = world.ball;
  if (ball.owner !== null) return;
  if (ball.z > BALL.controlHeight) return;

  let best: Player | null = null;
  let bestDistSq = Infinity;
  const players = world.players;
  const capSq = POSSESSION.captureRadius * POSSESSION.captureRadius;

  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (pl.sentOff) continue;
    if (pl.kickCooldown > 0) continue;
    const dx = pl.position.x - ball.position.x;
    const dy = pl.position.y - ball.position.y;
    const dSq = dx * dx + dy * dy;
    // Genuinely nearest within the capture radius. A sliding player counts too — that is
    // how a slide steals the ball.
    if (dSq <= capSq && dSq < bestDistSq) {
      bestDistSq = dSq;
      best = pl;
    }
  }

  if (best) {
    giveBallTo(world, best.id);
  }
}

function standingJostle(world: GameWorld, owner: Player, dt: number): void {
  const ball = world.ball;
  const players = world.players;
  const radiusSq = TACKLE.standingStealRadius * TACKLE.standingStealRadius;

  for (let i = 0; i < players.length; i++) {
    const opp = players[i];
    if (opp.sentOff) continue;
    if (opp.side === owner.side) continue;
    if (opp.kickCooldown > 0) continue;
    const dx = opp.position.x - owner.position.x;
    const dy = opp.position.y - owner.position.y;
    if (dx * dx + dy * dy > radiusSq) continue;

    // Defending vs dribbling ratio drives the steal chance. standingStealChanceBase is a
    // PER-SECOND rate, so scale by dt (≈0.45·ratio per second → a fair couple-of-seconds
    // hold before a likely strip, keeping the committed slide the faster option).
    const ratio = clamp01((opp.stats.defending + 1) / (owner.stats.dribbling + 1));
    const p = TACKLE.standingStealChanceBase * dt * ratio;
    if (world.rng.chance(p)) {
      // Knock the ball loose toward the challenger.
      giveBallTo(world, null);
      setPossessionBooleans(world, null);
      const dir = normalize({ x: dx, y: dy });
      ball.velocity.x = dir.x * JOSTLE_KNOCK_SPEED;
      ball.velocity.y = dir.y * JOSTLE_KNOCK_SPEED;
      ball.z = 0;
      ball.zVel = 0;
      ball.spin = 0;
      ball.looseTime = 0;
      ball.lastTouch = opp.id;
      ball.lastTouchSide = opp.side;
      // The dispossessed carrier briefly can't re-grab.
      owner.kickCooldown = Math.max(owner.kickCooldown, POSSESSION.stealImmunity);
      world.events.push({
        type: 'tackle',
        position: { x: owner.position.x, y: owner.position.y },
        side: opp.side,
      });
      return;
    }
  }
}

// ───────────────────────────── 4) Slide foul arbitration ─────────────────────────────

function arbitrateSlides(world: GameWorld): void {
  if (world.state !== MatchState.PLAYING) return;
  if (world.foul !== null) return;

  const players = world.players;
  const ball = world.ball;

  for (let i = 0; i < players.length; i++) {
    const slider = players[i];
    if (slider.sentOff) continue;
    if (slider.slideTimer <= 0) continue;

    const sliderSpeed = length(slider.velocity);
    const ballOwnedBySlider = ball.owner === slider.id;
    const ballCloseToSlider = dist(ball.position, slider.position) <= TACKLE.slideStealRadius;
    const gotBall = ballOwnedBySlider || ballCloseToSlider;

    for (let j = 0; j < players.length; j++) {
      const victim = players[j];
      if (victim === slider || victim.sentOff) continue;
      if (victim.side === slider.side) continue;
      // Body contact within the slide steal radius.
      if (dist(victim.position, slider.position) > TACKLE.slideStealRadius) continue;

      // Did the slider come into the back of the victim?
      const sliderDir = normalize(slider.velocity);
      const victimFacing = fromAngle(victim.facing);
      const fromBehind = sliderDir.x * victimFacing.x + sliderDir.y * victimFacing.y > 0.3;

      let foulChance = TACKLE.foulBaseChance;
      if (fromBehind) foulChance += TACKLE.foulFromBehindBonus;
      if (sliderSpeed > 0.8 * slider.maxSpeed) foulChance += TACKLE.foulHighSpeedBonus;
      if (gotBall) foulChance *= 1 - TACKLE.foulCleanBallReduction;

      if (world.rng.chance(foulChance)) {
        const card = world.rng.chance(TACKLE.redChance)
          ? ('red' as const)
          : world.rng.chance(TACKLE.yellowChance)
            ? ('yellow' as const)
            : ('none' as const);
        world.foul = {
          position: { x: victim.position.x, y: victim.position.y },
          offenderId: slider.id,
          offenderSide: slider.side,
          victimId: victim.id,
          card,
          isPenalty: isInDefensiveBox(victim.position, slider.side, PITCH),
          awardedTo: victim.side,
        };
        victim.stunTimer = TACKLE.stunDuration;
        slider.stunTimer = TACKLE.offenderRecover;
        world.events.push({
          type: 'foul',
          position: { x: victim.position.x, y: victim.position.y },
          side: victim.side,
        });
        return; // Only one foul per frame.
      }
      // No foul: if the slider won the ball cleanly it is captured by the loose-ball logic.
    }
  }
}
