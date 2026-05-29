/**
 * The collectible card pool (metagame).
 *
 * ~72 invented footballers — no real names, no licensed data — spread across the five
 * rarity tiers and the four pitch roles so a complete eleven can be fielded at any tier.
 * Stats are HAND-AUTHORED by formula: a per-rarity centre is shaped by a per-role profile,
 * then nudged by a small deterministic variation table so cards feel distinct. There is NO
 * randomness at module load — every value is computed from fixed arrays and indices, so the
 * pool is identical on every boot (mirrors the determinism guarantees of the simulation).
 *
 * Stat scale (PlayerStats, 0..100), targeted gameplay averages per the brief:
 *   COMMON ≈ 50-60 · RARE ≈ 60-68 · EPIC ≈ 68-76 · LEGENDARY ≈ 78-86 · MYTHICAL ≈ 88-95.
 * Role shaping: GK high defending/physical + low shooting; DEF high defending/physical;
 * MID high passing/dribbling; FWD high pace/shooting/dribbling.
 */
import type { CardDef, PlayerStats } from '@/core/types';
import { PlayerRole, Rarity } from '@/core/types';

// ───────────────────────────── Invented name pools ─────────────────────────────
// Plausible footballer-style first/last names. Indexed deterministically (no RNG) so a
// given card id always resolves to the same display name across builds.

const FIRST_NAMES: readonly string[] = [
  'Marek', 'Tobias', 'Diego', 'Kenji', 'Aurelio', 'Lasse', 'Bruno', 'Idris',
  'Felipe', 'Niko', 'Theo', 'Adnan', 'Casper', 'Renzo', 'Yusuf', 'Mateo',
  'Stefan', 'Olu', 'Vincent', 'Hugo', 'Damir', 'Pablo', 'Eero', 'Tariq',
  'Lucas', 'Ravi', 'Emilio', 'Soren', 'Andrei', 'Kwame', 'Joaquin', 'Bastian',
  'Milan', 'Otto', 'Rafael', 'Sami', 'Viktor', 'Dario', 'Noah', 'Karim',
  'Esteban', 'Linus', 'Goran', 'Ibrahim', 'Cristian', 'Aleksi', 'Mauro', 'Dane',
  'Florian', 'Junior', 'Tonio', 'Erling', 'Salah', 'Bohdan', 'Cael', 'Remy',
  'Janko', 'Ousmane', 'Tomas', 'Aron', 'Massimo', 'Kofi', 'Nando', 'Levi',
  'Pietro', 'Selim', 'Drago', 'Amadou', 'Felix', 'Romeo', 'Kazu', 'Sten',
];

const LAST_NAMES: readonly string[] = [
  'Kovac', 'Halvorsen', 'Moreno', 'Tanaka', 'Bianchi', 'Lindqvist', 'Almeida', 'Okonkwo',
  'Cardoso', 'Virtanen', 'Bergmann', 'Hadid', 'Sorensen', 'Ferraro', 'Demir', 'Vega',
  'Novak', 'Adeyemi', 'Dubois', 'Santos', 'Petrovic', 'Reyes', 'Makinen', 'Mansour',
  'Oliveira', 'Sharma', 'Costa', 'Aaltonen', 'Popescu', 'Mensah', 'Herrera', 'Schmidt',
  'Horvat', 'Lindgren', 'Pereira', 'Karlsson', 'Ivanov', 'Marchetti', 'Bakker', 'Benali',
  'Castillo', 'Norberg', 'Markovic', 'Cisse', 'Romero', 'Nieminen', 'Conti', 'Whitlock',
  'Brandt', 'Da Silva', 'Esposito', 'Solberg', 'El Amrani', 'Shevchuk', 'Donovan', 'Laurent',
  'Babic', 'Diallo', 'Vasquez', 'Magnusson', 'Greco', 'Asante', 'Galvao', 'Falk',
  'Russo', 'Yilmaz', 'Jovic', 'Traore', 'Wenger', 'Lombardi', 'Sasaki', 'Lund',
];

