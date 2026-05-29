/**
 * Metagame data: opponent presets, pack loot tables, the Victory Path stadium tiers, and a
 * deterministic squad generator used to spin up scaled AI opponents.
 *
 * Everything is fictional — no real club, country, or player names. All randomness in
 * {@link generateSquad} flows through the passed {@link Rng} so a given seed reproduces the
 * exact same squad (matchmaking + replays stay deterministic).
 */
import type {
  TeamPreset,
  PackDef,
  StadiumDef,
  SquadMember,
  PlayerStats,
  FormationSlot,
} from '@/core/types';
import { Rarity, PlayerRole } from '@/core/types';
import { RARITY_TIERS } from '@/core/constants';
import { clamp } from '@/utils/math';
import type { Rng } from '@/utils/rng';
import { getFormation } from '@/data/formations';

// ───────────────────────────── Team presets ─────────────────────────────
// Invented clubs & national sides spanning the matchmaking strength band (380 → 980). Kits
// are picked to be mutually distinct on the pitch (no two presets share a primary colour
// family next to a similar one in the same strength band).

export const TEAM_PRESETS: TeamPreset[] = [
  {
    id: 'tp-meadow-rovers',
    name: 'Meadow Rovers',
    shortName: 'MRV',
    kit: { primary: '#7bc043', secondary: '#ffffff', shorts: '#2f6b1e', socks: '#7bc043', accent: '#1c3a12' },
    formationId: '4-4-2',
    baseStrength: 380,
  },
  {
    id: 'tp-harbor-gulls',
    name: 'Harbor Gulls',
    shortName: 'HGL',
    kit: { primary: '#e8eef2', secondary: '#3a6ea5', shorts: '#3a6ea5', socks: '#e8eef2', accent: '#1f3c5a' },
    formationId: '4-1-4-1',
    baseStrength: 440,
  },
  {
    id: 'tp-clay-diggers',
    name: 'Clay Diggers',
    shortName: 'CLY',
    kit: { primary: '#c0622d', secondary: '#3a2a1c', shorts: '#3a2a1c', socks: '#c0622d', accent: '#f0d9b5' },
    formationId: '4-4-2',
    baseStrength: 510,
  },
  {
    id: 'tp-verde-union',
    name: 'Verde Union',
    shortName: 'VRD',
    kit: { primary: '#0f8a6b', secondary: '#0a2e25', shorts: '#0a2e25', socks: '#0f8a6b', accent: '#f2c94c' },
    formationId: '4-2-3-1',
    baseStrength: 560,
  },
  {
    id: 'tp-iron-foxes',
    name: 'Iron Foxes',
    shortName: 'IRN',
    kit: { primary: '#5a5f66', secondary: '#d94f30', shorts: '#2c2f33', socks: '#5a5f66', accent: '#d94f30' },
    formationId: '4-4-2-diamond',
    baseStrength: 620,
  },
  {
    id: 'tp-azure-lancers',
    name: 'Azure Lancers',
    shortName: 'AZL',
    kit: { primary: '#1f6feb', secondary: '#0b1f3a', shorts: '#0b1f3a', socks: '#1f6feb', accent: '#e6f0ff' },
    formationId: '4-3-3',
    baseStrength: 680,
  },
  {
    id: 'tp-crimson-larks',
    name: 'Crimson Larks',
    shortName: 'CRL',
    kit: { primary: '#b51b2e', secondary: '#2b0a10', shorts: '#2b0a10', socks: '#b51b2e', accent: '#f4d35e' },
    formationId: '3-5-2',
    baseStrength: 730,
  },
  {
    id: 'tp-violet-saints',
    name: 'Violet Saints',
    shortName: 'VLT',
    kit: { primary: '#7a3cc4', secondary: '#1e0f33', shorts: '#1e0f33', socks: '#7a3cc4', accent: '#e8d8ff' },
    formationId: '4-2-3-1',
    baseStrength: 780,
  },
  {
    id: 'tp-golden-stags',
    name: 'Golden Stags',
    shortName: 'GST',
    kit: { primary: '#e0a516', secondary: '#1c1305', shorts: '#1c1305', socks: '#e0a516', accent: '#fff3c4' },
    formationId: '4-3-3',
    baseStrength: 830,
  },
  {
    id: 'tp-onyx-vanguard',
    name: 'Onyx Vanguard',
    shortName: 'ONX',
    kit: { primary: '#15171b', secondary: '#00d1b2', shorts: '#15171b', socks: '#00d1b2', accent: '#00d1b2' },
    formationId: '4-1-4-1',
    baseStrength: 880,
  },
  {
    id: 'tp-aurora-celestials',
    name: 'Aurora Celestials',
    shortName: 'AUR',
    kit: { primary: '#12d6df', secondary: '#101a33', shorts: '#101a33', socks: '#12d6df', accent: '#f9f871' },
    formationId: '3-3-3',
    baseStrength: 930,
  },
  {
    id: 'tp-eclipse-titans',
    name: 'Eclipse Titans',
    shortName: 'ECL',
    kit: { primary: '#2a0f3a', secondary: '#ff2e63', shorts: '#160820', socks: '#ff2e63', accent: '#ffd6e7' },
    formationId: '4-2-3-1',
    baseStrength: 980,
  },
];

