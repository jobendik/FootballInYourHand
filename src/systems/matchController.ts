/**
 * Match state machine: clock, kickoff, goals, out-of-bounds restarts, fouls → free
 * kick / penalty, half time, full time.
 *
 * Data-oriented: this module never sets `ball.owner` directly. Possession only changes
 * through physics (`giveBallTo` / `kickBall`). Transient feedback is pushed onto
 * `world.events`; the game loop drains and clears those each frame.
 *
 * Arcade flow (blueprint): throw-ins, goal kicks and corners are instant quick restarts
 * with no dedicated state — the ball is simply repositioned and handed to the appropriate
 * player so play resumes immediately. Free kicks are likewise simplified to a quick restart
 * (see assumptions). Penalties are a full aim/dive minigame.
 *
 * Cross-frame flow that has no home on the GameWorld contract (which this module must not
 * modify) is kept in module-scoped variables below. They are keyed to a match identity so a
 * new match resets them cleanly (see assumptions).
 */
import type { GameWorld, Player, Vec2, SetPieceInfo } from '@/core/types';
import { MatchState, TeamSide, PlayerRole } from '@/core/types';
import { MATCH, PITCH, AI, SHOT } from '@/core/constants';
import {
  baseAnchor,
  oppGoalCenter,
  withinGoalMouth,
  attackingPenaltySpot,
  clampToPitch,
} from '@/utils/pitch';
import { clone, clamp, dist, normalize } from '@/utils/math';
import { giveBallTo, kickBall, playerById, nearestPlayerToPoint } from '@/systems/physics';

// ───────────────────────────── Module-scoped flow state ─────────────────────────────
//
// These persist across frames but have no field on the GameWorld data contract. They are
// reset whenever a brand-new match is detected (a fresh world identity, see `syncMatch`).

/** Which side kicked off the first half — so HALF_TIME can alternate. */
let firstHalfKickoffSide: TeamSide | null = null;
/** Which side should take the NEXT kickoff (set when entering KICKOFF). */
let pendingKickoffSide: TeamSide = TeamSide.HOME;
/** Side that conceded the most recent goal (kicks off after the celebration). */
let lastConcedingSide: TeamSide = TeamSide.AWAY;
/** Edge-detect the user's shoot button for penalty striking. */
let prevShootHeld = false;
/** Identity of the match these module variables belong to. */
let matchIdentity: GameWorld | null = null;

/** Reset module flow state when a new match world is observed. */
function syncMatch(world: GameWorld): void {
  if (matchIdentity !== world) {
    matchIdentity = world;
    firstHalfKickoffSide = null;
    pendingKickoffSide = TeamSide.HOME;
    lastConcedingSide = TeamSide.AWAY;
    prevShootHeld = false;
  }
}

// ───────────────────────────── Helpers ─────────────────────────────

function transition(world: GameWorld, newState: MatchState): void {
  world.prevState = world.state;
  world.state = newState;
  world.stateTimer = 0;
}

function other(side: TeamSide): TeamSide {
  return side === TeamSide.HOME ? TeamSide.AWAY : TeamSide.HOME;
}

/** Resolve which side currently attacks toward the goal line at the given x sign. */
function attackerTowardGoalLine(world: GameWorld, positiveX: boolean): TeamSide {
  const homeDir = world.teams[TeamSide.HOME].attackDir;
  // HOME attacks toward +x when its attackDir is +1.
  const homeAttacksPositive = homeDir === 1;
  if (positiveX) return homeAttacksPositive ? TeamSide.HOME : TeamSide.AWAY;
  return homeAttacksPositive ? TeamSide.AWAY : TeamSide.HOME;
}

/** Find a side's goalkeeper (first GK on the pitch), else any non-sent-off player. */
function findGoalkeeper(world: GameWorld, side: TeamSide): Player | null {
  for (const p of world.players) {
    if (p.side === side && p.role === PlayerRole.GK && !p.sentOff) return p;
  }
  for (const p of world.players) {
    if (p.side === side && !p.sentOff) return p;
  }
  return null;
}

/**
 * The kicking side's central forward/mid nearest the centre spot — used to take a kickoff
 * or a quick restart from the middle.
 */