const NATIONS: readonly string[] = [
  'Valoria', 'Norvik', 'Castalia', 'Aterra', 'Mirosa', 'Sundholm', 'Tavola', 'Zamora',
  'Brevia', 'Korelia', 'Eldoria', 'Marwen', 'Estria', 'Volantis', 'Granadia', 'Kaeland',
  'Solmar', 'Ardenne', 'Tirenza', 'Helmark', 'Cadova', 'Nyssa', 'Portava', 'Lytheria',
];

// ───────────────────────────── Stat modelling ─────────────────────────────

/** Per-rarity centre rating (the average a "typical" card of that tier lands near). */
const RARITY_CENTER: Record<Rarity, number> = {
  [Rarity.COMMON]: 55,
  [Rarity.RARE]: 64,
  [Rarity.EPIC]: 72,
  [Rarity.LEGENDARY]: 82,
  [Rarity.MYTHICAL]: 91,
};

/**
 * Per-role offsets applied to the rarity centre, one per stat. These encode the role
 * identity (a GK's defending sits well above its rarity centre; its shooting well below).
 */
const ROLE_PROFILE: Record<PlayerRole, PlayerStats> = {
  [PlayerRole.GK]: { pace: -6, shooting: -26, passing: -4, dribbling: -10, defending: 14, physical: 11 },
  [PlayerRole.DEF]: { pace: 0, shooting: -14, passing: -2, dribbling: -6, defending: 14, physical: 10 },
  [PlayerRole.MID]: { pace: 2, shooting: 0, passing: 12, dribbling: 9, defending: -2, physical: -1 },
  [PlayerRole.FWD]: { pace: 11, shooting: 13, passing: -3, dribbling: 10, defending: -16, physical: -1 },
};

/**
 * Deterministic per-card variation. Six small signed deltas (one per stat) drawn from a
 * fixed table by the card's slot index, so two cards of the same rarity+role still differ.
 * Sums to roughly zero per row to keep the targeted averages intact.
 */
const VARIATION: readonly PlayerStats[] = [
  { pace: 3, shooting: -2, passing: 1, dribbling: 2, defending: -2, physical: -2 },
  { pace: -3, shooting: 3, passing: -1, dribbling: -2, defending: 2, physical: 1 },
  { pace: 1, shooting: 1, passing: 4, dribbling: -1, defending: -3, physical: -2 },
  { pace: -2, shooting: -1, passing: -3, dribbling: 3, defending: 1, physical: 2 },
  { pace: 4, shooting: 2, passing: -2, dribbling: 1, defending: -3, physical: -2 },
  { pace: -4, shooting: -2, passing: 2, dribbling: -1, defending: 4, physical: 1 },
  { pace: 2, shooting: 4, passing: -1, dribbling: 2, defending: -4, physical: -3 },
  { pace: -1, shooting: -3, passing: 3, dribbling: -2, defending: 1, physical: 2 },
];

const clampStat = (v: number): number => Math.max(1, Math.min(99, Math.round(v)));

function buildStats(rarity: Rarity, role: PlayerRole, variationIndex: number): PlayerStats {
  const center = RARITY_CENTER[rarity];
  const profile = ROLE_PROFILE[role];
  const v = VARIATION[variationIndex % VARIATION.length] as PlayerStats;
  return {
    pace: clampStat(center + profile.pace + v.pace),
    shooting: clampStat(center + profile.shooting + v.shooting),
    passing: clampStat(center + profile.passing + v.passing),
    dribbling: clampStat(center + profile.dribbling + v.dribbling),
    defending: clampStat(center + profile.defending + v.defending),
    physical: clampStat(center + profile.physical + v.physical),
  };
}

// ───────────────────────────── Pool composition ─────────────────────────────

/** Role counts per rarity. Always >= 2 GK and several DEF/MID/FWD so a squad fits. */
interface RoleCounts {
  GK: number;
  DEF: number;
  MID: number;
  FWD: number;
}

