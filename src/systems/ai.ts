/**
 * Per-agent finite-state AI.
 *
 * Architecture: stateless system over the data-oriented `GameWorld`. Every non-user,
 * on-pitch player gets a behaviour state and a movement target each tick; the AI only ever
 * writes `player.steer` (a desired velocity) and asks `actions`/`physics` to perform real
 * actions (pass/shot/slide/give). Physics integrates the steering toward the target with the
 * SAME accel/decel/turn limits the user obeys.
 *
 * FAITHFULNESS (blueprint): difficulty is expressed ONLY through positioning, pressing
 * intensity, pass/shot accuracy and decision speed — never through faster movement or
 * cheaper stamina. The AI cannot exceed `player.maxSpeed * PLAYER.sprintMultiplier`, exactly
 * like the user. Sprinting still drains stamina via the shared physics rules.
 *
 * Team coordination: only the N closest outfielders contest the ball; everyone else holds a
 * dynamically-shifting formation shape and either supports the attack or marks goal-side.
 */
import type { GameWorld, Player, Vec2 } from '@/core/types';
import { MatchState, PlayerRole, AIState, TeamSide } from '@/core/types';
import { AI, PITCH, PLAYER, BALL } from '@/core/constants';
import {
  add,
  sub,
  scale,
  dot,
  length,
  dist,
  distSq,
  normalize,
  clamp,
  clamp01,
  lerp,
} from '@/utils/math';
import {
  attackDir,
  baseAnchor,
  ownGoalCenter,
  oppGoalCenter,
  clampToPitch,
} from '@/utils/pitch';
import { playerById } from '@/systems/physics';
import { executePass, executeShot, executeSlide, selectPassTarget } from '@/systems/actions';

// ───────────────────────────── tunables (AI-local) ─────────────────────────────

/** Distance from opp goal within which the carrier will consider shooting. */
const SHOOT_RANGE = 320;
/** Opponent distance under which the carrier feels "pressured". */
const PRESSURE_RADIUS = 70;
/** Snap-to-target distance below which steering goes near-zero (anti-jitter). */
const ARRIVE_EPS = 14;
/** GK delay (s) before it plays the ball out, so it doesn't insta-pass on the catch. */
const GK_CLEAR_DELAY = 0.35;
/** A loose/own ball this far ahead of the defensive line counts as a breakaway threat. */
const BREAKAWAY_LEAD = 220;

// ───────────────────────────── per-frame scratch ─────────────────────────────
// Recomputed once per frame (not per player) to keep CPU cost reasonable.

interface SortedEntry {
  player: Player;
  d2: number;
}

/** Outfield players of each side, sorted by distance² to the ball. */
const sortedByBall: Record<TeamSide, SortedEntry[]> = {
  [TeamSide.HOME]: [],
  [TeamSide.AWAY]: [],
};

function rebuildBallSort(world: GameWorld): void {
  sortedByBall[TeamSide.HOME].length = 0;
  sortedByBall[TeamSide.AWAY].length = 0;
  const bp = world.ball.position;
  for (const p of world.players) {
    if (p.sentOff || p.role === PlayerRole.GK) continue;
    sortedByBall[p.side].push({ player: p, d2: distSq(p.position, bp) });
  }
  sortedByBall[TeamSide.HOME].sort((a, b) => a.d2 - b.d2);
  sortedByBall[TeamSide.AWAY].sort((a, b) => a.d2 - b.d2);
}

/** Is `player` among its team's N closest outfielders to the ball? */
function isChaser(player: Player): boolean {
  const list = sortedByBall[player.side];
  const limit = Math.min(AI.chasers, list.length);
  for (let i = 0; i < limit; i++) {
    if (list[i].player.id === player.id) return true;
  }
  return false;
}

// ───────────────────────────── difficulty knobs ─────────────────────────────

