/**
 * Central tuning table. Every gameplay magic-number lives here so the feel of the game can
 * be adjusted in one place. World units are roughly decimetres (1 unit ≈ 0.1 m); the pitch
 * is ~105 m × 68 m. Speeds/accelerations are arcade-tuned, not realistic.
 */
import type { PitchDims, RarityTier } from './types';
import { Rarity } from './types';

// ───────────────────────────── Loop / timing ─────────────────────────────

/** Physics runs on a fixed timestep for determinism; the loop accumulates real time. */
export const FIXED_DT = 1 / 60;
export const MAX_FRAME_DT = 0.1; // clamp huge tab-switch deltas
export const MAX_SUBSTEPS = 5;

// ───────────────────────────── Match ─────────────────────────────

export const MATCH = {
  /** Total simulated minutes shown on the clock. */
  durationSimSeconds: 90 * 60, // 5400
  /** Real wall-clock length (short, high-tempo mobile match). */
  durationRealSeconds: 150,
  kickoffDelay: 1.4,
  goalCelebration: 3.2,
  foulPause: 1.0,
  halfTimePause: 2.6,
  matchEndPause: 4.0,
};

// ───────────────────────────── Pitch geometry ─────────────────────────────

export const PITCH: PitchDims = (() => {
  const length = 1050;
  const width = 680;
  return {
    length,
    width,
    halfLength: length / 2,
    halfWidth: width / 2,
    goalWidth: 110,
    goalDepth: 28,
    goalHeight: 38,
    penaltyBoxDepth: 165,
    penaltyBoxWidth: 403,
    goalAreaDepth: 55,
    goalAreaWidth: 183,
    penaltySpotDist: 110,
    centerCircleRadius: 91,
    cornerRadius: 10,
  };
})();

/** Margin of grass drawn outside the touchlines. */
export const PITCH_MARGIN = 70;

// ───────────────────────────── Players ─────────────────────────────

export const PLAYER = {
  radius: 13,
  /** pace 0..100 maps linearly into this top-speed band (units/s). */
  speedMin: 132,
  speedMax: 246,
  sprintMultiplier: 1.4,
  /** Acceleration toward the desired velocity (units/s²) — snappy, arcade. */
  accel: 1050,
  decel: 1400,
  turnRate: 13, // rad/s
  // Stamina (applied globally & fairly to AI and player alike — blueprint fix)
  staminaMax: 100,
  staminaSprintDrain: 7.5, // per second sprinting
  staminaSlideCost: 9,
  staminaRegen: 6, // per second when not sprinting
  staminaMinToSprint: 6,
  /** Below this stamina, top speed is scaled down toward `lowStaminaSpeedMul`. */
  lowStaminaThreshold: 25,
  lowStaminaSpeedMul: 0.78,
  // Animation
  runCycleScale: 0.045,
  kickAnimTime: 0.26,
};

/** Derive a player's top speed (units/s, sprint off) from the pace attribute. */
export function maxSpeedFromPace(pace: number): number {
  return PLAYER.speedMin + (PLAYER.speedMax - PLAYER.speedMin) * (Math.max(0, Math.min(100, pace)) / 100);
}

// ───────────────────────────── Ball ─────────────────────────────

export const BALL = {
  radius: 5,
  /** Linear deceleration on the ground (units/s²). */
  groundDecel: 165,
  /** Multiplicative air drag per second applied to horizontal velocity while airborne. */
  airDrag: 0.4,
  gravity: 760, // units/s² pulling height down
  restitution: 0.52, // vertical bounce energy retained
  rollRestitution: 0.7, // horizontal energy kept on a bounce
  spinDecay: 1.6, // per second
  /** Magnus sideways acceleration per unit (spin × speed) — produces curve. */
  magnus: 0.0016,
  maxSpeed: 1000,
  /** A ball above this height cannot be captured at the feet. */
  controlHeight: 26,
};

// ───────────────────────────── Possession ─────────────────────────────

export const POSSESSION = {
  captureRadius: 19, // distance at which a player can take the ball
  /** The dribbler keeps the ball this far ahead of their feet, in facing dir. */
  dribbleOffset: 16,
  dribbleSnap: 0.0001, // dampVec smoothing (lower = snappier)
  /** No-recapture window after the owner kicks (s) so passes/shots actually leave. */
  kickCooldown: 0.16,
  /** A non-owner that just lost the ball can't immediately re-grab (s). */
  stealImmunity: 0.25,
  /** Loose-ball capture needs relative speed below this to "trap" cleanly. */
  trapSpeed: 520,
};