const RARITY_PLAN: Record<Rarity, RoleCounts> = {
  // COMMON ~18
  [Rarity.COMMON]: { GK: 2, DEF: 6, MID: 6, FWD: 4 },
  // RARE ~18
  [Rarity.RARE]: { GK: 2, DEF: 6, MID: 6, FWD: 4 },
  // EPIC ~16
  [Rarity.EPIC]: { GK: 2, DEF: 5, MID: 5, FWD: 4 },
  // LEGENDARY ~12
  [Rarity.LEGENDARY]: { GK: 2, DEF: 4, MID: 3, FWD: 3 },
  // MYTHICAL ~8
  [Rarity.MYTHICAL]: { GK: 2, DEF: 2, MID: 2, FWD: 2 },
};

/** Short id token per rarity, used to build stable ids like 'c-myth-fw-2'. */
const RARITY_TOKEN: Record<Rarity, string> = {
  [Rarity.COMMON]: 'com',
  [Rarity.RARE]: 'rare',
  [Rarity.EPIC]: 'epic',
  [Rarity.LEGENDARY]: 'leg',
  [Rarity.MYTHICAL]: 'myth',
};

const ROLE_TOKEN: Record<PlayerRole, string> = {
  [PlayerRole.GK]: 'gk',
  [PlayerRole.DEF]: 'df',
  [PlayerRole.MID]: 'mf',
  [PlayerRole.FWD]: 'fw',
};

/** Build order of rarities and the roles within each, for deterministic name striding. */
const RARITY_ORDER: readonly Rarity[] = [
  Rarity.COMMON,
  Rarity.RARE,
  Rarity.EPIC,
  Rarity.LEGENDARY,
  Rarity.MYTHICAL,
];

const ROLE_ORDER: readonly PlayerRole[] = [
  PlayerRole.GK,
  PlayerRole.DEF,
  PlayerRole.MID,
  PlayerRole.FWD,
];

function buildPool(): CardDef[] {
  const cards: CardDef[] = [];
  // A running cursor walks the name pools so every card gets a distinct, deterministic
  // first+last pairing. Different strides for first/last names avoid repeated combos.
  let nameCursor = 0;

  for (const rarity of RARITY_ORDER) {
    const plan = RARITY_PLAN[rarity];
    for (const role of ROLE_ORDER) {
      const count = plan[
        role === PlayerRole.GK ? 'GK'
          : role === PlayerRole.DEF ? 'DEF'
            : role === PlayerRole.MID ? 'MID'
              : 'FWD'
      ];
      for (let i = 0; i < count; i++) {
        const first = FIRST_NAMES[nameCursor % FIRST_NAMES.length] as string;
        const last = LAST_NAMES[(nameCursor * 3 + 1) % LAST_NAMES.length] as string;
        const nation = NATIONS[nameCursor % NATIONS.length] as string;
        const variationIndex = nameCursor; // buildStats wraps via modulo
        nameCursor++;

        cards.push({
          id: `c-${RARITY_TOKEN[rarity]}-${ROLE_TOKEN[role]}-${i + 1}`,
          name: `${first} ${last}`,
          role,
          rarity,
          baseStats: buildStats(rarity, role, variationIndex),
          nation,
        });
      }
    }
  }

  return cards;
}

// ───────────────────────────── Exports ─────────────────────────────

/** The complete, deterministic collectible card pool (~72 cards). */
export const CARD_POOL: CardDef[] = buildPool();

const CARD_BY_ID: ReadonlyMap<string, CardDef> = new Map(
  CARD_POOL.map((c) => [c.id, c] as const),
);

/** Look up a single card definition by its id, or undefined if unknown. */
export function getCardDef(id: string): CardDef | undefined {
  return CARD_BY_ID.get(id);
}

/** All cards of a given rarity (in stable pool order). */
export function cardsByRarity(r: Rarity): CardDef[] {
  return CARD_POOL.filter((c) => c.rarity === r);
}
