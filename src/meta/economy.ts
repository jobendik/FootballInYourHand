/**
 * The metagame economy: card stat scaling, Team Strength, the duplicate-and-coins upgrade
 * loop, gacha pack openings, and assembling a MatchConfig from a profile + opponent.
 *
 * Team Strength is the sum of the (level-scaled) average ratings of the 11 active players —
 * the definitive power metric from the blueprint.
 */
import {
  PlayerRole,
  Rarity,
  TeamSide,
  type CardDef,
  type Difficulty,
  type KitConfig,
  type MatchConfig,
  type OwnedCard,
  type PackDef,
  type PlayerStats,
  type Profile,
  type RuntimeConfig,
  type SquadMember,
  type TeamSetup,
} from '@/core/types';
import { DIFFICULTY_AI_LEVEL, MATCH, RARITY_TIERS } from '@/core/constants';
import { clamp } from '@/utils/math';
import { Rng } from '@/utils/rng';
import { CARD_POOL, cardsByRarity, getCardDef } from '@/data/cards';
import { getFormation } from '@/data/formations';
import { TEAM_PRESETS, generateSquad } from '@/data/teams';
import { addXp, matchReward } from './progression';
import { PROGRESSION } from '@/core/constants';

const RARITY_ORDER: Rarity[] = [Rarity.COMMON, Rarity.RARE, Rarity.EPIC, Rarity.LEGENDARY, Rarity.MYTHICAL];
const LEVEL_STAT_GAIN = 0.035; // +3.5% of base per level above 1

function avg(s: PlayerStats): number {
  return (s.pace + s.shooting + s.passing + s.dribbling + s.defending + s.physical) / 6;
}

/** A card's attributes at a given upgrade level. */
export function scaledStats(card: CardDef, level: number): PlayerStats {
  const m = 1 + (Math.max(1, level) - 1) * LEVEL_STAT_GAIN;
  const f = (v: number) => clamp(Math.round(v * m), 1, 99);
  const b = card.baseStats;
  return {
    pace: f(b.pace),
    shooting: f(b.shooting),
    passing: f(b.passing),
    dribbling: f(b.dribbling),
    defending: f(b.defending),
    physical: f(b.physical),
  };
}

/** Single-card rating (the level-scaled average), rounded. */
export function ownedRating(owned: OwnedCard): number {
  const card = getCardDef(owned.defId);
  if (!card) return 0;
  return Math.round(avg(scaledStats(card, owned.level)));
}

export function findOwned(profile: Profile, defId: string): OwnedCard | undefined {
  return profile.cards.find((c) => c.defId === defId);
}

/** Team Strength = sum of the 11 active players' ratings. */
export function teamStrength(profile: Profile): number {
  let total = 0;
  for (const defId of profile.activeRoster) {
    const owned = findOwned(profile, defId);
    if (owned) total += ownedRating(owned);
  }
  return total;
}

/** Star rating (0.5..5, half steps) derived from Team Strength, for the UI. */
export function starRating(strength: number): number {
  const lo = 11 * 32;
  const hi = 11 * 96;
  const t = clamp((strength - lo) / (hi - lo), 0, 1);
  return Math.max(0.5, Math.round(t * 10) / 2);
}

// ───────────────────────────── Upgrades ─────────────────────────────

export function copiesNeeded(rarity: Rarity, level: number): number {
  const tier = RARITY_TIERS[rarity];
  return tier.copiesPerLevel[level - 1] ?? Infinity;
}

export function coinCost(rarity: Rarity, level: number): number {
  const tier = RARITY_TIERS[rarity];
  return tier.coinCostPerLevel[level - 1] ?? Infinity;
}

export interface UpgradeCheck {
  ok: boolean;
  reason?: string;
  copiesNeeded?: number;
  coinCost?: number;
}

export function canUpgrade(profile: Profile, defId: string): UpgradeCheck {
  const owned = findOwned(profile, defId);
  const card = getCardDef(defId);
  if (!owned || !card) return { ok: false, reason: 'Not owned' };
  const tier = RARITY_TIERS[card.rarity];
  if (owned.level >= tier.maxLevel) return { ok: false, reason: 'Max level' };
  const need = copiesNeeded(card.rarity, owned.level);
  const cost = coinCost(card.rarity, owned.level);
  if (owned.copies < need) return { ok: false, reason: 'Need duplicates', copiesNeeded: need, coinCost: cost };
  if (profile.coins < cost) return { ok: false, reason: 'Not enough coins', copiesNeeded: need, coinCost: cost };
  return { ok: true, copiesNeeded: need, coinCost: cost };
}

export interface UpgradeResult {
  ok: boolean;
  reason?: string;
  newLevel?: number;
  leveledUpAccount?: boolean;
}

