/**
 * Country-level / XP progression. Account XP accumulates from card upgrades and match
 * results; crossing thresholds raises the Country Level, which gates stadiums, packs and
 * advanced formations (see blueprint).
 */
import type { Profile } from '@/core/types';
import { PROGRESSION } from '@/core/constants';

/** XP required to advance from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return Math.floor(PROGRESSION.xpBase * Math.pow(level, PROGRESSION.xpExp));
}

export interface XpResult {
  leveledUp: boolean;
  levelsGained: number;
  newLevel: number;
}

/** Add XP to a profile, rolling over country levels. Mutates the profile. */
export function addXp(profile: Profile, amount: number): XpResult {
  if (amount <= 0) return { leveledUp: false, levelsGained: 0, newLevel: profile.countryLevel };
  profile.xp += amount;
  let gained = 0;
  while (profile.countryLevel < PROGRESSION.maxLevel) {
    const need = xpForLevel(profile.countryLevel);
    if (profile.xp < need) break;
    profile.xp -= need;
    profile.countryLevel += 1;
    gained += 1;
  }
  if (profile.countryLevel >= PROGRESSION.maxLevel) profile.xp = 0;
  return { leveledUp: gained > 0, levelsGained: gained, newLevel: profile.countryLevel };
}

/** Progress (0..1) toward the next country level. */
export function levelProgress(profile: Profile): number {
  if (profile.countryLevel >= PROGRESSION.maxLevel) return 1;
  const need = xpForLevel(profile.countryLevel);
  return need > 0 ? Math.min(1, profile.xp / need) : 0;
}

export interface MatchReward {
  coins: number;
  xp: number;
}

/** Coins + XP for a match result (before any pack award). */
export function matchReward(result: 'win' | 'draw' | 'loss', opponentStrength: number): MatchReward {
  switch (result) {
    case 'win': {
      // Beating a stronger opponent pays a little more.
      const bonus = Math.max(0, Math.round((opponentStrength - 400) * 0.25));
      return { coins: PROGRESSION.coinsWinBase + bonus, xp: PROGRESSION.xpWin };
    }
    case 'draw':
      return { coins: PROGRESSION.coinsDraw, xp: PROGRESSION.xpDraw };
    case 'loss':
      return { coins: PROGRESSION.coinsLoss, xp: PROGRESSION.xpLoss };
    default:
      return { coins: 0, xp: 0 };
  }
}