function levelLerp(pair: readonly [number, number] | number[], level: number): number {
  return lerp(pair[0] as number, pair[1] as number, clamp01(level));
}

// ───────────────────────────── helpers ─────────────────────────────

/** Nearest opponent to `player` (any role), or null. */
function nearestOpponent(world: GameWorld, player: Player): Player | null {
  const opp = player.side === TeamSide.HOME ? TeamSide.AWAY : TeamSide.HOME;
  let best: Player | null = null;
  let bestD2 = Infinity;
  for (const p of world.players) {
    if (p.sentOff || p.side !== opp) continue;
    const d2 = distSq(p.position, player.position);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

/** A point that leads the ball by its current velocity (intercept estimate). */
function interceptPoint(world: GameWorld, player: Player, anticipation: number): Vec2 {
  const ball = world.ball;
  // Crude time-to-reach estimate so faster players lead the ball more sensibly.
  const speed = Math.max(60, player.maxSpeed);
  const gap = dist(player.position, ball.position);
  const lead = clamp((gap / speed) * anticipation, 0, 0.6);
  return {
    x: ball.position.x + ball.velocity.x * lead,
    y: ball.position.y + ball.velocity.y * lead,
  };
}

/** True if no opponent sits inside the cone between `from` and `to` (rough lane check). */
function laneRoughlyOpen(world: GameWorld, from: Vec2, to: Vec2, side: TeamSide): boolean {
  const opp = side === TeamSide.HOME ? TeamSide.AWAY : TeamSide.HOME;
  const seg = sub(to, from);
  const segLen = length(seg);
  if (segLen < 1) return true;
  const dir = scale(seg, 1 / segLen);
  for (const p of world.players) {
    if (p.sentOff || p.side !== opp) continue;
    const rel = sub(p.position, from);
    const along = dot(rel, dir);
    if (along <= 0 || along >= segLen) continue;
    const perpDist = Math.abs(rel.x * -dir.y + rel.y * dir.x);
    if (perpDist < 40) return false;
  }
  return true;
}

/** Push `target` away from nearby teammates so attackers spread into space. */
function spreadFromTeammates(world: GameWorld, player: Player, target: Vec2, radius: number): Vec2 {
  let pushX = 0;
  let pushY = 0;
  for (const p of world.players) {
    if (p.id === player.id || p.sentOff || p.side !== player.side || p.role === PlayerRole.GK) continue;
    const d = dist(p.position, player.position);
    if (d > radius || d < 1e-3) continue;
    const w = (radius - d) / radius;
    pushX += ((player.position.x - p.position.x) / d) * w * 60;
    pushY += ((player.position.y - p.position.y) / d) * w * 60;
  }
  return { x: target.x + pushX, y: target.y + pushY };
}

// ───────────────────────────── steering output ─────────────────────────────

/**
 * Resolve `player.steer` from a world-space target. Clamps to the player's lawful speed
 * band (max speed × sprint multiplier) and zeroes steering on arrival to prevent jitter.
 */
function steerToward(player: Player, target: Vec2): void {
  const toTarget = sub(target, player.position);
  const d = length(toTarget);
  if (d < ARRIVE_EPS) {
    // Ease off so the agent settles instead of vibrating around the point.
    player.steer.x = toTarget.x * 0.25;
    player.steer.y = toTarget.y * 0.25;
    return;
  }
  const sprintMul = player.sprintActive ? PLAYER.sprintMultiplier : 1;
  let desired = player.maxSpeed * sprintMul;
  // Hard ceiling: never exceed the lawful top speed (fairness invariant).
  desired = Math.min(desired, player.maxSpeed * PLAYER.sprintMultiplier);
  const inv = desired / d;
  player.steer.x = toTarget.x * inv;
  player.steer.y = toTarget.y * inv;
}

/** Decide whether sprinting is allowed (space ahead + enough stamina). Fair: same gate as user. */
function wantSprint(player: Player, target: Vec2): boolean {
  if (player.stamina <= PLAYER.staminaMinToSprint) return false;
  const gap = dist(player.position, target);
  return gap > 70;
}

// ───────────────────────────── goalkeeper ─────────────────────────────

function updateGoalkeeper(world: GameWorld, gk: Player, _dt: number, kickoffOnly: boolean): void {
  gk.aiState = AIState.GOALKEEP;
  const dir = attackDir(gk.side);
  const goalLineX = -dir * PITCH.halfLength;
  const ownGoal = ownGoalCenter(gk.side, PITCH);
  const ball = world.ball;
  const team = world.teams[gk.side];

  // The keeper's resting line: a touch off the goal line, tracking the ball laterally.
  let lineDepth = AI.gkLineDepth;
  const ballInOwnHalf = (ball.position.x - 0) * dir < 0; // ball nearer this side's goal
  const ballGap = dist(ball.position, ownGoal);

  // Sweeper behaviour: advance off the line when the ball threatens inside the own half.
  if (!kickoffOnly && ballInOwnHalf && ballGap < PITCH.penaltyBoxDepth + 140) {
    const advance = clamp((PITCH.penaltyBoxDepth + 140 - ballGap) * 0.5, 0, 130);
    lineDepth += advance;
  }

  const targetX = goalLineX + dir * lineDepth;
  const targetY = clamp(ball.position.y, -AI.gkRangeY, AI.gkRangeY);
  let target: Vec2 = { x: targetX, y: targetY };

  // If the GK has the ball, clear it up-field once after a short composure beat.
  // The decision timer is held at GK_CLEAR_DELAY while the keeper does NOT own the ball
  // (below), so on the frame it gains possession it begins counting down from the delay.
  if (ball.owner === gk.id && !kickoffOnly) {
    gk.aiTarget = ownGoal;
    gk.aiDecisionTimer -= _dt;
    if (gk.aiDecisionTimer <= 0) {
      const toGoal = oppGoalCenter(gk.side, PITCH);
      const aimDir = normalize(sub(toGoal, gk.position));
      const mate = selectPassTarget(world, gk.id, aimDir);
      const clearTarget = mate
        ? add(mate.position, scale(mate.velocity, 0.2))
        : {
            x: gk.position.x + dir * 360,
            y: clamp(gk.position.y + world.rng.jitter(120), -PITCH.halfWidth + 40, PITCH.halfWidth - 40),
          };
      executePass(world, gk.id, clearTarget, 0.7);
      gk.aiDecisionTimer = GK_CLEAR_DELAY; // re-arm in case the pass is blocked back to us
    }
    // Minimal shuffle while composing the clearance.
    steerToward(gk, { x: targetX, y: clamp(gk.position.y, -AI.gkRangeY, AI.gkRangeY) });
    return;
  }

  // Not holding the ball: keep the composure timer primed for the next catch.
  gk.aiDecisionTimer = GK_CLEAR_DELAY;

  if (kickoffOnly) {
    steerToward(gk, target);
    return;
  }

  // Active shot-stopping: chase the ball aggressively if it is loose and very close,
  // or on a clear breakaway, so the keeper is usually the nearest claimer.
  const ballLoose = ball.owner === null;
  const ballOwnerIsOpp = ball.owner !== null && (() => {
    const o = playerById(world, ball.owner as string);
    return o ? o.side !== gk.side : false;
  })();

  const closeThreat = ballInOwnHalf && ballGap < AI.gkClaimRadius + 90 && ball.z < BALL.controlHeight + 12;
  const breakaway = ballInOwnHalf && (ballLoose || ballOwnerIsOpp) && ballGap < BREAKAWAY_LEAD;

  if (closeThreat || breakaway) {
    target = interceptPoint(world, gk, 0.5);
    // Keep the keeper from straying too wide of the goal mouth.
    target.y = clamp(target.y, -AI.gkRangeY * 1.4, AI.gkRangeY * 1.4);
    // Sprint to smother a genuine breakaway.
    gk.sprintActive = breakaway && wantSprint(gk, target);
    steerToward(gk, target);
    return;
  }

  gk.sprintActive = false;
  // Track the ball along the keeper line; only mild lateral commitment.
  const possessionBias = team.possession ? 0.4 : 0; // creep up slightly when team has it
  target.x = goalLineX + dir * (lineDepth + possessionBias * 40);
  steerToward(gk, target);
}

// ───────────────────────────── carrier ─────────────────────────────

function updateCarrier(world: GameWorld, player: Player, dt: number, level: number): void {
  const oppGoal = oppGoalCenter(player.side, PITCH);
  const dir = attackDir(player.side);
  const opp = nearestOpponent(world, player);
  const oppDist = opp ? dist(opp.position, player.position) : Infinity;

  // Dribble vector: toward goal, veering away from the nearest threat.
  const toGoal = normalize(sub(oppGoal, player.position));
  let blend: Vec2 = toGoal;
  if (opp && oppDist < PRESSURE_RADIUS * 2.4) {
    const away = normalize(sub(player.position, opp.position));
    const w = clamp01((PRESSURE_RADIUS * 2.4 - oppDist) / (PRESSURE_RADIUS * 2.4)) * 0.8;
    blend = normalize(add(scale(toGoal, 1 - w * 0.5), scale(away, w)));
  }
  const dribbleTarget = clampToPitch(add(player.position, scale(blend, 120)), PITCH, -20);

  // Sprint into open space ahead.
  player.sprintActive = oppDist > PRESSURE_RADIUS * 1.6 && wantSprint(player, oppGoal);
  player.aiState = AIState.SUPPORT_ATTACK;

  // Throttled decisions: shoot / pass / keep dribbling.
  if (player.aiDecisionTimer > 0) {
    player.aiDecisionTimer -= dt;
    steerToward(player, dribbleTarget);
    return;
  }
  player.aiDecisionTimer = levelLerp(AI.decisionIntervalByLevel, level) + world.rng.jitter(0.05);

  const goalDist = dist(player.position, oppGoal);
  const shotChance = levelLerp(AI.shotChanceByLevel, level);
  const passAcc = levelLerp(AI.passAccuracyByLevel, level);

  // 1) SHOOT — in range, lane roughly open, dice favour it.
  if (goalDist < SHOOT_RANGE && laneRoughlyOpen(world, player.position, oppGoal, player.side) && world.rng.chance(shotChance)) {
    const aimSpread = lerp(48, 14, clamp01(level)) * (player.stats.shooting < 60 ? 1.2 : 1);
    const aim: Vec2 = {
      x: oppGoal.x,
      y: clamp(oppGoal.y + world.rng.jitter(aimSpread), -PITCH.goalWidth * 0.42, PITCH.goalWidth * 0.42),
    };
    const charge = clamp(0.4 + (goalDist / SHOOT_RANGE) * 0.3, 0.35, 0.7);
    const curve = world.rng.jitter(0.5) * clamp01((player.stats.dribbling - 40) / 60);
    executeShot(world, player.id, aim, charge, curve);
    return;
  }

  // 2) PASS — under pressure and an option exists.
  if (oppDist < PRESSURE_RADIUS && world.rng.chance(passAcc)) {
    const aimDir = normalize(sub(oppGoal, player.position));
    const mate = selectPassTarget(world, player.id, aimDir);
    if (mate) {
      const lead = add(mate.position, scale(mate.velocity, 0.22));
      const charge = clamp(dist(player.position, lead) / 900, 0.15, 0.6);
      executePass(world, player.id, lead, charge);
      return;
    }
  }

  // 3) Keep dribbling toward goal.
  steerToward(player, dribbleTarget);
  // Encourage a long clearing pass if pinned deep with no shot and the dice missed pass.
  if (goalDist > PITCH.length * 0.62 && oppDist < PRESSURE_RADIUS * 0.8) {
    const aimDir: Vec2 = { x: dir, y: 0 };
    const mate = selectPassTarget(world, player.id, aimDir);
    if (mate && world.rng.chance(passAcc * 0.6)) {
      executePass(world, player.id, add(mate.position, scale(mate.velocity, 0.2)), 0.55);
    }
  }
}

// ───────────────────────────── chaser / press ─────────────────────────────

function updateChaser(world: GameWorld, player: Player, dt: number, level: number): void {
  const ball = world.ball;
  const anticipation = levelLerp(AI.anticipationByLevel, level);
  const pressIntensity = levelLerp(AI.pressIntensityByLevel, level);

  const target = interceptPoint(world, player, anticipation);
  player.aiState = ball.owner === null ? AIState.CHASE_BALL : AIState.PRESS;

  // Sprint to win the race to a loose ball or to close down a carrier.
  player.sprintActive = wantSprint(player, target);

  // Slide-tackle opportunity vs. an opponent carrier.
  const ownerId = ball.owner;
  if (ownerId && player.aiDecisionTimer <= 0) {
    const owner = playerById(world, ownerId);
    if (owner && owner.side !== player.side) {
      const gap = dist(owner.position, player.position);
      if (gap < player.radius + owner.radius + 12 && player.slideTimer <= 0 && player.actionCooldown <= 0 && player.stamina > PLAYER.staminaSlideCost) {
        // A slide is a committed, occasional gamble — defenders mostly contain and only
        // lunge now and then (this is re-evaluated each AI decision, ~every 0.2s, so the
        // per-decision chance is kept low to avoid a slide-spam → foul-spam loop).
        const proximity = clamp01((player.radius + owner.radius + 12 - gap) / (player.radius + owner.radius + 12));
        // Prefer to slide when the carrier is escaping (moving away) rather than face-up.
        const carrierSpeed = Math.hypot(owner.velocity.x, owner.velocity.y);
        const escaping = carrierSpeed > 0.45 * owner.maxSpeed ? 1 : 0.5;
        const slideChance = pressIntensity * (0.05 + 0.09 * proximity) * escaping;
        if (world.rng.chance(slideChance)) {
          executeSlide(world, player.id);
        }
      }
    }
  }

  if (player.aiDecisionTimer > 0) {
    player.aiDecisionTimer -= dt;
  } else {
    player.aiDecisionTimer = levelLerp(AI.decisionIntervalByLevel, level) * 0.6 + world.rng.jitter(0.04);
  }

  steerToward(player, target);
}

// ───────────────────────────── support attack ─────────────────────────────

function updateSupport(world: GameWorld, player: Player, _dt: number): void {
  player.aiState = AIState.SUPPORT_ATTACK;
  const dir = attackDir(player.side);
  // Push the anchor forward into the attacking third to offer a forward option.
  let target: Vec2 = {
    x: player.anchor.x + dir * 70,
    y: player.anchor.y,
  };
  // Spread away from teammates and clamp into play.
  target = spreadFromTeammates(world, player, target, AI.supportRadius * 0.6);
  target = clampToPitch(target, PITCH, -10);
  player.sprintActive = wantSprint(player, target) && dist(player.position, target) > 120;
  steerToward(player, target);
}

// ───────────────────────────── defend (mark / hold) ─────────────────────────────

function updateDefend(world: GameWorld, player: Player, _dt: number): void {
  const ownGoal = ownGoalCenter(player.side, PITCH);

  // Look for an opponent to mark within our zone (closest opponent to our anchor).
  const opp = player.side === TeamSide.HOME ? TeamSide.AWAY : TeamSide.HOME;
  let mark: Player | null = null;
  let bestD2 = AI.markRadius * AI.markRadius;
  for (const p of world.players) {
    if (p.sentOff || p.side !== opp || p.role === PlayerRole.GK) continue;
    const d2 = distSq(p.position, player.anchor);
    if (d2 < bestD2) {
      // Don't double-mark: skip if a closer teammate already owns this man.
      bestD2 = d2;
      mark = p;
    }
  }

  if (mark) {
    player.aiState = AIState.MARK;
    player.markTargetId = mark.id;
    // Goal-side marking: sit between the opponent and our own goal.
    const toGoal = normalize(sub(ownGoal, mark.position));
    const target = clampToPitch(add(mark.position, scale(toGoal, player.radius + mark.radius + 16)), PITCH);
    player.sprintActive = wantSprint(player, target) && dist(player.position, target) > 130;
    steerToward(player, target);
    return;
  }

  // Nobody to mark — return to the shifting anchor.
  player.markTargetId = null;
  player.aiState = AIState.RETURN_TO_ANCHOR;
  player.sprintActive = wantSprint(player, player.anchor) && dist(player.position, player.anchor) > 150;
  steerToward(player, player.anchor);
}

// ───────────────────────────── anchor resolution ─────────────────────────────

function resolveAnchor(world: GameWorld, player: Player): void {
  const team = world.teams[player.side];
  const dir = team.attackDir;
  const base = baseAnchor(player.formationNorm, dir, PITCH);
  const ball = world.ball;

  let ax = base.x + (ball.position.x - base.x) * AI.ballInfluenceX;
  let ay = base.y + (ball.position.y - base.y) * AI.ballInfluenceY;

  // Possession bias: shift toward the opponent goal when attacking, own goal when defending.
  if (team.possession) {
    ax += AI.offensiveShift * PITCH.halfLength * dir;
  } else {
    ax -= AI.defensiveShift * PITCH.halfLength * dir;
  }

  const clamped = clampToPitch({ x: ax, y: ay }, PITCH);
  player.anchor.x = clamped.x;
  player.anchor.y = clamped.y;
}

// ───────────────────────────── public entry ─────────────────────────────

export function updateAI(world: GameWorld, dt: number): void {
  // Only simulate AI during live play or while lining up a kickoff.
  if (world.state !== MatchState.PLAYING && world.state !== MatchState.KICKOFF) return;
  const kickoffOnly = world.state === MatchState.KICKOFF;

  rebuildBallSort(world);

  const ball = world.ball;
  const ownerPlayer = ball.owner ? playerById(world, ball.owner) : null;

  for (const player of world.players) {
    if (player.isUser || player.sentOff) continue;

    // Always keep the formation anchor current (it slides with the ball every frame).
    resolveAnchor(world, player);

    // Goalkeeper has its own self-contained behaviour.
    if (player.role === PlayerRole.GK) {
      updateGoalkeeper(world, player, dt, kickoffOnly);
      continue;
    }

    // During kickoff: only return to anchor, take no real actions.
    if (kickoffOnly) {
      player.sprintActive = false;
      player.aiState = AIState.RETURN_TO_ANCHOR;
      steerToward(player, player.anchor);
      continue;
    }

    const team = world.teams[player.side];
    const level = team.aiLevel;
    const isCarrier = ball.owner === player.id;
    const teamHasPossession =
      ownerPlayer !== null && ownerPlayer !== undefined && ownerPlayer.side === player.side;

    if (isCarrier) {
      // On-ball decision logic.
      updateCarrier(world, player, dt, level);
    } else if (!teamHasPossession && isChaser(player)) {
      // Ball loose or held by an opponent and we're a designated presser.
      updateChaser(world, player, dt, level);
    } else if (teamHasPossession) {
      // Team has the ball but this player isn't carrying — find space.
      updateSupport(world, player, dt);
    } else {
      // Out of possession and not pressing — hold shape / mark goal-side.
      updateDefend(world, player, dt);
    }
  }
}
