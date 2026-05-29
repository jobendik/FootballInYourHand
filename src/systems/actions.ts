/**
 * User control mapping + shared action primitives.
 *
 * This module is the seam between *intent* (the user's joystick + buttons, sampled into
 * `world.input`, and the AI's decisions) and the *physics* primitives that actually move
 * the ball. Both `updateUserActions` (the human's active player) and `ai.ts` call the
 * `execute*` / `selectPassTarget` helpers here, so passing and shooting feel identical
 * regardless of who triggers them.
 *
 * Possession invariant: only physics flips `ball.owner` (via `kickBall` / `giveBallTo`).
 * The helpers below merely request a kick; they never assign `ball.owner` directly.
 */
import type { GameWorld, Player, Vec2 } from '@/core/types';
import { ControlMode, MatchState, PlayerRole } from '@/core/types';
import { PASS, SHOT, TACKLE, PLAYER, CONTROL, PITCH } from '@/core/constants';
import {
  add,
  sub,
  scale,
  dot,
  dist,
  length,
  normalize,
  clamp,
  clamp01,
  lerp,
  fromAngle,
  angleOf,
} from '@/utils/math';
import { attackDir, oppGoalCenter, ownGoalCenter, withinGoalMouth } from '@/utils/pitch';
import { kickBall, playerById } from '@/systems/physics';

// ───────────────────────────── Control mapping ─────────────────────────────

/**
 * Resolve possession into `world.controlMode`, keep exactly one player flagged `isUser`,
 * and run the auto/manual defender-switch logic. Called once per frame before
 * `updateUserActions`.
 */
export function updateControl(world: GameWorld, dt: number): void {
  // Tick down the global gates (never below zero).
  world.actionLockTimer = Math.max(0, world.actionLockTimer - dt);
  world.switchCooldown = Math.max(0, world.switchCooldown - dt);

  const prevMode = world.controlMode;

  const owner = world.ball.owner ? playerById(world, world.ball.owner) : undefined;
  const userHasBall = !!owner && owner.side === world.userSide;
  world.controlMode = userHasBall ? ControlMode.OFFENSIVE : ControlMode.DEFENSIVE;

  // During a penalty the ball is owner-less, which would leave the user-taker in DEFENSIVE
  // mode where the action button is zeroed — softlocking the aim phase. Force OFFENSIVE so
  // the action button maps to `shoot` and the strike can fire.
  if (
    world.state === MatchState.PENALTY &&
    world.setPiece !== null &&
    world.setPiece.forSide === world.userSide
  ) {
    world.controlMode = ControlMode.OFFENSIVE;
  }

  // Active-player management + switching only happens during open play. During kickoffs,
  // set pieces and celebrations the active player is left alone (this also avoids a spurious
  // defender-switch — and its SFX — firing at every kickoff).
  if (world.state === MatchState.PLAYING) {
    if (world.controlMode === ControlMode.OFFENSIVE && owner) {
      // While attacking, the user always controls the ball carrier.
      world.activePlayerId = owner.id;
    } else {
      // Out of possession: validate the current active player. If it has become invalid
      // (sent off, a goalkeeper, or somehow on the wrong side), or we just transitioned out
      // of possession this frame, hand control to the best available defender.
      const active = playerById(world, world.activePlayerId);
      const invalid =
        !active ||
        active.sentOff ||
        active.role === PlayerRole.GK ||
        active.side !== world.userSide;
      const justLostPossession = prevMode === ControlMode.OFFENSIVE;
      if (invalid || justLostPossession) {
        switchToBestDefender(world);
      }
    }

    // Manual switch button (defensive only, debounced).
    if (
      world.input.switchPlayer &&
      world.switchCooldown <= 0 &&
      world.controlMode === ControlMode.DEFENSIVE
    ) {
      switchToBestDefender(world);
    }
  }

  // Enforce the single-active-player invariant: exactly one outfield/active player has
  // `isUser`, everyone else is cleared.
  for (const p of world.players) {
    p.isUser = p.id === world.activePlayerId;
  }
}

