/**
 * Formation definitions — the seven tactical shapes from the blueprint, plus lookup helpers.
 *
 * Each {@link FormationDef} holds exactly 11 {@link FormationSlot}s, GK first, in NORMALISED
 * coordinates: `norm.x` = depth (0 = own goal line, 1 = opponent goal line); `norm.y` = width
 * (0 = one touchline, 1 = the other). Systems (pitch.baseAnchor) map these into world space
 * relative to the team's attacking direction, so the same table serves both sides.
 *
 * Coordinate guidance used throughout:
 *   - GK ≈ {x:0.05, y:0.5}
 *   - Defensive line  x ≈ 0.20–0.26
 *   - Midfield band   x ≈ 0.45–0.60
 *   - Forward line    x ≈ 0.74–0.86
 *   - A back four spreads across y ≈ 0.18 / 0.39 / 0.61 / 0.82.
 */
import type { FormationDef, FormationSlot, Vec2 } from '@/core/types';
import { PlayerRole } from '@/core/types';

/** Convenience builder so the tables below stay terse and unambiguous. */
function slot(role: PlayerRole, label: string, x: number, y: number): FormationSlot {
  const norm: Vec2 = { x, y };
  return { role, label, norm };
}

// ───────────────────────────── 4-3-3 ─────────────────────────────
// GK + 4 DEF + 3 MID + 3 FWD. Wing-focused high press with wide pitch coverage.
const F_433: FormationDef = {
  id: '4-3-3',
  name: '4-3-3',
  shape: 'GK + 4 DEF + 3 MID + 3 FWD',
  description:
    'Emphasizes wing-focused attacks, utilizes high pressing lines, and provides expansive wide pitch coverage.',
  unlockLevel: 1,
  slots: [
    slot(PlayerRole.GK, 'GK', 0.05, 0.5),
    // Back four
    slot(PlayerRole.DEF, 'RB', 0.22, 0.82),
    slot(PlayerRole.DEF, 'RCB', 0.2, 0.61),
    slot(PlayerRole.DEF, 'LCB', 0.2, 0.39),
    slot(PlayerRole.DEF, 'LB', 0.22, 0.18),
    // Midfield three (one holder, two shuttlers)
    slot(PlayerRole.MID, 'CDM', 0.46, 0.5),
    slot(PlayerRole.MID, 'RCM', 0.54, 0.7),
    slot(PlayerRole.MID, 'LCM', 0.54, 0.3),
    // Front three
    slot(PlayerRole.FWD, 'RW', 0.8, 0.82),
    slot(PlayerRole.FWD, 'ST', 0.86, 0.5),
    slot(PlayerRole.FWD, 'LW', 0.8, 0.18),
  ],
};

// ───────────────────────────── 4-4-2 (default) ─────────────────────────────
// GK + 4 DEF + 4 MID + 2 FWD. Balanced, symmetrical.
const F_442: FormationDef = {
  id: '4-4-2',
  name: '4-4-2',
  shape: 'GK + 4 DEF + 4 MID + 2 FWD',
  description:
    'Offers balanced defense and attack, relying on clear central partnerships and symmetrical defensive lines.',
  unlockLevel: 1,
  slots: [
    slot(PlayerRole.GK, 'GK', 0.05, 0.5),
    // Back four
    slot(PlayerRole.DEF, 'RB', 0.22, 0.82),
    slot(PlayerRole.DEF, 'RCB', 0.2, 0.61),
    slot(PlayerRole.DEF, 'LCB', 0.2, 0.39),
    slot(PlayerRole.DEF, 'LB', 0.22, 0.18),
    // Flat midfield four
    slot(PlayerRole.MID, 'RM', 0.5, 0.84),
    slot(PlayerRole.MID, 'RCM', 0.48, 0.6),
    slot(PlayerRole.MID, 'LCM', 0.48, 0.4),
    slot(PlayerRole.MID, 'LM', 0.5, 0.16),
    // Strike pair
    slot(PlayerRole.FWD, 'RST', 0.8, 0.61),
    slot(PlayerRole.FWD, 'LST', 0.8, 0.39),
  ],
};

