/**
 * The shared data contract for the entire game.
 *
 * Architecture: data-oriented. A single `GameWorld` object holds all live match state
 * as plain serialisable data. Stateless *systems* (input, physics, ai, matchController,
 * camera, particles, renderer, hud, audio) read and mutate that world each tick. Nothing
 * here imports a system, so every system can be implemented and tested in isolation.
 *
 * Coordinate convention (world space, "units" ~= decimetres):
 *   - Origin at the centre spot.
 *   - +x runs along the pitch length toward the AWAY goal; -x toward the HOME goal.
 *   - +y runs across the pitch (toward one touchline); -y toward the other.
 *   - HOME defends -x and attacks +x. AWAY is the mirror.
 *   - Ball height (`z`) is a separate scalar for lofted passes; 0 == on the ground.
 */
import type { Rng } from '@/utils/rng';

// ───────────────────────────── Geometry ─────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

// ───────────────────────────── Enums ─────────────────────────────

/** High-level match flow. The game loop gates input + system behaviour on this. */
export enum MatchState {
  KICKOFF = 'KICKOFF',
  PLAYING = 'PLAYING',
  GOAL_CELEBRATION = 'GOAL_CELEBRATION',
  FOUL = 'FOUL',
  FREE_KICK = 'FREE_KICK',
  PENALTY = 'PENALTY',
  HALF_TIME = 'HALF_TIME',
  MATCH_END = 'MATCH_END',
}

export enum TeamSide {
  HOME = 'home',
  AWAY = 'away',
}

export enum PlayerRole {
  GK = 'GK',
  DEF = 'DEF',
  MID = 'MID',
  FWD = 'FWD',
}

/** Per-agent behaviour state, driven by the AI finite state machine. */
export enum AIState {
  GOALKEEP = 'GOALKEEP',
  CHASE_BALL = 'CHASE_BALL',
  SUPPORT_ATTACK = 'SUPPORT_ATTACK',
  PRESS = 'PRESS',
  MARK = 'MARK',
  RETURN_TO_ANCHOR = 'RETURN_TO_ANCHOR',
  RECOVER = 'RECOVER',
  CELEBRATE = 'CELEBRATE',
}

export enum Rarity {
  COMMON = 'COMMON',
  RARE = 'RARE',
  EPIC = 'EPIC',
  LEGENDARY = 'LEGENDARY',
  MYTHICAL = 'MYTHICAL',
}

/** The action-button layout swaps between these two based on possession. */
export enum ControlMode {
  OFFENSIVE = 'OFFENSIVE',
  DEFENSIVE = 'DEFENSIVE',
}

// ───────────────────────────── Stats / cards ─────────────────────────────

/** Per-player attributes on a 0–100 scale; drive physics & AI competence. */
export interface PlayerStats {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
}

/** A card definition in the collectible pool (metagame). */
export interface CardDef {
  id: string;
  name: string;
  role: PlayerRole;
  rarity: Rarity;
  /** Base attributes at level 1. */
  baseStats: PlayerStats;
  nation?: string;
}

/** A card the player owns, with upgrade progress. */
export interface OwnedCard {
  defId: string;
  level: number;
  copies: number; // duplicate count collected toward the next upgrade
}

/** Static description of a rarity tier (economy + visuals). */
export interface RarityTier {
  rarity: Rarity;
  /** Post-v4.0 average base rating (see blueprint). */
  baseRating: number;
  maxLevel: number;
  color: string;
  glow: string;
  /** Duplicate copies required to advance from level i to i+1. */
  copiesPerLevel: number[];
  /** Coin cost to advance from level i to i+1. */
  coinCostPerLevel: number[];
}

// ───────────────────────────── Pitch ─────────────────────────────

export interface PitchDims {
  length: number; // along x
  width: number; // along y
  halfLength: number;
  halfWidth: number;
  goalWidth: number; // y span of the goal mouth
  goalDepth: number; // x depth of the net behind the line
  goalHeight: number; // crossbar height (for lofted balls / saves)
  penaltyBoxDepth: number; // x depth from goal line
  penaltyBoxWidth: number; // y span
  goalAreaDepth: number;
  goalAreaWidth: number;
  penaltySpotDist: number; // x distance of the spot from the goal line
  centerCircleRadius: number;
  cornerRadius: number;
}

// ───────────────────────────── Entities ─────────────────────────────

export interface Player {
  id: string;
  side: TeamSide;
  role: PlayerRole;
  number: number;
  name: string;
  rarity: Rarity;