// ───────────────────────────── User actions ─────────────────────────────

/**
 * Translate `world.input` into the active player's steering + offensive/defensive actions.
 */
export function updateUserActions(world: GameWorld, _dt: number): void {
  const active = playerById(world, world.activePlayerId);
  if (!active || active.sentOff || active.stunTimer > 0) return;

  const input = world.input;

  // ── Movement ── `input.move` is already world-space with magnitude <= 1.
  active.steer = scale(input.move, active.maxSpeed);
  active.sprintActive = input.sprint && active.stamina > PLAYER.staminaMinToSprint;

  // A slide is fully physics-driven: zero out steering so we don't fight the lunge.
  if (active.slideTimer > 0) {
    active.steer = { x: 0, y: 0 };
  }

  const moveMag = length(input.move);
  const hasAim = moveMag > 0.15;
  const owns = world.ball.owner === active.id;

  // The action-lock briefly suppresses offensive actions right after winning the ball, so a
  // tackle button that the user is still holding doesn't instantly fire a shot/pass on release.
  const actionsUnlocked = world.actionLockTimer <= 0;

  if (owns) {
    // ── OFFENSIVE: shoot ──
    if (input.shoot.released && actionsUnlocked) {
      const charge = clamp01(input.shoot.holdTime / SHOT.maxChargeTime);
      const base = oppGoalCenter(active.side, PITCH);
      let aim: Vec2;
      if (hasAim) {
        aim = add(active.position, scale(normalize(input.move), 300));
      } else {
        aim = base;
      }
      // Curve = lateral component of the joystick relative to the shot direction, in
      // [-1, 1]. Cross-product sign gives the side; magnitude scales with how perpendicular
      // the joystick is to the shot line.
      let curveInput = 0;
      if (hasAim) {
        const shotDir = normalize(sub(aim, active.position));
        const joy = normalize(input.move);
        const crossZ = shotDir.x * joy.y - shotDir.y * joy.x; // sin(angle), in [-1,1]
        curveInput = clamp(crossZ, -1, 1);
      }
      executeShot(world, active.id, aim, charge, curveInput);
    }

    // ── OFFENSIVE: pass ──
    if (input.pass.released && actionsUnlocked) {
      const charge = clamp01(input.pass.holdTime / PASS.maxChargeTime);
      const aimDir = hasAim ? normalize(input.move) : fromAngle(active.facing);
      const target = selectPassTarget(world, active.id, aimDir);
      const point = target
        ? add(target.position, scale(target.velocity, PASS.leadFactor))
        : add(active.position, scale(aimDir, 220));
      executePass(world, active.id, point, charge);
    }
  } else {
    // ── DEFENSIVE: slide tackle ──
    // `actionLockTimer` suppresses the action button briefly after winning the ball — the
    // documented "tackle instantly becomes shoot" fix.
    if (
      input.slide &&
      active.slideTimer <= 0 &&
      active.actionCooldown <= 0 &&
      world.actionLockTimer <= 0
    ) {
      executeSlide(world, active.id);
    }
  }
}

// ───────────────────────────── Pass ─────────────────────────────