// ───────────────────────────── 4-2-3-1 ─────────────────────────────
// GK + 4 DEF + 2 CDM + 3 AM + 1 ST. Deep midfield control via a double pivot and a No. 10.
const F_4231: FormationDef = {
  id: '4-2-3-1',
  name: '4-2-3-1',
  shape: 'GK + 4 DEF + 2 CDM + 3 AM + 1 ST',
  description:
    'Prioritizes deep midfield control, utilizing two holding midfielders and relying on a creative Number 10.',
  unlockLevel: 3,
  slots: [
    slot(PlayerRole.GK, 'GK', 0.05, 0.5),
    // Back four
    slot(PlayerRole.DEF, 'RB', 0.22, 0.82),
    slot(PlayerRole.DEF, 'RCB', 0.2, 0.61),
    slot(PlayerRole.DEF, 'LCB', 0.2, 0.39),
    slot(PlayerRole.DEF, 'LB', 0.22, 0.18),
    // Double pivot
    slot(PlayerRole.MID, 'RDM', 0.42, 0.62),
    slot(PlayerRole.MID, 'LDM', 0.42, 0.38),
    // Attacking band of three
    slot(PlayerRole.MID, 'RAM', 0.64, 0.82),
    slot(PlayerRole.MID, 'CAM', 0.66, 0.5),
    slot(PlayerRole.MID, 'LAM', 0.64, 0.18),
    // Lone striker
    slot(PlayerRole.FWD, 'ST', 0.85, 0.5),
  ],
};

// ───────────────────────────── 3-5-2 ─────────────────────────────
// GK + 3 CB + 5 MID + 2 ST. Central overload with wide wingbacks stretching play.
const F_352: FormationDef = {
  id: '3-5-2',
  name: '3-5-2',
  shape: 'GK + 3 CB + 5 MID + 2 ST',
  description:
    "Overloads the central midfield, utilizes wide wingbacks to stretch the opponent's defensive shape.",
  unlockLevel: 5,
  slots: [
    slot(PlayerRole.GK, 'GK', 0.05, 0.5),
    // Back three
    slot(PlayerRole.DEF, 'RCB', 0.2, 0.71),
    slot(PlayerRole.DEF, 'CB', 0.18, 0.5),
    slot(PlayerRole.DEF, 'LCB', 0.2, 0.29),
    // Wingbacks pushed wide and high
    slot(PlayerRole.MID, 'RWB', 0.5, 0.9),
    slot(PlayerRole.MID, 'LWB', 0.5, 0.1),
    // Central midfield trio
    slot(PlayerRole.MID, 'RCM', 0.5, 0.66),
    slot(PlayerRole.MID, 'CDM', 0.44, 0.5),
    slot(PlayerRole.MID, 'LCM', 0.5, 0.34),
    // Strike pair
    slot(PlayerRole.FWD, 'RST', 0.82, 0.61),
    slot(PlayerRole.FWD, 'LST', 0.82, 0.39),
  ],
};

// ───────────────────────────── 4-4-2 Diamond ─────────────────────────────
// GK + 4 DEF + 1 CDM + 2 CM + 1 CAM + 2 ST. Central overload behind two strikers.
const F_442D: FormationDef = {
  id: '4-4-2-diamond',
  name: '4-4-2 Diamond',
  shape: 'GK + 4 DEF + 1 CDM + 2 CM + 1 CAM + 2 ST',
  description:
    'Creates a central midfield overload and designates a dedicated playmaker role behind the strikers.',
  unlockLevel: 7,
  slots: [
    slot(PlayerRole.GK, 'GK', 0.05, 0.5),
    // Back four
    slot(PlayerRole.DEF, 'RB', 0.22, 0.82),
    slot(PlayerRole.DEF, 'RCB', 0.2, 0.61),
    slot(PlayerRole.DEF, 'LCB', 0.2, 0.39),
    slot(PlayerRole.DEF, 'LB', 0.22, 0.18),
    // Diamond: holder, two carriers, playmaker tip
    slot(PlayerRole.MID, 'CDM', 0.42, 0.5),
    slot(PlayerRole.MID, 'RCM', 0.54, 0.72),
    slot(PlayerRole.MID, 'LCM', 0.54, 0.28),
    slot(PlayerRole.MID, 'CAM', 0.66, 0.5),
    // Strike pair
    slot(PlayerRole.FWD, 'RST', 0.82, 0.61),
    slot(PlayerRole.FWD, 'LST', 0.82, 0.39),
  ],
};

