/**
 * In-match HUD overlay, drawn in screen space (CSS pixels — the renderer has already applied
 * the device-pixel-ratio transform to the context). This module owns ONLY the 2D overlay:
 * scoreboard, the floating joystick visual, the tri-button action layout, large state banners
 * and a thin possession bar. It never draws world-space gameplay (the renderer does that) and
 * never mutates the world — it is a pure read of `GameWorld`.
 *
 * The button regions come from the shared `computeHudLayout`, the exact same source the input
 * system hit-tests against, so a tap always lands on the button the player can see.
 */
import type { GameWorld } from '@/core/types';
import { MatchState, TeamSide, ControlMode } from '@/core/types';
import { HUD, PASS, SHOT } from '@/core/constants';
import { computeHudLayout, type ButtonSlot } from '@/ui/hudLayout';
import { clamp01, ease, TAU } from '@/utils/math';

export interface HudView {
  width: number;
  height: number;
  dpr: number;
}

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

/** Map a button slot to its current label + active flag for the live control mode. */
interface ButtonDisplay {
  icon: string | null;
  label: string;
  active: boolean;
  /** 0..1 charge fill to draw as an arc (only for chargeable offensive buttons). */
  charge: number;
}

export function renderHud(ctx: CanvasRenderingContext2D, world: GameWorld, view: HudView): void {
  const layout = computeHudLayout(view.width, view.height);

  drawScoreboard(ctx, world, layout.scoreboard);
  drawPossessionBar(ctx, world, layout.scoreboard);
  drawJoystick(ctx, world);
  drawActionButtons(ctx, world, layout);
  drawBanner(ctx, world, view);
}

// ───────────────────────────── Scoreboard ─────────────────────────────