// ───────────────────────────── Packs ─────────────────────────────
// dropRates are RELATIVE weights per rarity (transparency requirement, v4.0): higher tiers
// have genuinely better Legendary/Mythical odds. Weights need not sum to anything special;
// the pack-opening code normalises them.

function rates(
  common: number,
  rare: number,
  epic: number,
  legendary: number,
  mythical: number,
): Record<Rarity, number> {
  return {
    [Rarity.COMMON]: common,
    [Rarity.RARE]: rare,
    [Rarity.EPIC]: epic,
    [Rarity.LEGENDARY]: legendary,
    [Rarity.MYTHICAL]: mythical,
  };
}

export const PACKS: PackDef[] = [
  {
    id: 'starter',
    name: 'Starter Pack',
    description: 'A free welcome bundle of squad fillers to get your first eleven on the pitch.',
    cost: 0,
    currency: 'coins',
    cardCount: 11,
    dropRates: rates(80, 18, 2, 0, 0),
    unlockLevel: 1,
    accent: '#9aa7b4',
  },
  {
    id: 'bronze',
    name: 'Bronze Pack',
    description: 'Affordable everyday pulls. Mostly Common with a fair chance at a Rare.',
    cost: 750,
    currency: 'coins',
    cardCount: 5,
    dropRates: rates(64, 30, 5.5, 0.5, 0),
    unlockLevel: 1,
    accent: '#b08d57',
  },
  {
    id: 'silver',
    name: 'Silver Pack',
    description: 'Solid mid-tier value. Strong Rare core with a real shot at an Epic.',
    cost: 2200,
    currency: 'coins',
    dropRates: rates(28, 48, 20, 3.5, 0.5),
    cardCount: 5,
    unlockLevel: 4,
    accent: '#c8d0d8',
  },
  {
    id: 'gold',
    name: 'Gold Pack',
    description: 'Premium pulls weighted toward Epic, with meaningful Legendary odds.',
    cost: 5500,
    currency: 'coins',
    cardCount: 5,
    dropRates: rates(6, 34, 44, 14, 2),
    unlockLevel: 8,
    accent: '#ffb800',
  },
  {
    id: 'legendary',
    name: 'Legendary Pack',
    description: 'Gem-only elite pack. Guaranteed high-end pulls with true Mythical odds.',
    cost: 240,
    currency: 'gems',
    cardCount: 4,
    dropRates: rates(0, 6, 30, 50, 14),
    unlockLevel: 14,
    accent: '#ff4d6d',
  },
];

// ───────────────────────────── Stadiums (Victory Path) ─────────────────────────────
// Rising tiers: each costs more to enter, pays a larger prize on a win, gates on team
// strength, and awards a better pack. The Victory Path tier directly shapes the loot table
// the player can earn (blueprint).