// ───────────────────────────── 4-1-4-1 ─────────────────────────────
// GK + 4 DEF + 1 CDM + 4 MID + 1 ST. Compact low block, defensive solidity.
const F_4141: FormationDef = {
  id: '4-1-4-1',
  name: '4-1-4-1',
  shape: 'GK + 4 DEF + 1 CDM + 4 MID + 1 ST',
  description:
    'Highly compact midfield structure, prioritizing defensive solidity and low-block containment.',
  unlockLevel: 9,
  slots: [
    slot(PlayerRole.GK, 'GK', 0.05, 0.5),
    // Back four
    slot(PlayerRole.DEF, 'RB', 0.22, 0.82),
    slot(PlayerRole.DEF, 'RCB', 0.2, 0.61),
    slot(PlayerRole.DEF, 'LCB', 0.2, 0.39),
    slot(PlayerRole.DEF, 'LB', 0.22, 0.18),
    // Single screening holder
    slot(PlayerRole.MID, 'CDM', 0.4, 0.5),
    // Flat band of four ahead of the holder
    slot(PlayerRole.MID, 'RM', 0.58, 0.84),
    slot(PlayerRole.MID, 'RCM', 0.56, 0.61),
    slot(PlayerRole.MID, 'LCM', 0.56, 0.39),
    slot(PlayerRole.MID, 'LM', 0.58, 0.16),
    // Lone striker
    slot(PlayerRole.FWD, 'ST', 0.85, 0.5),
  ],
};

// ───────────────────────────── 3-3-3 ─────────────────────────────
// GK + 3 DEF + 3 MID + 3 FWD. Symmetrical width forming passing triangles.
const F_333: FormationDef = {
  id: '3-3-3',
  name: '3-3-3',
  shape: 'GK + 3 DEF + 1 CDM + 3 MID + 3 FWD',
  description:
    'Provides symmetrical width, naturally forming geometric passing triangles across the pitch grid.',
  unlockLevel: 11,
  slots: [
    slot(PlayerRole.GK, 'GK', 0.05, 0.5),
    // Back three
    slot(PlayerRole.DEF, 'RCB', 0.22, 0.78),
    slot(PlayerRole.DEF, 'CB', 0.2, 0.5),
    slot(PlayerRole.DEF, 'LCB', 0.22, 0.22),
    // Holding midfielder (keeps the squad at the required 11 with no overlapping anchor)
    slot(PlayerRole.MID, 'CDM', 0.38, 0.5),
    // Midfield three
    slot(PlayerRole.MID, 'RM', 0.52, 0.78),
    slot(PlayerRole.MID, 'CM', 0.5, 0.5),
    slot(PlayerRole.MID, 'LM', 0.52, 0.22),
    // Forward three
    slot(PlayerRole.FWD, 'RW', 0.8, 0.78),
    slot(PlayerRole.FWD, 'ST', 0.82, 0.5),
    slot(PlayerRole.FWD, 'LW', 0.8, 0.22),
  ],
};

/** All seven formations, in unlock order. */
export const FORMATIONS: FormationDef[] = [
  F_442,
  F_433,
  F_4231,
  F_352,
  F_442D,
  F_4141,
  F_333,
];

/** The shape new players start with — balanced and always unlocked. */
export const DEFAULT_FORMATION_ID = '4-4-2';

/**
 * Look up a formation by id, falling back to the default ('4-4-2') if the id is unknown.
 * Never returns undefined, so callers can rely on a valid 11-slot shape.
 */
export function getFormation(id: string): FormationDef {
  const found = FORMATIONS.find((f) => f.id === id);
  if (found) return found;
  // Default is guaranteed present in FORMATIONS.
  return FORMATIONS.find((f) => f.id === DEFAULT_FORMATION_ID) ?? FORMATIONS[0];
}