function drawScoreboard(
  ctx: CanvasRenderingContext2D,
  world: GameWorld,
  box: { x: number; y: number; w: number; h: number },
): void {
  const home = world.teams[TeamSide.HOME];
  const away = world.teams[TeamSide.AWAY];

  ctx.save();

  // Translucent dark pill.
  roundRect(ctx, box.x, box.y, box.w, box.h, box.h / 2);
  ctx.fillStyle = 'rgba(14, 18, 26, 0.72)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.stroke();

  const cx = box.x + box.w / 2;
  const midY = box.y + box.h * 0.42;

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';

  // Score, dead centre, prominent.
  ctx.textAlign = 'center';
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(`${home.score} - ${away.score}`, cx, midY);

  // Team short names flanking the score.
  ctx.font = `600 15px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'right';
  ctx.fillText(shortLabel(home.shortName), cx - 34, midY);
  ctx.textAlign = 'left';
  ctx.fillText(shortLabel(away.shortName), cx + 34, midY);

  // Clock + half indicator beneath the score.
  const subY = box.y + box.h * 0.78;
  ctx.textAlign = 'center';
  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  const half = world.clock.half === 1 ? '1st' : '2nd';
  ctx.fillText(`${formatClock(world.clock.simSeconds)}   •   ${half}`, cx, subY);

  ctx.restore();
}

/** Thin possession-share bar tucked under the scoreboard pill. */
function drawPossessionBar(
  ctx: CanvasRenderingContext2D,
  world: GameWorld,
  box: { x: number; y: number; w: number; h: number },
): void {
  const hf = Math.max(0, world.stats.home.possessionFrames);
  const af = Math.max(0, world.stats.away.possessionFrames);
  const total = hf + af;
  // Until possession has been recorded, default to an even split.
  const homeShare = total > 0 ? hf / total : 0.5;

  const barW = box.w * 0.7;
  const barH = 4;
  const x = box.x + (box.w - barW) / 2;
  const y = box.y + box.h + 5;

  ctx.save();
  const r = barH / 2;
  // Away (right) base fill.
  roundRect(ctx, x, y, barW, barH, r);
  ctx.fillStyle = 'rgba(86, 179, 255, 0.55)';
  ctx.fill();
  // Home (left) overlay proportion.
  const homeW = Math.max(r * 2, barW * homeShare);
  ctx.save();
  roundRect(ctx, x, y, barW, barH, r);
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 184, 0, 0.85)';
  ctx.fillRect(x, y, homeW, barH);
  ctx.restore();
  ctx.restore();
}

// ───────────────────────────── Joystick ─────────────────────────────

function drawJoystick(ctx: CanvasRenderingContext2D, world: GameWorld): void {
  const js = world.input.joystick;
  if (!js.active) return;

  ctx.save();
  ctx.globalAlpha = HUD.opacity * 0.55;

  // Base ring at the touch origin.
  ctx.beginPath();
  ctx.arc(js.origin.x, js.origin.y, js.radius, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.stroke();

  // Knob.
  ctx.globalAlpha = HUD.opacity * 0.8;
  ctx.beginPath();
  ctx.arc(js.knob.x, js.knob.y, HUD.joystickKnobRadius, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(20,28,40,0.6)';
  ctx.stroke();

  ctx.restore();
}

// ───────────────────────────── Action buttons ─────────────────────────────

function drawActionButtons(
  ctx: CanvasRenderingContext2D,
  world: GameWorld,
  layout: ReturnType<typeof computeHudLayout>,
): void {
  const offensive = world.controlMode === ControlMode.OFFENSIVE;
  const input = world.input;

  const displays: Record<ButtonSlot, ButtonDisplay> = {
    sprint: {
      icon: '⚡',
      label: 'Sprint',
      active: input.sprint,
      charge: 0,
    },
    mid: offensive
      ? {
          icon: null,
          label: 'Pass',
          active: input.pass.held,
          charge: input.pass.held ? clamp01(input.pass.holdTime / PASS.maxChargeTime) : 0,
        }
      : {
          icon: null,
          label: 'Switch',
          active: input.switchPlayer,
          charge: 0,
        },
    action: offensive
      ? {
          icon: null,
          label: 'Shoot',
          active: input.shoot.held,
          charge: input.shoot.held ? clamp01(input.shoot.holdTime / SHOT.maxChargeTime) : 0,
        }
      : {
          icon: null,
          label: 'Slide',
          active: input.slide,
          charge: 0,
        },
  };

  const order: ButtonSlot[] = ['sprint', 'mid', 'action'];
  for (const slot of order) {
    drawButton(ctx, layout.button[slot].center, layout.button[slot].radius, displays[slot], slot);
  }
}

function drawButton(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  radius: number,
  disp: ButtonDisplay,
  slot: ButtonSlot,
): void {
  ctx.save();
  ctx.globalAlpha = HUD.opacity;

  // Active buttons grow slightly and brighten for tactile feedback.
  const scale = disp.active ? 1.08 : 1;
  const r = radius * scale;

  const fill = buttonFill(slot, disp.active);
  const ring = buttonRing(slot, disp.active);

  // Filled circle.
  ctx.beginPath();
  ctx.arc(center.x, center.y, r, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();

  // Ring.
  ctx.lineWidth = disp.active ? 4 : 3;
  ctx.strokeStyle = ring;
  ctx.stroke();

  // Charge arc (offensive pass/shoot only) grows clockwise from the top.
  if (disp.charge > 0) {
    const start = -Math.PI / 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r + 5, start, start + TAU * clamp01(disp.charge));
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = chargeColor(disp.charge);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // Centred label / icon.
  ctx.fillStyle = disp.active ? '#0c1018' : 'rgba(255,255,255,0.95)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (disp.icon) {
    ctx.font = `600 ${Math.round(r * 0.7)}px ${FONT}`;
    ctx.fillText(disp.icon, center.x, center.y - r * 0.12);
    ctx.font = `600 11px ${FONT}`;
    ctx.fillText(disp.label, center.x, center.y + r * 0.42);
  } else {
    ctx.font = `700 ${Math.round(r * 0.38)}px ${FONT}`;
    ctx.fillText(disp.label, center.x, center.y);
  }

  ctx.restore();
}

function buttonFill(slot: ButtonSlot, active: boolean): string {
  if (active) {
    switch (slot) {
      case 'sprint':
        return 'rgba(120, 220, 255, 0.92)';
      case 'mid':
        return 'rgba(120, 230, 160, 0.92)';
      case 'action':
        return 'rgba(255, 150, 120, 0.94)';
      default:
        return 'rgba(255,255,255,0.92)';
    }
  }
  switch (slot) {
    case 'sprint':
      return 'rgba(40, 70, 96, 0.55)';
    case 'mid':
      return 'rgba(36, 76, 56, 0.55)';
    case 'action':
      return 'rgba(96, 44, 36, 0.6)';
    default:
      return 'rgba(30, 38, 50, 0.55)';
  }
}

function buttonRing(slot: ButtonSlot, active: boolean): string {
  if (active) return 'rgba(255,255,255,0.95)';
  switch (slot) {
    case 'sprint':
      return 'rgba(120, 220, 255, 0.6)';
    case 'mid':
      return 'rgba(120, 230, 160, 0.6)';
    case 'action':
      return 'rgba(255, 150, 120, 0.65)';
    default:
      return 'rgba(255,255,255,0.5)';
  }
}

function chargeColor(charge: number): string {
  // Green → amber → hot as the meter fills.
  if (charge >= 0.99) return 'rgba(255, 90, 90, 0.98)';
  if (charge >= 0.66) return 'rgba(255, 184, 0, 0.96)';
  return 'rgba(150, 235, 130, 0.95)';
}

// ───────────────────────────── Banners ─────────────────────────────

function drawBanner(ctx: CanvasRenderingContext2D, world: GameWorld, view: HudView): void {
  const banner = bannerForState(world);
  if (!banner) return;

  // Animated alpha: ease in over the first ~0.45s of the state.
  const t = clamp01(world.stateTimer / 0.45);
  const alpha = ease.outCubic(t);
  const pop = ease.outBack(t); // overshoot scale-in

  const cx = view.width / 2;
  const cy = view.height * 0.4;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const titleSize = Math.round(Math.min(view.width, view.height) * 0.11);
  const size = Math.max(34, Math.min(96, titleSize)) * (0.9 + 0.1 * pop);

  // Shadow plate behind the text for legibility over the pitch.
  ctx.font = `800 ${size}px ${FONT}`;
  const metrics = ctx.measureText(banner.title);
  const plateW = metrics.width + size * 0.9;
  const plateH = size * 1.5;
  roundRect(ctx, cx - plateW / 2, cy - plateH / 2, plateW, plateH, plateH * 0.25);
  ctx.fillStyle = 'rgba(8, 12, 18, 0.5)';
  ctx.fill();

  // Title text with a crisp outline.
  ctx.lineWidth = Math.max(4, size * 0.08);
  ctx.strokeStyle = 'rgba(8, 12, 18, 0.85)';
  ctx.strokeText(banner.title, cx, cy);
  ctx.fillStyle = banner.color;
  ctx.fillText(banner.title, cx, cy);

  // Optional subtitle (score / instruction).
  if (banner.subtitle) {
    const subSize = Math.max(16, size * 0.32);
    ctx.font = `600 ${subSize}px ${FONT}`;
    ctx.lineWidth = Math.max(3, subSize * 0.12);
    ctx.strokeStyle = 'rgba(8, 12, 18, 0.85)';
    const subY = cy + plateH * 0.62 + subSize * 0.6;
    ctx.strokeText(banner.subtitle, cx, subY);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(banner.subtitle, cx, subY);
  }

  ctx.restore();
}

interface Banner {
  title: string;
  subtitle: string | null;
  color: string;
}

function bannerForState(world: GameWorld): Banner | null {
  const home = world.teams[TeamSide.HOME];
  const away = world.teams[TeamSide.AWAY];
  const finalScore = `${home.shortName} ${home.score} - ${away.score} ${away.shortName}`;

  switch (world.state) {
    case MatchState.KICKOFF:
      return { title: 'KICK OFF', subtitle: null, color: '#ffffff' };
    case MatchState.GOAL_CELEBRATION:
      return { title: 'GOAL!', subtitle: null, color: '#ffd84d' };
    case MatchState.HALF_TIME:
      return { title: 'HALF TIME', subtitle: finalScore, color: '#ffffff' };
    case MatchState.MATCH_END:
      return {
        title: world.resultText || 'FULL TIME',
        subtitle: finalScore,
        color: '#ffd84d',
      };
    case MatchState.FREE_KICK:
      return { title: 'FREE KICK', subtitle: null, color: '#ffffff' };
    case MatchState.PENALTY:
      return {
        title: 'PENALTY',
        subtitle: penaltyInstruction(world),
        color: '#ff7a7a',
      };
    case MatchState.FOUL:
    case MatchState.PLAYING:
      return null;
    default:
      return null;
  }
}

/** Instruction line for a penalty depends on whether the user attacks or defends. */
function penaltyInstruction(world: GameWorld): string {
  const sp = world.setPiece;
  // If the user's team is taking the penalty they aim & shoot; otherwise they dive.
  const userTaking = sp ? sp.forSide === world.userSide : false;
  return userTaking ? 'Aim & shoot' : 'Swipe to dive';
}

// ───────────────────────────── Helpers ─────────────────────────────

/** Format simulated seconds as mm:ss (e.g. 5400 → "90:00"). */
function formatClock(simSeconds: number): string {
  const total = Math.max(0, Math.floor(simSeconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Keep short names compact for the pill (defensive truncation). */
function shortLabel(name: string): string {
  const n = (name || '').trim();
  if (n.length <= 4) return n.toUpperCase();
  return n.slice(0, 4).toUpperCase();
}

/** Path a rounded rectangle (does not fill/stroke). */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