  // Kinematics
  position: Vec2;
  velocity: Vec2;
  facing: number; // radians; heading the player is oriented toward
  radius: number; // collision/possession radius

  // Formation
  /** Normalised formation slot: x = depth (0 own goal → 1 opp goal), y = width (0..1). */
  formationNorm: Vec2;
  /** Dynamically resolved world-space home target (shifts with the ball). */
  anchor: Vec2;

  // Attributes
  stats: PlayerStats;
  maxSpeed: number; // derived from pace (units/s)

  // Live state
  stamina: number; // 0..100
  sprintActive: boolean;
  aiState: AIState;
  isUser: boolean; // currently the user-controlled player
  sentOff: boolean; // red-carded, removed from play

  // Timers (seconds)
  slideTimer: number; // > 0 while a slide tackle is in progress
  /** True once the current slide has been arbitrated for a foul (one decision per slide). */
  slideResolved: boolean;
  kickCooldown: number; // brief no-recapture window after kicking
  actionCooldown: number; // generic per-player action gate
  stunTimer: number; // knocked down after a foul/collision

  // Steering (transient): controllers (input/AI) write the desired velocity here each
  // frame; physics integrates the player toward it with accel/decel + turn limits.
  steer: Vec2;

  // AI scratch state
  aiDecisionTimer: number; // counts down; AI re-decides at 0
  aiTarget: Vec2; // current movement goal in world space
  markTargetId: string | null; // opponent being marked, if any

  // Animation
  animPhase: number; // accumulates with movement; drives the running cycle
  kickAnimTimer: number; // > 0 while a kick/leg-swing pose plays
}

export interface Ball {
  position: Vec2;
  velocity: Vec2;
  z: number; // height above the pitch (0 = ground)
  zVel: number; // vertical velocity
  spin: number; // signed; produces the Magnus curve
  radius: number;
  owner: string | null; // id of the player in possession, or null
  lastTouch: string | null; // last player to touch it (for goal attribution)
  lastTouchSide: TeamSide | null;
  /** Frames since the ball was last controlled; lets AI value loose balls. */
  looseTime: number;
}

// ───────────────────────────── Teams ─────────────────────────────

export interface KitConfig {
  primary: string; // shirt
  secondary: string; // shirt trim / pattern
  shorts: string;
  socks: string;
  accent: string; // number / detail
}

export interface TeamState {
  side: TeamSide;
  name: string;
  shortName: string;
  score: number;
  formationId: string;
  kit: KitConfig;
  teamStrength: number;
  aiLevel: number; // 0..1 difficulty knob (affects positioning, pressing, accuracy)
  isUser: boolean;
  possession: boolean;
  /** Direction this team attacks along x: +1 or -1. Flipped at half time. */
  attackDir: 1 | -1;
}

// ───────────────────────────── Camera / feel ─────────────────────────────

export interface Camera {
  position: Vec2; // world-space centre of the viewport
  target: Vec2; // where it is easing toward
  zoom: number; // world units → screen scale baseline multiplier
  targetZoom: number;
  shake: number; // current shake magnitude (decays each frame)
  offset: Vec2; // resolved per-frame shake offset (renderer reads this)
}

// ───────────────────────────── Input ─────────────────────────────

export interface ButtonInput {
  pressed: boolean; // edge: true only on the frame it goes down
  held: boolean;
  released: boolean; // edge: true only on the frame it goes up
  holdTime: number; // seconds held; on the release frame this carries the total held duration
}

export interface SwipeInput {
  active: boolean;
  start: Vec2; // screen-space
  current: Vec2;
  vector: Vec2; // current - start (screen space)
  released: boolean; // edge: true on the frame the swipe lifts
  power: number; // 0..1 normalised swipe strength on release
}

export interface JoystickVisual {
  active: boolean;
  origin: Vec2; // screen-space anchor where the thumb landed
  knob: Vec2; // screen-space clamped knob position
  radius: number; // visual radius in px
}

/**
 * The input system writes this every frame. The same three physical action buttons map to
 * pass/shoot (offensive) or switch/slide (defensive); the input system resolves the mapping
 * from `world.controlMode` and zeroes the unused pair, so consumers read semantic intent.
 */
export interface InputState {
  move: Vec2; // normalised direction; |move| <= 1
  moveMagnitude: number; // 0..1

  sprint: boolean; // held

