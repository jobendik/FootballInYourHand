/**
 * Shared layout for the in-match touch controls. Both the input system (hit-testing) and
 * the HUD renderer (drawing) compute regions from here, so a tap always lands on the button
 * the player sees. Coordinates are screen-space CSS pixels.
 */
import type { Vec2 } from '@/core/types';
import { HUD } from '@/core/constants';

export type ButtonSlot = 'sprint' | 'mid' | 'action';

export interface ButtonRegion {
  slot: ButtonSlot;
  center: Vec2;
  radius: number;
}

export interface HudLayout {
  width: number;
  height: number;
  /** Touches starting at screenX < splitX drive the floating joystick. */
  splitX: number;
  buttons: ButtonRegion[];
  /** Convenience map for drawing. */
  button: Record<ButtonSlot, ButtonRegion>;
  scoreboard: { x: number; y: number; w: number; h: number };
}

export function computeHudLayout(width: number, height: number): HudLayout {
  const R = HUD.buttonRadius;
  const gap = HUD.buttonGap;
  const margin = HUD.margin + HUD.safeAreaPad;

  // The "action" button (Shoot / Slide) anchors the bottom-right corner and is largest.
  const action: ButtonRegion = {
    slot: 'action',
    center: { x: width - margin - R, y: height - margin - R },
    radius: R + 4,
  };
  // "mid" (Pass / Switch) sits to the lower-left of action.
  const mid: ButtonRegion = {
    slot: 'mid',
    center: { x: action.center.x - (2 * R + gap), y: action.center.y + R * 0.18 },
    radius: R,
  };
  // "sprint" sits above the action button.
  const sprint: ButtonRegion = {
    slot: 'sprint',
    center: { x: action.center.x + R * 0.1, y: action.center.y - (2 * R + gap) },
    radius: R - 4,
  };

  return {
    width,
    height,
    splitX: width * 0.5,
    buttons: [sprint, mid, action],
    button: { sprint, mid, action },
    scoreboard: { x: width / 2 - 150, y: margin - HUD.safeAreaPad, w: 300, h: 50 },
  };
}

/** Returns the button region whose circle contains the point, or null. */
export function hitButton(layout: HudLayout, x: number, y: number): ButtonRegion | null {
  for (const b of layout.buttons) {
    const dx = x - b.center.x;
    const dy = y - b.center.y;
    // Slightly generous hit radius for fat-finger tolerance.
    if (dx * dx + dy * dy <= (b.radius + 10) * (b.radius + 10)) return b;
  }
  return null;
}