export function executePass(world: GameWorld, passerId: string, target: Vec2, charge: number): void {
  const passer = playerById(world, passerId);
  if (!passer || world.ball.owner !== passerId) return;

  const toTarget = sub(target, passer.position);
  let dir = normalize(toTarget);
  const d = dist(target, passer.position);

  // Base speed from the passing attribute, plus a distance kicker so long balls arrive in
  // time, clamped into a sane band.
  let speed = clamp(
    lerp(PASS.groundSpeedMin, PASS.groundSpeedMax, passer.stats.passing / 100) +
      d * PASS.distanceSpeedGain,
    PASS.groundSpeedMin,
    900,
  );

  // Aim jitter: worse passers spray more.
  const spread = PASS.inaccuracyBase * (1 - passer.stats.passing / 100);
  if (spread > 0) {
    const a = angleOf(dir) + world.rng.jitter(spread);
    dir = fromAngle(a);
  }

  // Loft on a charged pass (a cross / lob over ground-level defenders).
  const lofted = charge > 0.2;
  const zVel = lofted ? PASS.loftZVelMax * charge : 0;
  if (lofted) speed *= PASS.loftForwardBoost;

  const spin = world.rng.jitter(0.3);
  kickBall(world, passerId, dir.x * speed, dir.y * speed, zVel, spin);

  world.events.push({
    type: 'pass',
    position: { x: passer.position.x, y: passer.position.y },
    side: passer.side,
    power: charge,
    rarity: passer.rarity,
    playerId: passerId,
  });
  world.stats[passer.side].passes++;
}

// ───────────────────────────── Shot ─────────────────────────────

export function executeShot(
  world: GameWorld,
  shooterId: string,
  aim: Vec2,
  charge: number,
  curveInput: number,
): void {
  const shooter = playerById(world, shooterId);
  if (!shooter || world.ball.owner !== shooterId) return;

  let dir = normalize(sub(aim, shooter.position));
  const spread = SHOT.inaccuracyBase * (1 - shooter.stats.shooting / 100);
  if (spread > 0) {
    const a = angleOf(dir) + world.rng.jitter(spread);
    dir = fromAngle(a);
  }

  const speed =
    lerp(SHOT.speedMin, SHOT.speedMax, 0.35 + 0.65 * charge) *
    (0.75 + 0.25 * shooter.stats.shooting / 100);
  const spin = curveInput * SHOT.curveMax * (0.5 + 0.5 * shooter.stats.dribbling / 100);
  const zVel = SHOT.minLoft + SHOT.loftZVelMax * charge;

  kickBall(world, shooterId, dir.x * speed, dir.y * speed, zVel, spin);

  world.events.push({
    type: 'shot',
    position: { x: shooter.position.x, y: shooter.position.y },
    side: shooter.side,
    power: Math.max(charge, 0.4),
    rarity: shooter.rarity,
    playerId: shooterId,
  });
  world.stats[shooter.side].shots++;

  // "On target": project the shot trajectory to the opponent goal line and see if it lands
  // inside the goal mouth (and is actually travelling toward that goal).
  if (isShotOnTarget(shooter, dir)) {
    world.stats[shooter.side].shotsOnTarget++;
  }
}

/** Rough on-target test: extend the shot direction to the attacked goal line. */
function isShotOnTarget(shooter: Player, dir: Vec2): boolean {
  const dirX = attackDir(shooter.side);
  const goalLineX = dirX * PITCH.halfLength;
  // Must travel toward the opponent's goal at all.
  if (Math.sign(dir.x) !== dirX || Math.abs(dir.x) < 1e-3) return false;
  const t = (goalLineX - shooter.position.x) / dir.x;
  if (t <= 0) return false;
  const yAtLine = shooter.position.y + dir.y * t;
  return withinGoalMouth(yAtLine, PITCH);
}

// ───────────────────────────── Slide ─────────────────────────────

export function executeSlide(world: GameWorld, playerId: string): void {
  const p = playerById(world, playerId);
  if (!p || p.slideTimer > 0) return;

  p.slideTimer = TACKLE.slideDuration;
  const lunge = fromAngle(p.facing);
  p.velocity = add(p.velocity, scale(lunge, TACKLE.slideLungeSpeed));
  p.stamina = Math.max(0, p.stamina - PLAYER.staminaSlideCost);
  p.actionCooldown = TACKLE.slideDuration + TACKLE.slideRecover;

  world.events.push({
    type: 'tackle',
    position: { x: p.position.x, y: p.position.y },
    side: p.side,
    playerId,
    power: 0.7,
  });
}

// ───────────────────────────── Pass target selection ─────────────────────────────