export const STADIUMS: StadiumDef[] = [
  {
    id: 'st-sunday-park',
    name: 'Sunday Park',
    entryFee: 0,
    prize: 350,
    minStrength: 0,
    packId: 'bronze',
    unlockLevel: 1,
  },
  {
    id: 'st-borough-ground',
    name: 'Borough Ground',
    entryFee: 200,
    prize: 700,
    minStrength: 460,
    packId: 'bronze',
    unlockLevel: 3,
  },
  {
    id: 'st-riverside-bowl',
    name: 'Riverside Bowl',
    entryFee: 600,
    prize: 1800,
    minStrength: 580,
    packId: 'silver',
    unlockLevel: 6,
  },
  {
    id: 'st-summit-dome',
    name: 'Summit Dome',
    entryFee: 1500,
    prize: 4200,
    minStrength: 700,
    packId: 'silver',
    unlockLevel: 10,
  },
  {
    id: 'st-coliseum-prime',
    name: 'Coliseum Prime',
    entryFee: 3500,
    prize: 9500,
    minStrength: 830,
    packId: 'gold',
    unlockLevel: 14,
  },
  {
    id: 'st-celestial-arena',
    name: 'Celestial Arena',
    entryFee: 8000,
    prize: 22000,
    minStrength: 930,
    packId: 'gold',
    unlockLevel: 20,
  },
];

// ───────────────────────────── Squad generation ─────────────────────────────

/** Invented first/last name pools for procedurally generated opponents. */
const FIRST_NAMES = [
  'Mateo', 'Luca', 'Diego', 'Kai', 'Niko', 'Andre', 'Bruno', 'Felix', 'Omar', 'Theo',
  'Rafa', 'Yuto', 'Soren', 'Dejan', 'Marek', 'Pavel', 'Ilan', 'Tariq', 'Enzo', 'Ravi',
  'Idris', 'Sami', 'Kofi', 'Joaq', 'Milo', 'Aron', 'Cato', 'Reza', 'Noa', 'Eli',
];

const LAST_NAMES = [
  'Vargas', 'Holt', 'Mensah', 'Okafor', 'Petrov', 'Castel', 'Renard', 'Dahl', 'Vincze', 'Sato',
  'Moreno', 'Falk', 'Adeyemi', 'Korhonen', 'Brandt', 'Silva', 'Novak', 'Iqbal', 'Lund', 'Reyes',
  'Bauer', 'Costa', 'Haddad', 'Volkov', 'Marin', 'Engel', 'Cruz', 'Larsen', 'Tan', 'Osei',
];

/**
 * Role-relative stat multipliers. Each role boosts the attributes it cares about and trims
 * the rest so a generated player "shape" reads correctly (a GK is a wall, a FWD is electric).
 * Multipliers are applied around the per-player average, then re-balanced so the player's
 * mean stays close to that average (keeping the squad's total near `targetStrength`).
 */
const ROLE_WEIGHTS: Record<PlayerRole, PlayerStats> = {
  [PlayerRole.GK]: { pace: 0.82, shooting: 0.55, passing: 0.9, dribbling: 0.78, defending: 1.28, physical: 1.22 },
  [PlayerRole.DEF]: { pace: 0.96, shooting: 0.72, passing: 0.94, dribbling: 0.86, defending: 1.26, physical: 1.18 },
  [PlayerRole.MID]: { pace: 0.98, shooting: 0.96, passing: 1.22, dribbling: 1.18, defending: 0.96, physical: 0.96 },
  [PlayerRole.FWD]: { pace: 1.2, shooting: 1.24, passing: 0.94, dribbling: 1.18, defending: 0.66, physical: 0.94 },
};

const STAT_KEYS: (keyof PlayerStats)[] = [
  'pace',
  'shooting',
  'passing',
  'dribbling',
  'defending',
  'physical',
];

/** Mean of a stat line. */
function statAverage(s: PlayerStats): number {
  let sum = 0;
  for (const k of STAT_KEYS) sum += s[k];
  return sum / STAT_KEYS.length;
}

/**
 * Pick the rarity tier whose post-v4.0 base rating best brackets the supplied player average.
 * Higher averages climb into the higher tiers; thresholds sit at the midpoints between the
 * tier base ratings so assignment is monotonic and deterministic.
 */