  // Offensive button intents
  pass: ButtonInput; // mid button when in possession
  shoot: ButtonInput; // action button when in possession

  // Defensive button intents (edges)
  switchPlayer: boolean; // mid button when out of possession
  slide: boolean; // action button when out of possession

  // Set-piece gesture
  swipe: SwipeInput;

  // Visual feedback for the HUD
  joystick: JoystickVisual;

  /** True while a controller is the active input device. */
  gamepadActive: boolean;
}

// ───────────────────────────── Clock & match ─────────────────────────────

export interface MatchClock {
  simSeconds: number; // simulated match seconds, 0..durationSimSeconds
  durationSimSeconds: number; // total simulated length (e.g. 5400 = 90')
  half: 1 | 2;
  running: boolean;
  realElapsed: number; // wall-clock seconds elapsed in PLAYING state
}

export interface MatchStatsSide {
  shots: number;
  shotsOnTarget: number;
  passes: number;
  passesCompleted: number;
  tackles: number;
  fouls: number;
  possessionFrames: number;
}

export interface MatchStats {
  home: MatchStatsSide;
  away: MatchStatsSide;
}

export type SetPieceType = 'kickoff' | 'free_kick' | 'penalty' | 'goal_kick' | 'corner';

export interface SetPieceInfo {
  type: SetPieceType;
  forSide: TeamSide; // team taking the set piece
  position: Vec2; // world position of the ball for the set piece
  phase: 'setup' | 'aim' | 'strike' | 'resolve';
  /** Aiming reticle (penalties / free kicks), world space. */
  reticle: Vec2;
  reticleVel: Vec2;
  /** Goalkeeper dive direction chosen on a penalty (-1 left, 0 centre, 1 right). */
  keeperDive: number;
  timer: number;
}

export type CardColor = 'none' | 'yellow' | 'red';

export interface FoulInfo {
  position: Vec2;
  offenderId: string;
  offenderSide: TeamSide;
  victimId: string | null;
  card: CardColor;
  isPenalty: boolean;
  awardedTo: TeamSide; // team that gets the free kick / penalty
}

// ───────────────────────────── Particles / events ─────────────────────────────

export type ParticleKind =
  | 'spark'
  | 'grass'
  | 'dust'
  | 'trail'
  | 'confetti'
  | 'ring'
  | 'star'
  | 'sweat';

export interface Particle {
  kind: ParticleKind;
  position: Vec2;
  velocity: Vec2;
  z: number;
  zVel: number;
  life: number; // remaining seconds
  maxLife: number;
  size: number;
  color: string;
  rotation: number;
  rotationVel: number;
  gravity: number;
  drag: number;
  active: boolean;
}

export type GameEventType =
  | 'kick'
  | 'pass'
  | 'shot'
  | 'goal'
  | 'tackle'
  | 'foul'
  | 'whistle'
  | 'post'
  | 'save'
  | 'cheer'
  | 'switch'
  | 'bounce'
  | 'kickoff'
  | 'button';

/** Transient one-frame events. Systems push; audio/particles/camera drain; loop clears. */
export interface GameEvent {
  type: GameEventType;
  position?: Vec2;
  side?: TeamSide;
  power?: number; // 0..1 intensity (shot power, tackle force…)
  rarity?: Rarity;
  playerId?: string;
}

// ───────────────────────────── Runtime config ─────────────────────────────

export type Difficulty = 'easy' | 'normal' | 'hard' | 'legend';

export interface RuntimeConfig {
  sfxEnabled: boolean;
  musicEnabled: boolean;
  rarityVfxEnabled: boolean; // the v4.0 toggle
  screenShakeEnabled: boolean;
  difficulty: Difficulty;
  showFps: boolean;
  reducedMotion: boolean;
}

// ───────────────────────────── The World ─────────────────────────────

export interface GameWorld {
  state: MatchState;
  prevState: MatchState;
  stateTimer: number; // seconds spent in the current state

  clock: MatchClock;
  pitch: PitchDims;

  players: Player[];
  ball: Ball;
  teams: Record<TeamSide, TeamState>;

  camera: Camera;
  input: InputState;
  controlMode: ControlMode;

  userSide: TeamSide;
  activePlayerId: string; // user-controlled player

  /** Debounce window (s) after a won tackle that suppresses the action button — the
   *  documented "tackle instantly becomes shoot" fix from the blueprint. */
  actionLockTimer: number;
  /** Cooldown (s) gating manual player switching. */
  switchCooldown: number;