// ───────────────────────────── Passing ─────────────────────────────

export const PASS = {
  groundSpeedMin: 330,
  groundSpeedMax: 560,
  /** Extra speed scaled by distance to target so long passes arrive in time. */
  distanceSpeedGain: 0.55,
  maxChargeTime: 0.6, // hold time for a fully lofted ball
  loftZVelMax: 360, // vertical launch velocity at full charge
  loftForwardBoost: 1.12,
  /** Lead the receiver by velocity × this. */
  leadFactor: 0.28,
  /** Dot-product gate: candidate must be within this cone of the aim to be preferred. */
  aimConeDot: 0.2,
  /** Weighting of distance vs. aim alignment in target selection. */
  aimWeight: 1.0,
  distanceWeight: 0.0016,
  /** Forward-progress bonus so the picker doesn't favour cross-field/backward options. */
  forwardBias: 0.4,
  inaccuracyBase: 0.12, // radians spread at passing 0
};

// ───────────────────────────── Shooting ─────────────────────────────

export const SHOT = {
  speedMin: 540,
  speedMax: 920,
  maxChargeTime: 0.7,
  /** Spread (radians) reduced by the shooting attribute. */
  inaccuracyBase: 0.16,
  /** Sideways curve from directional input + dribbling, applied as spin. */
  curveMax: 2.4,
  /** Loft from charge so shots can rise toward the top corners. */
  loftZVelMax: 230,
  minLoft: 35,
  postRadius: 7,
};

// ───────────────────────────── Tackling / fouls ─────────────────────────────

export const TACKLE = {
  slideDuration: 0.55,
  slideRecover: 0.35, // sliding player is grounded a touch after
  slideLungeSpeed: 235, // burst added in facing dir at slide start
  slideStealRadius: 26,
  standingStealRadius: 21,
  standingStealChanceBase: 0.45, // modified by defending vs dribbling
  /** Probabilistic referee (blueprint): base foul chance on contact, then card rolls. */
  foulBaseChance: 0.34,
  foulFromBehindBonus: 0.34, // tackling into the back of a player
  foulHighSpeedBonus: 0.22,
  foulCleanBallReduction: 0.6, // got the ball first → much less likely a foul
  yellowChance: 0.32, // of fouls
  redChance: 0.05, // of fouls (serious foul play)
  stunDuration: 0.9, // victim knocked down
  offenderRecover: 0.5,
};

// ───────────────────────────── Control / switching ─────────────────────────────

export const CONTROL = {
  /** Suppress the action button briefly after winning the ball (the blueprint UX fix). */
  actionLockAfterTackle: 0.25,
  switchCooldown: 0.22,
  /** Weighting to favour defenders between the ball and the user's goal when switching. */
  switchGoalsideBias: 0.6,
};

// ───────────────────────────── AI ─────────────────────────────

export const AI = {
  /** How strongly the team's shape slides toward the ball (0..1). */
  ballInfluenceX: 0.34, // along length
  ballInfluenceY: 0.42, // across width
  /** Defensive compression toward own goal when out of possession. */
  defensiveShift: 0.16,
  offensiveShift: 0.14,
  anchorReturnSmooth: 0.0008, // dampVec smoothing for returning to anchor
  /** Only the N closest outfielders actively contest a loose/owned ball. */
  chasers: 2,
  pressRadius: 230,
  supportRadius: 320,
  markRadius: 180,
  /** Base reaction delay (s) scaled down by difficulty. */
  reactionBase: 0.26,
  /** Difficulty knobs interpolate these by aiLevel (0..1). Fair: no speed/stamina cheats. */
  passAccuracyByLevel: [0.62, 0.92], // [easy, legend]
  shotChanceByLevel: [0.35, 0.85],
  pressIntensityByLevel: [0.45, 1.0],
  anticipationByLevel: [0.2, 0.95],
  decisionIntervalByLevel: [0.5, 0.16], // s between AI decisions
  // Goalkeeper
  gkLineDepth: 36, // how far off the line the keeper sits
  gkRangeY: 120, // lateral coverage from centre
  gkReactSpeed: 215,
  gkDiveSpeed: 360,
  gkClaimRadius: 30,
};

// ───────────────────────────── Camera ─────────────────────────────

