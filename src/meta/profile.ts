/**
 * Player profile persistence (localStorage) and the runtime-settings store. A fresh profile
 * is seeded with a playable starter XI so the game is immediately playable.
 */
import { Rarity, type KitConfig, type OwnedCard, type Profile, type RuntimeConfig } from '@/core/types';
import { DEFAULT_CONFIG } from '@/core/constants';
import { CARD_POOL, cardsByRarity } from '@/data/cards';
import { DEFAULT_FORMATION_ID, getFormation } from '@/data/formations';

const PROFILE_KEY = 'fih.profile.v1';
const SETTINGS_KEY = 'fih.settings.v1';
const PROFILE_VERSION = 1;

const DEFAULT_KIT: KitConfig = {
  primary: '#1f6feb',
  secondary: '#ffffff',
  shorts: '#ffffff',
  socks: '#1f6feb',
  accent: '#ffd23f',
};

/** Choose a starter card for each formation slot from the cheapest tiers, no repeats. */
function pickStarterRoster(): { cards: OwnedCard[]; roster: string[] } {
  const formation = getFormation(DEFAULT_FORMATION_ID);
  const used = new Set<string>();
  const roster: string[] = [];
  const cards: OwnedCard[] = [];
  const tiers = [Rarity.COMMON, Rarity.RARE, Rarity.EPIC];

  for (const slot of formation.slots) {
    let chosen = undefined as undefined | { id: string };
    for (const tier of tiers) {
      const pool = cardsByRarity(tier).filter((c) => c.role === slot.role && !used.has(c.id));
      if (pool.length) {
        chosen = pool[0]!;
        break;
      }
    }
    if (!chosen) {
      chosen =
        CARD_POOL.find((c) => c.role === slot.role && !used.has(c.id)) ??
        CARD_POOL.find((c) => !used.has(c.id));
    }
    if (chosen) {
      used.add(chosen.id);
      roster.push(chosen.id);
      cards.push({ defId: chosen.id, level: 1, copies: 0 });
    }
  }

  // Hand a few spare duplicates of the starters so the upgrade loop is reachable early.
  for (let i = 0; i < cards.length && i < 4; i++) cards[i]!.copies += 2;

  return { cards, roster };
}

export function createDefaultProfile(): Profile {
  const { cards, roster } = pickStarterRoster();
  return {
    version: PROFILE_VERSION,
    name: 'Manager',
    avatar: '⚽',
    countryLevel: 1,
    xp: 0,
    coins: 1500,
    gems: 50,
    cards,
    activeRoster: roster,
    formationId: DEFAULT_FORMATION_ID,
    kit: { ...DEFAULT_KIT },
    victoryPathTier: 0,
    stats: { wins: 0, losses: 0, draws: 0, goalsFor: 0, goalsAgainst: 0, matchesPlayed: 0 },
  };
}

function isValidProfile(p: unknown): p is Profile {
  if (!p || typeof p !== 'object') return false;
  const o = p as Partial<Profile>;
  return (
    typeof o.name === 'string' &&
    Array.isArray(o.cards) &&
    Array.isArray(o.activeRoster) &&
    o.activeRoster.length === 11 &&
    typeof o.coins === 'number' &&
    typeof o.formationId === 'string'
  );
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidProfile(parsed)) return parsed;
    }
  } catch {
    /* fall through to default */
  }
  const fresh = createDefaultProfile();
  saveProfile(fresh);
  return fresh;
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* storage unavailable — ignore */
  }
}

export function resetProfile(): Profile {
  const fresh = createDefaultProfile();
  saveProfile(fresh);
  return fresh;
}

// ───────────────────────────── Settings ─────────────────────────────

export function loadSettings(): RuntimeConfig {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveSettings(config: RuntimeConfig): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}