function rarityForAverage(avg: number): Rarity {
  const order: Rarity[] = [Rarity.COMMON, Rarity.RARE, Rarity.EPIC, Rarity.LEGENDARY, Rarity.MYTHICAL];
  // Gameplay stat scale (see cards spec) is roughly: COMMON ~55, RARE ~64, EPIC ~72,
  // LEGENDARY ~82, MYTHICAL ~91. Use ascending cutoffs derived from those bands.
  const cutoffs: { rarity: Rarity; max: number }[] = [
    { rarity: Rarity.COMMON, max: 59 },
    { rarity: Rarity.RARE, max: 67 },
    { rarity: Rarity.EPIC, max: 77 },
    { rarity: Rarity.LEGENDARY, max: 87 },
    { rarity: Rarity.MYTHICAL, max: Infinity },
  ];
  for (const c of cutoffs) {
    if (avg <= c.max) return c.rarity;
  }
  return order[order.length - 1] as Rarity;
}

/**
 * Build one player's stat line centred on `avg` with the given role weighting plus seeded
 * jitter. The weighting redistributes emphasis without shifting the overall mean far, so the
 * squad total stays anchored to `targetStrength`. All stats clamp to 1..99.
 */
function buildStats(role: PlayerRole, avg: number, rng: Rng): PlayerStats {
  const w = ROLE_WEIGHTS[role];
  // Normalise the weights so their mean is 1 — applying them then leaves the stat mean ≈ avg.
  let wSum = 0;
  for (const k of STAT_KEYS) wSum += w[k];
  const wMean = wSum / STAT_KEYS.length;

  const out = {} as PlayerStats;
  for (const k of STAT_KEYS) {
    const shaped = avg * (w[k] / wMean);
    // Per-stat jitter scaled to the average so weak squads vary less in absolute terms.
    const jitter = rng.gaussian(0, Math.max(2.5, avg * 0.08));
    out[k] = Math.round(clamp(shaped + jitter, 1, 99));
  }
  return out;
}

/**
 * Generate a deterministic 11-player squad whose aggregate strength sits near
 * `targetStrength`. Roles come from the requested formation's slots (GK first); numbers run
 * 1..11 with the keeper wearing 1. Names are drawn from internal pools via `rng`, and each
 * player's rarity follows from their resulting average stat.
 */
export function generateSquad(targetStrength: number, formationId: string, rng: Rng): SquadMember[] {
  const formation = getFormation(formationId);
  const slots: FormationSlot[] = formation.slots;

  // Target mean stat per player. The on-pitch scale is 1..99; clamp so extreme matchmaking
  // values still produce sane teams.
  const perPlayerAvg = clamp(targetStrength / slots.length, 8, 98);

  const usedNumbers = new Set<number>([1]); // GK reserved as #1
  const squad: SquadMember[] = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] as FormationSlot;
    const role = slot.role;

    // Slight role-based bias to the target average: attackers a touch flashier, keepers a
    // touch lower on raw average (their value is concentrated in two stats). Net effect on
    // the squad total is small and symmetric across roles.
    let roleAvgBias = 0;
    switch (role) {
      case PlayerRole.GK:
        roleAvgBias = -1.5;
        break;
      case PlayerRole.DEF:
        roleAvgBias = 0;
        break;
      case PlayerRole.MID:
        roleAvgBias = 0.5;
        break;
      case PlayerRole.FWD:
        roleAvgBias = 1.0;
        break;
      default:
        roleAvgBias = 0;
        break;
    }

    const slotAvg = clamp(perPlayerAvg + roleAvgBias, 1, 99);
    const stats = buildStats(role, slotAvg, rng);
    const avg = statAverage(stats);
    const rarity = rarityForAverage(avg);

    // Shirt number: keeper is 1; everyone else takes the lowest free 2..11, but pick from a
    // small random window so squads don't all read identically. Falls back to first free.
    let number: number;
    if (role === PlayerRole.GK && !squad.some((m) => m.role === PlayerRole.GK)) {
      number = 1;
    } else {
      const candidates: number[] = [];
      for (let n = 2; n <= 11; n++) if (!usedNumbers.has(n)) candidates.push(n);
      number = candidates.length > 0 ? (rng.pick(candidates) as number) : i + 1;
      usedNumbers.add(number);
    }

    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);

    squad.push({
      name: `${first} ${last}`,
      number,
      role,
      rarity,
      stats,
    });
  }

  return squad;
}

/** Re-exported tier metadata so callers styling generated squads need only one import. */
export const SQUAD_RARITY_TIERS = RARITY_TIERS;