export const CAMERA = {
  smooth: 0.0009, // dampVec smoothing (lower = tighter follow)
  zoomSmooth: 0.02,
  baseZoom: 1.0,
  /** Look ahead toward where the ball is heading. */
  lookAhead: 0.22,
  shakeDecay: 6.5, // per second
  shakeMaxOffset: 22,
  shotShake: 9,
  postShake: 16,
  goalShake: 13,
  tackleShake: 6,
  /** Hit-stop durations (s) for game feel. */
  hitStopTackle: 0.06,
  hitStopGoal: 0.12,
  hitStopPost: 0.05,
};

// ───────────────────────────── Particles ─────────────────────────────

export const PARTICLES = {
  max: 400,
  slideGrassCount: 14,
  goalConfettiCount: 70,
  kickDustCount: 6,
  rarityTrailRate: 90, // particles/s while a high-rarity player carries/charges
};

// ───────────────────────────── HUD layout ─────────────────────────────

export const HUD = {
  joystickRadius: 78,
  joystickKnobRadius: 34,
  joystickDeadzone: 0.12,
  buttonRadius: 46,
  buttonGap: 18,
  margin: 28,
  safeAreaPad: 12,
  opacity: 0.82,
};

// ───────────────────────────── Rarity tiers (economy) ─────────────────────────────
// Post-v4.0 base ratings from the blueprint. Higher tiers have larger stat ceilings.

export const RARITY_TIERS: Record<Rarity, RarityTier> = {
  [Rarity.COMMON]: {
    rarity: Rarity.COMMON,
    baseRating: 10,
    maxLevel: 5,
    color: '#9aa7b4',
    glow: 'rgba(154,167,180,0.0)',
    copiesPerLevel: [2, 4, 8, 16, 30],
    coinCostPerLevel: [50, 120, 280, 600, 1200],
  },
  [Rarity.RARE]: {
    rarity: Rarity.RARE,
    baseRating: 19,
    maxLevel: 6,
    color: '#56b3ff',
    glow: 'rgba(86,179,255,0.0)',
    copiesPerLevel: [2, 4, 8, 16, 28, 50],
    coinCostPerLevel: [80, 200, 450, 950, 1900, 3600],
  },
  [Rarity.EPIC]: {
    rarity: Rarity.EPIC,
    baseRating: 28,
    maxLevel: 7,
    color: '#b06bff',
    glow: 'rgba(176,107,255,0.35)',
    copiesPerLevel: [2, 4, 8, 14, 24, 40, 64],
    coinCostPerLevel: [150, 360, 800, 1700, 3300, 6000, 10500],
  },
  [Rarity.LEGENDARY]: {
    rarity: Rarity.LEGENDARY,
    baseRating: 50,
    maxLevel: 8,
    color: '#ffb800',
    glow: 'rgba(255,184,0,0.5)',
    copiesPerLevel: [2, 3, 6, 10, 18, 30, 48, 75],
    coinCostPerLevel: [300, 700, 1500, 3000, 5800, 10000, 17000, 28000],
  },
  [Rarity.MYTHICAL]: {
    rarity: Rarity.MYTHICAL,
    baseRating: 61,
    maxLevel: 9,
    color: '#ff4d6d',
    glow: 'rgba(255,77,109,0.6)',
    copiesPerLevel: [1, 2, 4, 8, 14, 24, 38, 58, 88],
    coinCostPerLevel: [500, 1100, 2300, 4600, 8800, 15000, 25000, 40000, 64000],
  },
};

// ───────────────────────────── Progression ─────────────────────────────

export const PROGRESSION = {
  /** XP needed to go from level L to L+1 = base * L^exp. */
  xpBase: 220,
  xpExp: 1.35,
  maxLevel: 60,
  /** XP granted per card upgrade & per match result. */
  xpPerUpgrade: 40,
  xpWin: 120,
  xpDraw: 60,
  xpLoss: 30,
  coinsWinBase: 350,
  coinsDraw: 120,
  coinsLoss: 40,
};

// ───────────────────────────── Default runtime config ─────────────────────────────

export const DEFAULT_CONFIG = {
  sfxEnabled: true,
  musicEnabled: true,
  rarityVfxEnabled: true,
  screenShakeEnabled: true,
  difficulty: 'normal' as const,
  showFps: false,
  reducedMotion: false,
};

/** Difficulty → AI level (0..1) used to interpolate the AI knobs above. */
export const DIFFICULTY_AI_LEVEL: Record<string, number> = {
  easy: 0.2,
  normal: 0.5,
  hard: 0.78,
  legend: 1.0,
};