/**
 * Pick the teammate the passer most likely intends, given the aim direction. Combines
 * directional alignment (dot product), forward progress, and distance. GKs are only chosen
 * as a last resort. Returns the best `Player`, or `null` if there are no candidates.
 */
export function selectPassTarget(
  world: GameWorld,
  passerId: string,
  aimDirWorld: Vec2,
): Player | null {
  const passer = playerById(world, passerId);
  if (!passer) return null;

  const aimDir = normalize(aimDirWorld);
  const dir = attackDir(passer.side);

  let best: Player | null = null;
  let bestScore = -Infinity;
  let bestInCone: Player | null = null;
  let bestInConeScore = -Infinity;
  // Fallback to the GK only if no outfield teammate is reachable.
  let bestGk: Player | null = null;
  let bestGkScore = -Infinity;

  for (const t of world.players) {
    if (t.id === passer.id) continue;
    if (t.side !== passer.side) continue;
    if (t.sentOff) continue;

    const to = sub(t.position, passer.position);
    const d = length(to);
    if (d < 1) continue;
    const dirT = scale(to, 1 / d); // normalized

    const align = dot(dirT, aimDir);
    const forward = (t.position.x - passer.position.x) * dir;
    const score =
      align * PASS.aimWeight + forward * PASS.forwardBias * 0.002 - d * PASS.distanceWeight;

    if (t.role === PlayerRole.GK) {
      if (score > bestGkScore) {
        bestGkScore = score;
        bestGk = t;
      }
      continue;
    }

    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
    if (align > PASS.aimConeDot && score > bestInConeScore) {
      bestInConeScore = score;
      bestInCone = t;
    }
  }

  // Prefer a candidate inside the aim cone; otherwise the best overall outfield option;
  // and only fall back to the keeper if nothing else exists.
  if (bestInCone) return bestInCone;
  if (best) return best;
  return bestGk;
}

// ───────────────────────────── Defender switching ─────────────────────────────

/**
 * Choose the user's best defender to control: nearest to the ball, biased toward players
 * positioned "goalside" (between the ball and the user's own goal). Updates the active
 * player, the `isUser` flags, the switch cooldown, and pushes a 'switch' event.
 */
export function switchToBestDefender(world: GameWorld): void {
  const userSide = world.userSide;
  const ballPos = world.ball.position;
  const ownGoal = ownGoalCenter(userSide, PITCH);
  // Direction from the user's own goal toward the ball; "goalside" players sit along this
  // line between the goal and the ball.
  const goalToBall = sub(ballPos, ownGoal);
  const goalToBallLen = length(goalToBall);
  const goalToBallDir = goalToBallLen > 1e-3 ? scale(goalToBall, 1 / goalToBallLen) : { x: 0, y: 0 };

  let chosen: Player | null = null;
  let bestScore = -Infinity;

  for (const p of world.players) {
    if (p.side !== userSide) continue;
    if (p.role === PlayerRole.GK) continue;
    if (p.sentOff) continue;

    const distToBall = dist(p.position, ballPos);

    // Perpendicular distance of the player from the goal→ball line measures how far off the
    // goalside corridor they are; smaller is better.
    const fromGoal = sub(p.position, ownGoal);
    const along = dot(fromGoal, goalToBallDir);
    const proj = scale(goalToBallDir, along);
    const perp = sub(fromGoal, proj);
    const howFarFromGoalsideLine = length(perp);

    const score = -distToBall - CONTROL.switchGoalsideBias * howFarFromGoalsideLine;
    if (score > bestScore) {
      bestScore = score;
      chosen = p;
    }
  }

  if (!chosen) return;

  world.activePlayerId = chosen.id;
  for (const p of world.players) {
    p.isUser = p.id === chosen.id;
  }
  world.switchCooldown = CONTROL.switchCooldown;
  world.events.push({
    type: 'switch',
    position: { x: chosen.position.x, y: chosen.position.y },
  });
}