function kickoffTaker(world: GameWorld, side: TeamSide): Player | null {
  const center: Vec2 = { x: 0, y: 0 };
  let best: Player | null = null;
  let bestScore = Infinity;
  for (const p of world.players) {
    if (p.side !== side || p.sentOff) continue;
    if (p.role === PlayerRole.GK) continue;
    const rolePenalty = p.role === PlayerRole.FWD ? 0 : p.role === PlayerRole.MID ? 40 : 160;
    const score = dist(p.position, center) + rolePenalty;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Reset a single player to a quiescent standing state at a fresh anchor. */
function resetPlayer(world: GameWorld, p: Player): void {
  const dir = world.teams[p.side].attackDir;
  const anchor = baseAnchor(p.formationNorm, dir, PITCH);
  p.position = clone(anchor);
  p.anchor = clone(anchor);
  p.aiTarget = clone(anchor);
  p.velocity = { x: 0, y: 0 };
  p.steer = { x: 0, y: 0 };
  p.facing = dir > 0 ? 0 : Math.PI;
  p.slideTimer = 0;
  p.stunTimer = 0;
  p.kickCooldown = 0;
  p.actionCooldown = 0;
  p.kickAnimTimer = 0;
  p.sprintActive = false;
  p.markTargetId = null;
  p.aiDecisionTimer = 0;
}

/** Reset the ball to a dead position with no height/spin. Owner handled by caller. */
function deadBallAt(world: GameWorld, pos: Vec2): void {
  world.ball.position = clone(pos);
  world.ball.velocity = { x: 0, y: 0 };
  world.ball.z = 0;
  world.ball.zVel = 0;
  world.ball.spin = 0;
}

/** Small distance the kickoff takers stand back from the centre spot. */
const KICKOFF_BACK = 20;

// ───────────────────────────── Kickoff ─────────────────────────────

export function setupKickoff(world: GameWorld, forSide: TeamSide): void {
  syncMatch(world);
  world.foul = null;
  world.setPiece = null;

  // Reset every player to their formation anchor in a clean standing state.
  for (const p of world.players) {
    resetPlayer(world, p);
  }

  // Place the ball dead on the centre spot, no owner.
  deadBallAt(world, { x: 0, y: 0 });
  giveBallTo(world, null);
  world.ball.lastTouch = null;
  world.ball.lastTouchSide = null;
  world.ball.looseTime = 0;

  // Pull two of the kicking side's central players up to/just behind the centre spot.
  const dir = world.teams[forSide].attackDir;
  const takers: Player[] = [];
  for (const p of world.players) {
    if (p.side !== forSide || p.sentOff || p.role === PlayerRole.GK) continue;
    takers.push(p);
  }
  takers.sort((a, b) => dist(a.position, { x: 0, y: 0 }) - dist(b.position, { x: 0, y: 0 }));
  const first = takers[0];
  const second = takers[1];
  if (first) {
    first.position = { x: -dir * (KICKOFF_BACK * 0.2), y: -PITCH.centerCircleRadius * 0.18 };
    first.anchor = clone(first.position);
    first.aiTarget = clone(first.position);
  }
  if (second) {
    second.position = { x: -dir * KICKOFF_BACK, y: PITCH.centerCircleRadius * 0.22 };
    second.anchor = clone(second.position);
    second.aiTarget = clone(second.position);
  }

  // Record the first-half kickoff side so HALF_TIME can alternate.
  if (world.clock.half === 1 && firstHalfKickoffSide === null) {
    firstHalfKickoffSide = forSide;
  }
  pendingKickoffSide = forSide;

  transition(world, MatchState.KICKOFF);
}

// ───────────────────────────── Restart helpers ─────────────────────────────

/** Quick goal kick to `defending`: ball in their goal area, given to their keeper. */
function goalKickRestart(world: GameWorld, defending: TeamSide): void {
  const dir = world.teams[defending].attackDir; // direction `defending` attacks
  const lineX = -dir * PITCH.halfLength; // goal line they defend
  const spot: Vec2 = { x: lineX + dir * PITCH.goalAreaDepth * 0.5, y: 0 };
  deadBallAt(world, spot);
  const gk = findGoalkeeper(world, defending);
  if (gk) {
    gk.position = clone(spot);
    gk.velocity = { x: 0, y: 0 };
    giveBallTo(world, gk.id);
  } else {
    giveBallTo(world, null);
  }
}

/** Quick corner to `attacking`: ball at the near corner, given to their nearest attacker. */
function cornerRestart(world: GameWorld, attacking: TeamSide, ySign: number): void {
  const dir = world.teams[attacking].attackDir; // attacking toward this goal line
  const lineX = dir * PITCH.halfLength;
  const inset = PITCH.cornerRadius + 4;
  const corner: Vec2 = {
    x: lineX - dir * inset,
    y: (ySign >= 0 ? 1 : -1) * (PITCH.halfWidth - inset),
  };
  deadBallAt(world, corner);
  const taker = nearestPlayerToPoint(world, corner, attacking);
  if (taker) {
    taker.position = clone(corner);
    taker.velocity = { x: 0, y: 0 };
    giveBallTo(world, taker.id);
  } else {
    giveBallTo(world, null);
  }
}

/** Quick throw-in / kick-in to `toSide`: ball clamped to the touchline, given to nearest. */
function kickInRestart(world: GameWorld, toSide: TeamSide): void {
  const ySign = world.ball.position.y >= 0 ? 1 : -1;
  const spot: Vec2 = {
    x: clamp(world.ball.position.x, -PITCH.halfLength + 2, PITCH.halfLength - 2),
    y: ySign * PITCH.halfWidth,
  };
  deadBallAt(world, spot);
  const taker = nearestPlayerToPoint(world, spot, toSide);
  if (taker) {
    taker.position = clone(spot);
    taker.velocity = { x: 0, y: 0 };
    giveBallTo(world, taker.id);
  } else {
    giveBallTo(world, null);
  }
}

// ───────────────────────────── Goal detection ─────────────────────────────

/**
 * Returns the scoring side if the ball has fully crossed a goal line within the mouth and
 * under the bar this frame, else null. HOME attacks +x (first half): crossing the +x line
 * inside the mouth is conceded by whoever defends it.
 */
function detectGoal(world: GameWorld): TeamSide | null {
  const b = world.ball;
  const inMouth = withinGoalMouth(b.position.y, PITCH) && b.z < PITCH.goalHeight;
  if (!inMouth) return null;
  if (b.position.x > PITCH.halfLength) {
    // The team attacking toward +x scores here.
    return attackerTowardGoalLine(world, true);
  }
  if (b.position.x < -PITCH.halfLength) {
    return attackerTowardGoalLine(world, false);
  }
  return null;
}

/** Apply a scored goal: bump score & stats, push events. Does not change state. */
function scoreGoal(world: GameWorld, scoringSide: TeamSide): void {
  world.teams[scoringSide].score += 1;
  const stats = world.stats[scoringSide];
  stats.shots += 1;
  stats.shotsOnTarget += 1;
  world.events.push({ type: 'goal', side: scoringSide, position: clone(world.ball.position) });
  world.events.push({ type: 'cheer', side: scoringSide });
}

// ───────────────────────────── Penalty minigame ─────────────────────────────

function aiLevelOf(world: GameWorld, side: TeamSide): number {
  return clamp(world.teams[side].aiLevel, 0, 1);
}

/** Clamp a reticle to the attacked goal mouth at the attacked goal line. */
function clampReticleToMouth(forSide: TeamSide, ret: Vec2): void {
  const goal = oppGoalCenter(forSide, PITCH);
  ret.x = goal.x; // pin to the goal line being attacked
  const halfMouth = (PITCH.goalWidth / 2) * 0.95;
  ret.y = clamp(ret.y, -halfMouth, halfMouth);
}

/** User keeper dive read from swipe vector (preferred) or joystick x. */
function userPickDive(world: GameWorld): number {
  const sw = world.input.swipe;
  if (sw.active || sw.released) {
    if (Math.abs(sw.vector.x) > 12) return sw.vector.x > 0 ? 1 : -1;
    if (sw.vector.y > 18) return 0; // downward swipe → stay/centre
  }
  // The goal mouth spans the world-Y axis (screen left/right), so read move.y — matching the
  // attacker's reticle nudge and the aimSide test in resolvePenalty.
  const my = world.input.move.y;
  if (my > 0.35) return 1;
  if (my < -0.35) return -1;
  return 0;
}

/** AI keeper dive guess; sharper at higher aiLevel, otherwise a coin-flip. */
function aiGuessDive(world: GameWorld, sp: SetPieceInfo, keeperSide: TeamSide): number {
  const halfMouth = PITCH.goalWidth / 2;
  const third = halfMouth * 0.34;
  const trueSide = sp.reticle.y > third ? 1 : sp.reticle.y < -third ? -1 : 0;
  const skill = aiLevelOf(world, keeperSide);
  const pCorrect = 0.34 + skill * 0.42;
  if (world.rng.next() < pCorrect) return trueSide;
  const options = [-1, 0, 1].filter((d) => d !== trueSide);
  return world.rng.pick(options);
}

function resolvePenalty(world: GameWorld): void {
  const sp = world.setPiece;
  if (!sp) return;
  const attacker = sp.forSide;
  const defender = other(attacker);

  const taker = kickoffTaker(world, attacker) ?? nearestPlayerToPoint(world, sp.position, attacker);
  const halfMouth = PITCH.goalWidth / 2;

  // Aimed y with inaccuracy scaled down by the attacker's competence.
  const acc =
    AI.passAccuracyByLevel[0] +
    (AI.passAccuracyByLevel[1] - AI.passAccuracyByLevel[0]) * aiLevelOf(world, attacker);
  const spread = (1 - acc) * halfMouth * 0.45;
  const aimY = clamp(sp.reticle.y + world.rng.jitter(spread), -halfMouth * 0.99, halfMouth * 0.99);
  const goalX = oppGoalCenter(attacker, PITCH).x;
  const aimPoint: Vec2 = { x: goalX, y: aimY };

  const third = halfMouth * 0.34;
  const aimSide = aimY > third ? 1 : aimY < -third ? -1 : 0;
  const saved = sp.keeperDive === aimSide;

  // Visual: send the ball toward the aim point so the strike reads on screen.
  if (taker) {
    const d = normalize({ x: aimPoint.x - taker.position.x, y: aimPoint.y - taker.position.y });
    const speed = (SHOT.speedMin + SHOT.speedMax) * 0.5;
    const loft = saved ? 0 : SHOT.minLoft * 0.5;
    kickBall(world, taker.id, d.x * speed, d.y * speed, loft, 0);
  }

  world.events.push({ type: 'shot', position: clone(aimPoint), side: attacker, power: 0.9 });

  if (saved) {
    world.events.push({ type: 'save', side: defender, position: clone(aimPoint) });
    goalKickRestart(world, defender);
    world.setPiece = null;
    world.foul = null;
    world.clock.running = true;
    transition(world, MatchState.PLAYING);
  } else {
    scoreGoal(world, attacker);
    lastConcedingSide = defender;
    world.setPiece = null;
    world.foul = null;
    transition(world, MatchState.GOAL_CELEBRATION);
  }
}

function updatePenalty(world: GameWorld, dt: number): void {
  const sp = world.setPiece;
  if (!sp) {
    transition(world, MatchState.PLAYING);
    return;
  }
  const attacker = sp.forSide;
  const defender = other(attacker);
  sp.timer += dt;

  switch (sp.phase) {
    case 'setup': {
      // Penalties begin in 'aim'; normalise any stray 'setup'.
      sp.phase = 'aim';
      break;
    }
    case 'aim': {
      if (attacker === world.userSide) {
        // User aims by nudging the reticle with the joystick.
        sp.reticle.y += world.input.move.y * 220 * dt;
        clampReticleToMouth(attacker, sp.reticle);
        // Strike on a shoot press, on a shoot release after a brief minimum aim time, or on
        // a hard timeout so the penalty can never stall.
        const released = prevShootHeld && !world.input.shoot.held;
        if (world.input.shoot.pressed || (released && sp.timer > 0.2) || sp.timer >= 4.0) {
          sp.keeperDive = aiGuessDive(world, sp, defender);
          sp.phase = 'strike';
          sp.timer = 0;
        }
        prevShootHeld = world.input.shoot.held;
      } else {
        // AI taker: a small wind-up, then choose a reticle and strike.
        if (sp.timer >= 1.2) {
          const reach = (PITCH.goalWidth / 2) * 0.9;
          const skill = aiLevelOf(world, attacker);
          const target =
            world.rng.next() < 0.18 + skill * 0.2 ? 0 : world.rng.chance(0.5) ? 1 : -1;
          sp.reticle.y = target * reach + world.rng.jitter((1 - skill) * reach * 0.4);
          clampReticleToMouth(attacker, sp.reticle);
          sp.keeperDive =
            defender === world.userSide ? userPickDive(world) : aiGuessDive(world, sp, defender);
          sp.phase = 'strike';
          sp.timer = 0;
        }
      }
      break;
    }
    case 'strike': {
      // A user keeper gets a last-instant dive read off swipe/move.
      if (defender === world.userSide && sp.timer < 0.12) {
        const picked = userPickDive(world);
        if (picked !== 0) sp.keeperDive = picked;
      }
      if (sp.timer >= 0.35) {
        sp.phase = 'resolve';
        sp.timer = 0;
        resolvePenalty(world);
      }
      break;
    }
    case 'resolve':
    default:
      // resolvePenalty already transitioned away; nothing to do.
      break;
  }
}

/** Position the keeper on its line and the taker on the spot for a penalty. */
function setupPenaltyEntities(world: GameWorld, attacker: TeamSide, spot: Vec2): void {
  const defender = other(attacker);
  const goal = oppGoalCenter(attacker, PITCH);
  const dir = world.teams[attacker].attackDir;

  const gk = findGoalkeeper(world, defender);
  if (gk) {
    gk.position = { x: goal.x - dir * 4, y: 0 };
    gk.velocity = { x: 0, y: 0 };
    gk.steer = { x: 0, y: 0 };
  }
  const taker = kickoffTaker(world, attacker) ?? nearestPlayerToPoint(world, spot, attacker);
  if (taker) {
    taker.position = { x: spot.x - dir * 24, y: 0 };
    taker.velocity = { x: 0, y: 0 };
    taker.steer = { x: 0, y: 0 };
  }
  // Keep everyone else clamped to the pitch and still.
  for (const p of world.players) {
    if (p.role === PlayerRole.GK) continue;
    if (taker && p.id === taker.id) continue;
    p.position = clampToPitch(p.position, PITCH);
    p.velocity = { x: 0, y: 0 };
    p.steer = { x: 0, y: 0 };
  }
  deadBallAt(world, spot);
  giveBallTo(world, null);
  prevShootHeld = world.input.shoot.held;
}

// ───────────────────────────── Main update ─────────────────────────────

export function updateMatch(world: GameWorld, dt: number): void {
  syncMatch(world);
  world.stateTimer += dt;

  switch (world.state) {
    case MatchState.KICKOFF: {
      world.clock.running = false;
      if (world.stateTimer >= MATCH.kickoffDelay) {
        const kicking = pendingKickoffSide;
        const taker =
          kickoffTaker(world, kicking) ?? nearestPlayerToPoint(world, { x: 0, y: 0 }, kicking);
        if (taker) giveBallTo(world, taker.id);
        world.events.push({ type: 'whistle' });
        world.events.push({ type: 'kickoff', side: kicking });
        world.clock.running = true;
        transition(world, MatchState.PLAYING);
      }
      break;
    }

    case MatchState.PLAYING: {
      world.clock.running = true;

      // ── Clock ──
      const rate = world.clock.durationSimSeconds / MATCH.durationRealSeconds;
      world.clock.simSeconds += dt * rate;
      world.clock.realElapsed += dt;

      // ── Possession stat ──
      if (world.ball.owner) {
        const owner = playerById(world, world.ball.owner);
        if (owner) world.stats[owner.side].possessionFrames += 1;
      }

      // ── Foul awarded? ──
      if (world.foul !== null) {
        const foul = world.foul;
        world.events.push({ type: 'whistle' });
        if (foul.isPenalty) {
          const spot = attackingPenaltySpot(foul.awardedTo, PITCH);
          world.setPiece = {
            type: 'penalty',
            forSide: foul.awardedTo,
            position: clone(spot),
            phase: 'aim',
            reticle: clone(oppGoalCenter(foul.awardedTo, PITCH)),
            reticleVel: { x: 0, y: 0 },
            keeperDive: 0,
            timer: 0,
          };
          setupPenaltyEntities(world, foul.awardedTo, spot);
          transition(world, MatchState.PENALTY);
        } else {
          world.setPiece = {
            type: 'free_kick',
            forSide: foul.awardedTo,
            position: clone(foul.position),
            phase: 'setup',
            reticle: clone(foul.position),
            reticleVel: { x: 0, y: 0 },
            keeperDive: 0,
            timer: 0,
          };
          transition(world, MatchState.FREE_KICK);
        }
        // Leave world.foul set; cleared on the next restart / kickoff.
        break;
      }

      // ── Goal? (ball already moved by physics this frame) ──
      const scoringSide = detectGoal(world);
      if (scoringSide !== null) {
        scoreGoal(world, scoringSide);
        lastConcedingSide = other(scoringSide);
        world.ball.velocity = { x: 0, y: 0 };
        world.ball.zVel = 0;
        transition(world, MatchState.GOAL_CELEBRATION);
        break;
      }

      // ── Half / full time ──
      const halfLen = world.clock.durationSimSeconds / 2;
      if (world.clock.half === 1 && world.clock.simSeconds >= halfLen) {
        transition(world, MatchState.HALF_TIME);
        break;
      }
      if (world.clock.half === 2 && world.clock.simSeconds >= world.clock.durationSimSeconds) {
        world.clock.simSeconds = world.clock.durationSimSeconds;
        const hs = world.teams[TeamSide.HOME].score;
        const as = world.teams[TeamSide.AWAY].score;
        world.resultText = hs === as ? 'FULL TIME · DRAW' : 'FULL TIME';
        transition(world, MatchState.MATCH_END);
        break;
      }

      // ── Out of bounds (only if no goal) ──
      const b = world.ball;
      if (Math.abs(b.position.x) > PITCH.halfLength) {
        const positiveX = b.position.x > 0;
        const attackingThisGoal = attackerTowardGoalLine(world, positiveX);
        const defendingThisGoal = other(attackingThisGoal);
        if (b.lastTouchSide === attackingThisGoal) {
          // Attacker put it behind → goal kick to the defending side.
          goalKickRestart(world, defendingThisGoal);
        } else {
          // Defender (or no/own touch) put it behind → corner to the attacking side.
          cornerRestart(world, attackingThisGoal, b.position.y >= 0 ? 1 : -1);
        }
        break; // quick restart; stay in PLAYING
      }
      if (Math.abs(b.position.y) > PITCH.halfWidth) {
        const lastSide = b.lastTouchSide ?? world.userSide;
        kickInRestart(world, other(lastSide));
        break; // quick restart; stay in PLAYING
      }
      break;
    }

    case MatchState.GOAL_CELEBRATION: {
      world.clock.running = false;
      if (world.stateTimer >= MATCH.goalCelebration) {
        setupKickoff(world, lastConcedingSide);
      }
      break;
    }

    case MatchState.HALF_TIME: {
      world.clock.running = false;
      if (world.stateTimer >= MATCH.halfTimePause) {
        world.clock.half = 2;
        world.clock.simSeconds = world.clock.durationSimSeconds / 2;
        // NOTE: ends are intentionally NOT switched at half time. The renderer always draws
        // each goal at a fixed end and the user always attacks "up" the screen; keeping
        // `team.attackDir` constant means the static pitch helpers used by the AI and the
        // action layer agree with it in both halves (arcade convention).
        // The side that did NOT kick off the first half kicks off the second.
        const first = firstHalfKickoffSide ?? TeamSide.HOME;
        setupKickoff(world, other(first));
      }
      break;
    }

    case MatchState.FREE_KICK: {
      // SIMPLIFIED quick free kick (see assumptions).
      world.clock.running = false;
      if (world.stateTimer >= MATCH.foulPause) {
        const sp = world.setPiece;
        const spot = sp ? sp.position : world.foul ? world.foul.position : { x: 0, y: 0 };
        const awarded = sp ? sp.forSide : world.foul ? world.foul.awardedTo : world.userSide;
        deadBallAt(world, spot);
        const taker = nearestPlayerToPoint(world, spot, awarded);
        if (taker) {
          taker.position = clone(spot);
          taker.velocity = { x: 0, y: 0 };
          giveBallTo(world, taker.id);
        } else {
          giveBallTo(world, null);
        }
        world.foul = null;
        world.setPiece = null;
        world.clock.running = true;
        transition(world, MatchState.PLAYING);
      }
      break;
    }

    case MatchState.PENALTY: {
      world.clock.running = false;
      updatePenalty(world, dt);
      break;
    }

    case MatchState.FOUL: {
      // Transient: a foul is surfaced via world.foul during PLAYING. If we ever land here,
      // route straight back into play so the state machine never stalls.
      transition(world, MatchState.PLAYING);
      break;
    }

    case MatchState.MATCH_END: {
      world.clock.running = false;
      // UI handles the result banner; nothing else to do.
      break;
    }

    default:
      // Exhaustive over MatchState; nothing else to handle.
      break;
  }
}