  particles: Particle[];
  events: GameEvent[];

  foul: FoulInfo | null;
  setPiece: SetPieceInfo | null;

  stats: MatchStats;
  config: RuntimeConfig;

  /** Global hit-stop (s). While > 0 the sim freezes for game feel; rendering continues. */
  hitStop: number;
  /** Total simulated time elapsed (s), monotonic. */
  time: number;

  /** Result banner text set when MATCH_END is reached. */
  resultText: string;

  rngSeed: number;
  /** Seeded RNG instance shared by all systems for deterministic simulation. */
  rng: Rng;
}

// ───────────────────────────── Match setup ─────────────────────────────

export interface TeamSetup {
  name: string;
  shortName: string;
  kit: KitConfig;
  formationId: string;
  /** Eleven players' stat lines, GK first. The world factory positions them. */
  squad: SquadMember[];
  aiLevel: number;
  isUser: boolean;
}

export interface SquadMember {
  name: string;
  number: number;
  role: PlayerRole;
  rarity: Rarity;
  stats: PlayerStats;
}

export interface MatchConfig {
  home: TeamSetup;
  away: TeamSetup;
  userSide: TeamSide;
  durationSimSeconds: number; // total simulated length (both halves)
  durationRealSeconds: number; // wall-clock length of the match
  seed: number;
  config: RuntimeConfig;
}

// ───────────────────────────── Formations / presets ─────────────────────────────

export interface FormationSlot {
  role: PlayerRole;
  /** Normalised: x depth 0 (own goal) → 1 (opp goal); y width 0..1 across the pitch. */
  norm: Vec2;
  label: string; // e.g. "LB", "CM", "ST"
}

export interface FormationDef {
  id: string;
  name: string; // e.g. "4-3-3"
  shape: string; // human description of the structure
  description: string; // tactical strengths (blueprint table)
  slots: FormationSlot[]; // exactly 11, GK first
  /** Country level required to unlock (progression gating). */
  unlockLevel: number;
}

export interface TeamPreset {
  id: string;
  name: string;
  shortName: string;
  kit: KitConfig;
  formationId: string;
  baseStrength: number; // nominal team strength for matchmaking
}

// ───────────────────────────── Metagame profile ─────────────────────────────

export interface ProfileStats {
  wins: number;
  losses: number;
  draws: number;
  goalsFor: number;
  goalsAgainst: number;
  matchesPlayed: number;
}

export interface Profile {
  version: number;
  name: string;
  avatar: string; // emoji or key
  countryLevel: number;
  xp: number;
  coins: number;
  gems: number;
  cards: OwnedCard[];
  activeRoster: string[]; // 11 owned-card defIds, GK first
  formationId: string;
  kit: KitConfig;
  victoryPathTier: number;
  stats: ProfileStats;
}

export interface PackDef {
  id: string;
  name: string;
  description: string;
  cost: number;
  currency: 'coins' | 'gems';
  cardCount: number;
  /** Drop-rate weights per rarity (the v4.0 transparency requirement). */
  dropRates: Record<Rarity, number>;
  /** Country level required to access this pack. */
  unlockLevel: number;
  accent: string;
}

export interface StadiumDef {
  id: string;
  name: string;
  entryFee: number; // coins
  prize: number; // coins on win
  minStrength: number; // matchmaking gate
  packId: string; // pack awarded on win
  unlockLevel: number;
}

// ───────────────────────────── System service interfaces ─────────────────────────────
// Concrete implementations live in src/systems and src/render. These shapes let the game
// loop hold them generically.

export interface InputSystem {
  attach(): void;
  detach(): void;
  /** Sample DOM/keyboard/gamepad state into `world.input` for this frame. */
  sample(world: GameWorld, dt: number): void;
  /** Notify the system of the current CSS pixel size + device-pixel-ratio of the canvas. */
  resize(cssWidth: number, cssHeight: number): void;
}

export interface AudioSystem {
  /** Must be called from a user-gesture handler to unlock WebAudio. */
  resume(): Promise<void>;
  setEnabled(sfx: boolean, music: boolean): void;
  /** Drain `world.events`, trigger sounds, update ambient crowd. */
  update(world: GameWorld, dt: number): void;
  /** Fire a one-off UI sound (menus). */
  ui(name: 'click' | 'whoosh' | 'reward' | 'error' | 'pack'): void;
}

export interface Renderer {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(world: GameWorld): void;
}
