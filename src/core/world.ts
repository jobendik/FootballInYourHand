/**
 * GameWorld factory. Turns a declarative MatchConfig (two team setups + options) into a
 * fully-populated, ready-to-tick world: 22 players placed at their formation anchors, a ball
 * on the centre spot, clock, camera, input, stats. The game loop (core/game.ts) drives it.
 */
import {
  AIState,
  ControlMode,
  MatchState,
  PlayerRole,
  TeamSide,
  type GameWorld,
  type MatchConfig,
  type Player,
  type SquadMember,
  type TeamSetup,
  type TeamState,
} from './types';
import { HUD, PLAYER, maxSpeedFromPace, PITCH } from './constants';
import { Rng } from '@/utils/rng';
import { baseAnchor, attackDir } from '@/utils/pitch';
import { clone } from '@/utils/math';
import { getFormation } from '@/data/formations';

function makePlayer(
  member: SquadMember,
  slotNorm: { x: number; y: number },
  role: PlayerRole,
  side: TeamSide,
  index: number,
): Player {
  const dir = attackDir(side);
  const anchor = baseAnchor(slotNorm, dir, PITCH);
  return {
    id: `${side}-${index}`,
    side,
    role,
    number: member.number,
    name: member.name,
    rarity: member.rarity,
    position: clone(anchor),
    velocity: { x: 0, y: 0 },
    facing: dir > 0 ? 0 : Math.PI, // face the opponent goal
    radius: PLAYER.radius,
    formationNorm: { x: slotNorm.x, y: slotNorm.y },
    anchor: clone(anchor),
    stats: { ...member.stats },
    maxSpeed: maxSpeedFromPace(member.stats.pace),
    stamina: PLAYER.staminaMax,
    sprintActive: false,
    aiState: AIState.RETURN_TO_ANCHOR,
    isUser: false,
    sentOff: false,
    slideTimer: 0,
    kickCooldown: 0,
    actionCooldown: 0,
    stunTimer: 0,
    steer: { x: 0, y: 0 },
    aiDecisionTimer: 0,
    aiTarget: clone(anchor),
    markTargetId: null,
    animPhase: 0,
    kickAnimTimer: 0,
  };
}

function buildTeamPlayers(setup: TeamSetup, side: TeamSide): Player[] {
  const formation = getFormation(setup.formationId);
  const players: Player[] = [];
  for (let i = 0; i < 11; i++) {
    const slot = formation.slots[i] ?? formation.slots[formation.slots.length - 1]!;
    const member = setup.squad[i];
    if (!member) continue;
    // The slot's role is authoritative for positioning; keep the member's nominal role too.
    players.push(makePlayer(member, slot.norm, slot.role, side, i));
  }
  return players;
}

function buildTeamState(setup: TeamSetup, side: TeamSide): TeamState {
  let strength = 0;
  for (const m of setup.squad) {
    const s = m.stats;
    // Round each player's rating then sum — matches economy.teamStrength so the number shown
    // in the menu equals the in-match team strength exactly.
    strength += Math.round((s.pace + s.shooting + s.passing + s.dribbling + s.defending + s.physical) / 6);
  }
  return {
    side,
    name: setup.name,
    shortName: setup.shortName,
    score: 0,
    formationId: setup.formationId,
    kit: { ...setup.kit },
    teamStrength: Math.round(strength),
    aiLevel: setup.aiLevel,
    isUser: setup.isUser,
    possession: false,
    attackDir: attackDir(side),
  };
}

function emptyStatsSide() {
  return {
    shots: 0,
    shotsOnTarget: 0,
    passes: 0,
    passesCompleted: 0,
    tackles: 0,
    fouls: 0,
    possessionFrames: 0,
  };
}

/** Pick the initial user-controlled player: a central forward, else a midfielder. */
function pickInitialUserPlayer(players: Player[]): Player {
  const fwd = players.find((p) => p.role === PlayerRole.FWD);
  if (fwd) return fwd;
  const mid = players.find((p) => p.role === PlayerRole.MID);
  if (mid) return mid;
  return players.find((p) => p.role !== PlayerRole.GK) ?? players[0]!;
}

export function createWorld(config: MatchConfig): GameWorld {
  const rng = new Rng(config.seed);

  const homePlayers = buildTeamPlayers(config.home, TeamSide.HOME);
  const awayPlayers = buildTeamPlayers(config.away, TeamSide.AWAY);
  const players = [...homePlayers, ...awayPlayers];

  const userPlayers = config.userSide === TeamSide.HOME ? homePlayers : awayPlayers;
  const active = pickInitialUserPlayer(userPlayers);
  active.isUser = true;

  const world: GameWorld = {
    state: MatchState.KICKOFF,
    prevState: MatchState.KICKOFF,
    stateTimer: 0,

    clock: {
      simSeconds: 0,
      durationSimSeconds: config.durationSimSeconds,
      half: 1,
      running: true,
      realElapsed: 0,
    },
    pitch: PITCH,

    players,
    ball: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      z: 0,
      zVel: 0,
      spin: 0,
      radius: 5,
      owner: null,
      lastTouch: null,
      lastTouchSide: null,
      looseTime: 0,
    },
    teams: {
      [TeamSide.HOME]: buildTeamState(config.home, TeamSide.HOME),
      [TeamSide.AWAY]: buildTeamState(config.away, TeamSide.AWAY),
    },

    camera: {
      position: { x: 0, y: 0 },
      target: { x: 0, y: 0 },
      zoom: 1,
      targetZoom: 1,
      shake: 0,
      offset: { x: 0, y: 0 },
    },

    input: {
      move: { x: 0, y: 0 },
      moveMagnitude: 0,
      sprint: false,
      pass: { pressed: false, held: false, released: false, holdTime: 0 },
      shoot: { pressed: false, held: false, released: false, holdTime: 0 },
      switchPlayer: false,
      slide: false,
      swipe: {
        active: false,
        start: { x: 0, y: 0 },
        current: { x: 0, y: 0 },
        vector: { x: 0, y: 0 },
        released: false,
        power: 0,
      },
      joystick: { active: false, origin: { x: 0, y: 0 }, knob: { x: 0, y: 0 }, radius: HUD.joystickRadius },
      gamepadActive: false,
    },
    controlMode: ControlMode.OFFENSIVE,

    userSide: config.userSide,
    activePlayerId: active.id,

    actionLockTimer: 0,
    switchCooldown: 0,

    particles: [],
    events: [],

    foul: null,
    setPiece: null,

    stats: { home: emptyStatsSide(), away: emptyStatsSide() },
    config: { ...config.config },

    hitStop: 0,
    time: 0,
    resultText: '',

    rngSeed: config.seed,
    rng,
  };

  return world;
}