export function upgradeCard(profile: Profile, defId: string): UpgradeResult {
  const check = canUpgrade(profile, defId);
  if (!check.ok) return { ok: false, reason: check.reason };
  const owned = findOwned(profile, defId)!;
  const card = getCardDef(defId)!;
  owned.copies -= copiesNeeded(card.rarity, owned.level);
  profile.coins -= coinCost(card.rarity, owned.level);
  owned.level += 1;
  const xp = addXp(profile, PROGRESSION.xpPerUpgrade);
  return { ok: true, newLevel: owned.level, leveledUpAccount: xp.leveledUp };
}

// ───────────────────────────── Packs ─────────────────────────────

export interface DrawnCard {
  defId: string;
  rarity: Rarity;
  isNew: boolean;
}

export function canAffordPack(profile: Profile, pack: PackDef): boolean {
  return pack.currency === 'coins' ? profile.coins >= pack.cost : profile.gems >= pack.cost;
}

/** Add a single card to inventory; returns whether it was newly owned. */
export function grantCard(profile: Profile, defId: string): boolean {
  const owned = findOwned(profile, defId);
  if (owned) {
    owned.copies += 1;
    return false;
  }
  profile.cards.push({ defId, level: 1, copies: 0 });
  return true;
}

/** Roll `pack.cardCount` cards into the profile by drop-rate weights (no cost). */
function rollPackInto(profile: Profile, pack: PackDef, rng: Rng): DrawnCard[] {
  const weights = RARITY_ORDER.map((r) => pack.dropRates[r] ?? 0);
  const drawn: DrawnCard[] = [];
  for (let i = 0; i < pack.cardCount; i++) {
    const rarity = rng.weighted(RARITY_ORDER, weights);
    let pool = cardsByRarity(rarity);
    if (pool.length === 0) pool = cardsByRarity(Rarity.COMMON);
    if (pool.length === 0) pool = CARD_POOL;
    const card = rng.pick(pool);
    const isNew = grantCard(profile, card.id);
    drawn.push({ defId: card.id, rarity: card.rarity, isNew });
  }
  return drawn;
}

/** Purchase + open a pack; returns null if the player cannot afford it. */
export function openPack(profile: Profile, pack: PackDef, rng: Rng): DrawnCard[] | null {
  if (!canAffordPack(profile, pack)) return null;
  if (pack.currency === 'coins') profile.coins -= pack.cost;
  else profile.gems -= pack.cost;
  return rollPackInto(profile, pack, rng);
}

/** Grant a pack's contents for free (e.g. a Victory Path reward). */
export function awardPackFree(profile: Profile, pack: PackDef, rng: Rng): DrawnCard[] {
  return rollPackInto(profile, pack, rng);
}

// ───────────────────────────── Match assembly ─────────────────────────────

function shortNameFrom(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();
  return (letters.slice(0, 3) || 'YOU').padEnd(3, 'X');
}

/** Build the user's TeamSetup from their profile (roster, formation, kit). */
export function buildUserTeamSetup(profile: Profile): TeamSetup {
  const formation = getFormation(profile.formationId);
  const squad: SquadMember[] = [];
  for (let i = 0; i < 11; i++) {
    const slot = formation.slots[i] ?? formation.slots[formation.slots.length - 1]!;
    const defId = profile.activeRoster[i];
    const card = defId ? getCardDef(defId) : undefined;
    const owned = defId ? findOwned(profile, defId) : undefined;
    if (card && owned) {
      squad.push({
        name: card.name,
        number: i === 0 ? 1 : i + 1,
        role: slot.role,
        rarity: card.rarity,
        stats: scaledStats(card, owned.level),
      });
    } else {
      // Fallback filler so a match can always start.
      squad.push({
        name: `Player ${i + 1}`,
        number: i === 0 ? 1 : i + 1,
        role: slot.role,
        rarity: Rarity.COMMON,
        stats: { pace: 55, shooting: 50, passing: 55, dribbling: 55, defending: 55, physical: 55 },
      });
    }
  }
  return {
    name: `${profile.name}`,
    shortName: shortNameFrom(profile.name),
    kit: { ...profile.kit },
    formationId: profile.formationId,
    squad,
    aiLevel: 0.55, // competence of the user's AI teammates
    isUser: true,
  };
}

/** Build an AI opponent TeamSetup at a target strength, themed by a preset. */
export function buildOpponentSetup(
  targetStrength: number,
  difficulty: Difficulty,
  rng: Rng,
  presetId?: string,
): TeamSetup {
  const preset =
    (presetId ? TEAM_PRESETS.find((p) => p.id === presetId) : undefined) ??
    // closest preset by strength for thematic kit/name
    TEAM_PRESETS.reduce((best, p) =>
      Math.abs(p.baseStrength - targetStrength) < Math.abs(best.baseStrength - targetStrength) ? p : best,
    TEAM_PRESETS[0]!);
  const squad = generateSquad(targetStrength, preset.formationId, rng);
  return {
    name: preset.name,
    shortName: preset.shortName,
    kit: { ...preset.kit },
    formationId: preset.formationId,
    squad,
    aiLevel: DIFFICULTY_AI_LEVEL[difficulty] ?? 0.5,
    isUser: false,
  };
}

// ───────────────────────────── Kit contrast ─────────────────────────────
// Gameplay clarity beats kit identity: the opponent's shirt must never read close to the
// user's. A curated palette of vivid, mutually-distinct kits is used when a preset clashes.

const CONTRAST_KITS: KitConfig[] = [
  { primary: '#e10600', secondary: '#ffffff', shorts: '#ffffff', socks: '#e10600', accent: '#111111' }, // red
  { primary: '#ff7a00', secondary: '#111111', shorts: '#111111', socks: '#ff7a00', accent: '#ffffff' }, // orange
  { primary: '#8e2bff', secondary: '#ffffff', shorts: '#2a0a4a', socks: '#8e2bff', accent: '#ffd23f' }, // purple
  { primary: '#00b894', secondary: '#06342b', shorts: '#06342b', socks: '#00b894', accent: '#ffffff' }, // teal
  { primary: '#ff2d8e', secondary: '#ffffff', shorts: '#3a0a22', socks: '#ff2d8e', accent: '#ffffff' }, // pink
  { primary: '#ffd23f', secondary: '#111111', shorts: '#111111', socks: '#ffd23f', accent: '#111111' }, // yellow/black
  { primary: '#101418', secondary: '#f5f5f5', shorts: '#101418', socks: '#f5f5f5', accent: '#f5f5f5' }, // black/white
  { primary: '#1565ff', secondary: '#ffffff', shorts: '#ffffff', socks: '#1565ff', accent: '#ffd23f' }, // royal blue
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const int = parseInt(n, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/** Euclidean RGB distance (0..~441). */
function colorDist(a: string, b: string): number {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
}

/** Return an away kit whose shirt is clearly distinct from the home shirt. */
function ensureAwayContrast(home: KitConfig, away: KitConfig): KitConfig {
  const MIN_DISTANCE = 150;
  if (colorDist(home.primary, away.primary) >= MIN_DISTANCE) return away;
  // Pick the curated kit whose primary is farthest from the home shirt.
  let best = CONTRAST_KITS[0]!;
  let bestD = -1;
  for (const k of CONTRAST_KITS) {
    const d = colorDist(home.primary, k.primary);
    if (d > bestD) {
      bestD = d;
      best = k;
    }
  }
  return { ...best };
}

export interface MatchSetupOptions {
  opponentStrength: number;
  difficulty: Difficulty;
  config: RuntimeConfig;
  seed: number;
  opponentPresetId?: string;
}

export function createMatchConfig(profile: Profile, opts: MatchSetupOptions): MatchConfig {
  const rng = new Rng(opts.seed ^ 0x5f3759df);
  const home = buildUserTeamSetup(profile);
  const away = buildOpponentSetup(opts.opponentStrength, opts.difficulty, rng, opts.opponentPresetId);
  // Guarantee the opponent's shirt is clearly distinct from the user's.
  away.kit = ensureAwayContrast(home.kit, away.kit);
  return {
    home,
    away,
    userSide: TeamSide.HOME,
    durationSimSeconds: MATCH.durationSimSeconds,
    durationRealSeconds: MATCH.durationRealSeconds,
    seed: opts.seed,
    config: opts.config,
  };
}

// ───────────────────────────── Match result ─────────────────────────────

export interface MatchOutcome {
  result: 'win' | 'draw' | 'loss';
  coins: number;
  xp: number;
  leveledUp: boolean;
  newLevel: number;
}

/** Apply a finished match's result to the profile (user is HOME). Mutates the profile. */
export function applyMatchResult(
  profile: Profile,
  homeScore: number,
  awayScore: number,
  opponentStrength: number,
): MatchOutcome {
  const result: 'win' | 'draw' | 'loss' = homeScore > awayScore ? 'win' : homeScore < awayScore ? 'loss' : 'draw';
  profile.stats.matchesPlayed += 1;
  profile.stats.goalsFor += homeScore;
  profile.stats.goalsAgainst += awayScore;
  if (result === 'win') profile.stats.wins += 1;
  else if (result === 'loss') profile.stats.losses += 1;
  else profile.stats.draws += 1;

  const reward = matchReward(result, opponentStrength);
  profile.coins += reward.coins;
  const xp = addXp(profile, reward.xp);
  return { result, coins: reward.coins, xp: reward.xp, leveledUp: xp.leveledUp, newLevel: profile.countryLevel };
}

export { PlayerRole };
