/**
 * The main canvas renderer.
 *
 * Draws the whole world in screen space using MANUAL projection via `worldToScreen` — the
 * only transform set on the 2D context is the device-pixel-ratio scale, so every world-space
 * coordinate is projected by hand exactly the way `render/particles.ts` does. This keeps the
 * renderer and the particle system in perfect visual agreement.
 *
 * Orientation reminder (see core/viewport.ts): the pitch LENGTH runs UP the screen. World +x
 * maps to screen UP, world +y maps to screen RIGHT. Circles stay circular (uniform scale), so
 * they are drawn with ctx.arc at the projected centre and radius * scale; rectangles must be
 * projected corner-by-corner because of the 90° rotation.
 */
import type { GameWorld, KitConfig, PitchDims, Player, Renderer, Vec2 } from '@/core/types';
import { MatchState, Rarity } from '@/core/types';
import { PITCH, PITCH_MARGIN, PLAYER, RARITY_TIERS } from '@/core/constants';
import type { ViewTransform } from '@/core/viewport';
import { clampCameraCenter, computeScale, makeTransform, worldToScreen } from '@/core/viewport';
import { drawParticles } from '@/render/particles';
import { renderHud, type HudView } from '@/render/hud';

// ───────────────────────────── Palette ─────────────────────────────

const COL = {
  outField: '#0b1f12',
  grassA: '#2f7d3f',
  grassB: '#2a7239',
  grassDarkA: '#256b32',
  line: 'rgba(244,250,246,0.92)',
  net: 'rgba(255,255,255,0.30)',
  goalPost: '#f2f6f4',
  shadow: 'rgba(0,0,0,0.28)',
  ball: '#fbfdff',
  ballMark: '#1b2026',
  userRing: '#3fe0ff',
  reticle: '#ff4d4d',
  indicator: 'rgba(255,255,255,0.78)',
  skin: '#e8b48a',
  staminaLow: '#ff5a5a',
  staminaHi: '#7dff8a',
} as const;

// ───────────────────────────── Renderer ─────────────────────────────

interface RendererState {
  ctx: CanvasRenderingContext2D | null;
  cssW: number;
  cssH: number;
  dpr: number;
  /** Rolling smoothed frame interval (s) derived purely from world.time deltas. */
  fpsSmoothDt: number;
  lastWorldTime: number;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const s: RendererState = {
    ctx: null,
    cssW: 0,
    cssH: 0,
    dpr: 1,
    fpsSmoothDt: 1 / 60,
    lastWorldTime: 0,
  };

  function resize(cssWidth: number, cssHeight: number, dpr: number): void {
    s.cssW = cssWidth;
    s.cssH = cssHeight;
    s.dpr = dpr;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.ctx = ctx;
    }
  }

  function render(world: GameWorld): void {
    const ctx = s.ctx;
    if (!ctx || s.cssW <= 0 || s.cssH <= 0) return;

    // Reset to the dpr transform every frame so all drawing stays in CSS pixels even if a
    // nested save/restore were ever to leak.
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);

    const cam = world.camera;
    // Bake the camera zoom (goal/penalty punch-in) into the single shared scale so the camera
    // clamp, world→screen projection, particles and screen→world all stay consistent.
    const scale = computeScale(s.cssW, s.cssH, PITCH) * (cam.zoom || 1);
    const clampedCenter = clampCameraCenter(
      { x: cam.position.x + cam.offset.x, y: cam.position.y + cam.offset.y },
      s.cssW,
      s.cssH,
      scale,
      PITCH,
    );
    const t = makeTransform(
      s.cssW,
      s.cssH,
      {
        position: clampedCenter,
        offset: { x: 0, y: 0 },
        target: cam.target,
        zoom: cam.zoom,
        targetZoom: cam.targetZoom,
        shake: cam.shake,
      },
      scale,
    );

    // Background (out-of-pitch).
    ctx.fillStyle = COL.outField;
    ctx.fillRect(0, 0, s.cssW, s.cssH);

    drawPitch(ctx, world, t);
    drawShadows(ctx, world, t);
    drawPlayers(ctx, world, t);
    drawBall(ctx, world, t);

    drawParticles(ctx, world, t);

    drawOffscreenIndicators(ctx, world, t);
    drawSetPieceOverlay(ctx, world, t);

    if (world.config.showFps) {
      // Derive a frame interval purely from the monotonic sim clock — no wall-clock APIs.
      const rawDt = world.time - s.lastWorldTime;
      s.lastWorldTime = world.time;
      if (rawDt > 1e-4 && rawDt < 0.5) {
        s.fpsSmoothDt = s.fpsSmoothDt * 0.9 + rawDt * 0.1;
      }
      drawFps(ctx, s.fpsSmoothDt);
    }

    const view: HudView = { width: s.cssW, height: s.cssH, dpr: s.dpr };
    renderHud(ctx, world, view);
  }

  return { resize, render };
}

// ───────────────────────────── Pitch ─────────────────────────────

function drawPitch(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void {
  const p = world.pitch;
  const lw = Math.max(1.5, 2.5 * t.scale);

  ctx.save();

  // Grass background that extends a margin beyond the touchlines so the field never shows the
  // out-of-pitch colour while in normal play.
  fillWorldRect(
    ctx,
    t,
    -p.halfLength - PITCH_MARGIN,
    p.halfLength + PITCH_MARGIN,
    -p.halfWidth - PITCH_MARGIN,
    p.halfWidth + PITCH_MARGIN,
    COL.grassDarkA,
  );

  // Mown stripes running across the width (bands along the LENGTH/x axis → horizontal screen
  // stripes). Alternate two greens.
  const stripeCount = 16;
  const stripeW = p.length / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    const x0 = -p.halfLength + i * stripeW;
    const x1 = x0 + stripeW;
    fillWorldRect(ctx, t, x0, x1, -p.halfWidth, p.halfWidth, i % 2 === 0 ? COL.grassA : COL.grassB);
  }

  // ── White markings ──
  ctx.lineWidth = lw;
  ctx.strokeStyle = COL.line;
  ctx.lineJoin = 'round';

  // Touchline / boundary rectangle.
  strokeWorldRect(ctx, t, -p.halfLength, p.halfLength, -p.halfWidth, p.halfWidth);

  // Halfway line (x = 0, full width).
  strokeWorldLine(ctx, t, 0, -p.halfWidth, 0, p.halfWidth);

  // Centre circle + spot.
  strokeWorldCircle(ctx, t, 0, 0, p.centerCircleRadius);
  fillWorldDot(ctx, t, 0, 0, Math.max(1.5, 2.4 * t.scale));

  // Per-goal-end features.
  drawGoalEnd(ctx, t, p, -1); // HOME end (-x)
  drawGoalEnd(ctx, t, p, +1); // AWAY end (+x)

  // Corner arcs.
  drawCornerArc(ctx, t, p, -p.halfLength, -p.halfWidth);
  drawCornerArc(ctx, t, p, -p.halfLength, p.halfWidth);
  drawCornerArc(ctx, t, p, p.halfLength, -p.halfWidth);
  drawCornerArc(ctx, t, p, p.halfLength, p.halfWidth);

  ctx.restore();
}

/** Draws penalty box, goal area, spot, penalty arc, and the goal+net at one end. `sign` is the x sign of the goal line. */
function drawGoalEnd(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  p: PitchDims,
  sign: 1 | -1,
): void {
  const lineX = sign * p.halfLength;

  // Penalty box (depth inward from the line).
  const pbInner = lineX - sign * p.penaltyBoxDepth;
  strokeWorldRect(ctx, t, Math.min(lineX, pbInner), Math.max(lineX, pbInner), -p.penaltyBoxWidth / 2, p.penaltyBoxWidth / 2);

  // Goal area (six-yard box).
  const gaInner = lineX - sign * p.goalAreaDepth;
  strokeWorldRect(ctx, t, Math.min(lineX, gaInner), Math.max(lineX, gaInner), -p.goalAreaWidth / 2, p.goalAreaWidth / 2);

  // Penalty spot.
  const spotX = lineX - sign * p.penaltySpotDist;
  fillWorldDot(ctx, t, spotX, 0, Math.max(1.5, 2.2 * t.scale));

  // Penalty arc — the segment of the circle (radius = centerCircleRadius) around the spot that
  // lies OUTSIDE the penalty box. The box edge is at pbInner; the arc is the part beyond it.
  drawPenaltyArc(ctx, t, p, spotX, pbInner, sign);

  // Goal: posts at y = ±goalWidth/2, net extending goalDepth behind the line.
  const behind = lineX + sign * p.goalDepth;
  ctx.save();
  // Net hatch fill behind the line.
  drawNet(ctx, t, p, lineX, behind, sign);
  // Posts / crossbar frame drawn as a thicker white rectangle.
  ctx.lineWidth = Math.max(2, 3.2 * t.scale);
  ctx.strokeStyle = COL.goalPost;
  strokeWorldRect(
    ctx,
    t,
    Math.min(lineX, behind),
    Math.max(lineX, behind),
    -p.goalWidth / 2,
    p.goalWidth / 2,
  );
  ctx.restore();
}

/**
 * The "D" outside the penalty box: the part of the circle (radius = centerCircleRadius)
 * centred on the penalty spot that lies BEYOND the box edge (toward the pitch centre).
 * Sampled as a world-space polyline so it survives the 90° projection without angle bookkeeping.
 */
function drawPenaltyArc(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  p: PitchDims,
  spotX: number,
  boxEdgeX: number,
  sign: 1 | -1,
): void {
  const r = p.centerCircleRadius;
  const dx = boxEdgeX - spotX; // x of the box edge relative to the spot
  if (Math.abs(dx) >= r) return;
  // World angle (about the spot) where the circle meets the box edge.
  const cross = Math.acos(dx / r); // in (0, PI)
  // The visible arc is the one bulging toward the pitch centre. Centre is at -sign in x relative
  // to the spot, i.e. world angle PI for sign +1 and 0 for sign -1.
  const aStart = sign < 0 ? -cross : Math.PI - cross;
  const aEnd = sign < 0 ? cross : Math.PI + cross;
  const steps = 22;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = aStart + ((aEnd - aStart) * i) / steps;
    const sc = worldToScreen(t, spotX + r * Math.cos(a), r * Math.sin(a));
    if (i === 0) ctx.moveTo(sc.x, sc.y);
    else ctx.lineTo(sc.x, sc.y);
  }
  ctx.stroke();
}

function drawCornerArc(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  p: PitchDims,
  cx: number,
  cy: number,
): void {
  const c = worldToScreen(t, cx, cy);
  ctx.beginPath();
  ctx.arc(c.x, c.y, p.cornerRadius * t.scale, 0, Math.PI * 2);
  ctx.stroke();
}

function drawNet(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  p: PitchDims,
  lineX: number,
  behindX: number,
  _sign: 1 | -1,
): void {
  const yTop = -p.goalWidth / 2;
  const yBot = p.goalWidth / 2;
  ctx.save();
  // Fill a faint dark backing so the net reads as depth.
  fillWorldRect(ctx, t, Math.min(lineX, behindX), Math.max(lineX, behindX), yTop, yBot, 'rgba(0,0,0,0.18)');
  ctx.lineWidth = Math.max(0.5, 0.7 * t.scale);
  ctx.strokeStyle = COL.net;
  // Hatch lines along width.
  const wLines = 7;
  for (let i = 1; i < wLines; i++) {
    const y = yTop + ((yBot - yTop) * i) / wLines;
    strokeWorldLine(ctx, t, Math.min(lineX, behindX), y, Math.max(lineX, behindX), y);
  }
  // Hatch lines along depth.
  const dLines = 4;
  for (let i = 1; i < dLines; i++) {
    const x = lineX + ((behindX - lineX) * i) / dLines;
    strokeWorldLine(ctx, t, x, yTop, x, yBot);
  }
  ctx.restore();
}

// ───────────────────────────── Shadows ─────────────────────────────

function drawShadows(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void {
  ctx.save();
  ctx.fillStyle = COL.shadow;
  for (const pl of world.players) {
    if (pl.sentOff) continue;
    const sc = worldToScreen(t, pl.position.x, pl.position.y);
    ellipse(ctx, sc.x, sc.y + pl.radius * t.scale * 0.4, pl.radius * t.scale * 1.05, pl.radius * t.scale * 0.5);
  }
  // Ball shadow stays on the ground beneath the (possibly lifted) ball.
  const b = world.ball;
  const bsc = worldToScreen(t, b.position.x, b.position.y);
  const liftFade = 1 / (1 + b.z * 0.01);
  ctx.globalAlpha = 0.28 * liftFade;
  const r = b.radius * t.scale * (1 + b.z * 0.004);
  ellipse(ctx, bsc.x, bsc.y, r * 1.1, r * 0.55);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ───────────────────────────── Players ─────────────────────────────

function drawPlayers(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void {
  // Painter's order: smaller screen.y (further up the pitch / further away) drawn first.
  const drawable = world.players.filter((pl) => !pl.sentOff);
  const order = drawable
    .map((pl) => ({ pl, sy: worldToScreen(t, pl.position.x, pl.position.y).y }))
    .sort((a, b) => a.sy - b.sy);

  for (const { pl } of order) {
    drawPlayer(ctx, world, t, pl);
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform, pl: Player): void {
  const sc = worldToScreen(t, pl.position.x, pl.position.y);
  const scale = t.scale;
  const kit = world.teams[pl.side].kit;
  const isActive = pl.id === world.activePlayerId;

  // Convert the world facing into a screen heading. World dir (cos f, sin f) → screen (sin f, -cos f).
  const fx = Math.sin(pl.facing);
  const fy = -Math.cos(pl.facing);
  const heading = Math.atan2(fy, fx);

  // Player body sizes scale with the view (capped so they stay readable when zoomed out).
  const u = Math.max(0.55, Math.min(1.6, scale)); // visual unit
  const headR = 9.5 * u;
  const bodyW = 12 * u;
  const bodyH = 13 * u;
  const legLen = 7.5 * u;

  // Team ground marker — a filled disc in the team colour beneath every player. This makes
  // the two sides instantly distinguishable at a glance, regardless of how close the kits are.
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = kit.primary;
  ctx.beginPath();
  ctx.ellipse(sc.x, sc.y + 3 * u, headR * 0.95, headR * 0.95 * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.4 * u);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.restore();

  // Active-player ring at the feet — bright white halo so the controlled player stands out
  // from team-mates that share the team colour.
  if (isActive) {
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = Math.max(2.5, 3 * u);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(sc.x, sc.y + 3 * u, headR + 7 * u, (headR + 7 * u) * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, 1.6 * u);
    ctx.strokeStyle = COL.userRing;
    ctx.beginPath();
    ctx.ellipse(sc.x, sc.y + 3 * u, headR + 5 * u, (headR + 5 * u) * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.lineWidth = Math.max(1, 1.1 * u);
  ctx.strokeStyle = 'rgba(10,14,18,0.85)';
  ctx.lineJoin = 'round';

  const sliding = pl.slideTimer > 0;
  const kicking = pl.kickAnimTimer > 0;

  if (sliding) {
    drawSlidingPose(ctx, sc, heading, u, bodyW, bodyH, headR, kit);
  } else {
    // Running cycle: leg swing amplitude grows with horizontal speed.
    const speed = Math.hypot(pl.velocity.x, pl.velocity.y);
    const stride = Math.min(1, speed / Math.max(1, pl.maxSpeed)) ;
    const swing = Math.sin(pl.animPhase) * (0.4 + 0.9 * stride);

    // Perpendicular (for left/right offsets) in screen space.
    const px = -fy;
    const py = fx;

    const torsoY = sc.y - bodyH * 0.5;

    // Legs (two, animated). Anchor at hips ~ torsoY + bodyH*0.5.
    const hipX = sc.x;
    const hipY = sc.y - bodyH * 0.1;
    const legBack = kicking ? -0.2 : swing;
    const legFront = kicking ? extendKickSwing(pl) : -swing;
    ctx.strokeStyle = kit.shorts;
    ctx.lineWidth = Math.max(2, 3.2 * u);
    // Left leg
    drawLeg(ctx, hipX - px * bodyW * 0.18, hipY, fx, fy, px, py, legLen, legFront, u);
    // Right leg
    drawLeg(ctx, hipX + px * bodyW * 0.18, hipY, fx, fy, px, py, legLen, legBack, u);

    // Torso (kit primary with secondary trim).
    ctx.lineWidth = Math.max(1, 1.1 * u);
    ctx.strokeStyle = 'rgba(10,14,18,0.85)';
    drawTorso(ctx, sc.x, torsoY, bodyW, bodyH, fx, fy, kit, u);

    // Jersey number.
    drawNumber(ctx, sc.x, torsoY, bodyH, kit.accent, pl.number, u);

    // Head (big-head cartoon, skin tone) above the torso, offset slightly toward facing.
    const headY = torsoY - bodyH * 0.55 - headR * 0.5;
    const headX = sc.x + fx * headR * 0.18;
    drawHead(ctx, headX, headY + fy * headR * 0.12, headR, u);
  }

  // Stamina arc (subtle) above the head when notably tired.
  if (pl.stamina < PLAYER.staminaMax - 2) {
    drawStaminaArc(ctx, sc.x, sc.y - bodyH - headR * 1.4 - 4 * u, headR * 0.9, pl.stamina / PLAYER.staminaMax, u);
  }

  // Rarity glow ring for high-tier carriers (very subtle).
  if (world.config.rarityVfxEnabled && world.ball.owner === pl.id) {
    drawRarityGlow(ctx, sc.x, sc.y + 2 * u, headR, pl.rarity, u);
  }

  ctx.restore();
}

function drawLeg(
  ctx: CanvasRenderingContext2D,
  hx: number,
  hy: number,
  fx: number,
  fy: number,
  _px: number,
  _py: number,
  legLen: number,
  swing: number,
  _u: number,
): void {
  // Foot extends forward/back along facing by `swing`, dropping below the hip.
  const footX = hx + fx * legLen * swing;
  const footY = hy + legLen * 0.9 - fy * legLen * swing * 0.4;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(footX, footY);
  ctx.stroke();
}

function extendKickSwing(pl: Player): number {
  // 1 → fully extended forward at the start of the kick, easing back.
  const tnorm = 1 - Math.min(1, pl.kickAnimTimer / PLAYER.kickAnimTime);
  return 1.4 * (1 - tnorm * tnorm);
}

function drawTorso(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  fx: number,
  _fy: number,
  kit: KitConfig,
  u: number,
): void {
  ctx.save();
  ctx.fillStyle = kit.primary;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 3 * u);
  ctx.fill();
  ctx.stroke();
  // Secondary trim: a vertical stripe down the centre, slightly biased by facing for a hint of 3D.
  ctx.fillStyle = kit.secondary;
  const stripeW = w * 0.22;
  ctx.fillRect(cx - stripeW / 2 + fx * w * 0.06, cy - h / 2 + 1.2 * u, stripeW, h - 2.4 * u);
  ctx.restore();
}

function drawNumber(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  h: number,
  accent: string,
  num: number,
  u: number,
): void {
  ctx.save();
  ctx.fillStyle = accent;
  ctx.font = `${Math.max(6, Math.round(h * 0.55))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), cx, cy + 0.5 * u);
  ctx.restore();
}

function drawHead(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, u: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = COL.skin;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.1 * u);
  ctx.strokeStyle = 'rgba(10,14,18,0.85)';
  ctx.stroke();
  // Simple hair cap on the top third.
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 1.05, Math.PI * 1.95, false);
  ctx.lineWidth = Math.max(1.5, r * 0.4);
  ctx.strokeStyle = 'rgba(40,28,20,0.9)';
  ctx.stroke();
  ctx.restore();
}

function drawSlidingPose(
  ctx: CanvasRenderingContext2D,
  sc: Vec2,
  heading: number,
  u: number,
  bodyW: number,
  bodyH: number,
  headR: number,
  kit: KitConfig,
): void {
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  ctx.save();
  // Body low: torso ellipse along the facing direction, one leg extended forward.
  const cx = sc.x - fx * bodyW * 0.2;
  const cy = sc.y - bodyH * 0.18;
  // Extended sliding leg.
  ctx.lineWidth = Math.max(2, 3.4 * u);
  ctx.strokeStyle = kit.shorts;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + fx * bodyW * 1.6, cy + fy * bodyW * 1.6);
  ctx.stroke();
  // Torso (rotated rounded rect approximated by ellipse).
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(heading);
  ctx.fillStyle = kit.primary;
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyW * 0.62, bodyH * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.1 * u);
  ctx.strokeStyle = 'rgba(10,14,18,0.85)';
  ctx.stroke();
  ctx.restore();
  // Head trailing behind the slide.
  drawHead(ctx, cx - fx * bodyW * 0.5, cy - fy * bodyW * 0.5 - headR * 0.3, headR * 0.92, u);
  ctx.restore();
}

function drawStaminaArc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  frac: number,
  u: number,
): void {
  const f = Math.max(0, Math.min(1, frac));
  ctx.save();
  ctx.lineWidth = Math.max(1.2, 1.6 * u);
  // Track.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.85, Math.PI * 0.15, false);
  ctx.stroke();
  // Fill.
  ctx.strokeStyle = f < 0.28 ? COL.staminaLow : COL.staminaHi;
  const a0 = Math.PI * 0.85;
  const span = (Math.PI * 2 - Math.PI * 0.7); // from 0.85π wrapping to 0.15π
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a0 + span * f, false);
  ctx.stroke();
  ctx.restore();
}

function drawRarityGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  headR: number,
  rarity: Rarity,
  u: number,
): void {
  const tier = RARITY_TIERS[rarity];
  if (rarity === Rarity.COMMON || rarity === Rarity.RARE) return; // no glow for low tiers
  ctx.save();
  ctx.lineWidth = Math.max(1.5, 2 * u);
  ctx.strokeStyle = tier.color;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.ellipse(cx, cy, headR + 8 * u, (headR + 8 * u) * 0.55, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ───────────────────────────── Ball ─────────────────────────────

function drawBall(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void {
  const b = world.ball;
  const sc = worldToScreen(t, b.position.x, b.position.y);
  const r = Math.max(2.5, b.radius * t.scale);
  const lift = b.z * t.scale * 0.6;
  const cy = sc.y - lift;

  ctx.save();
  // White sphere.
  ctx.beginPath();
  ctx.arc(sc.x, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = COL.ball;
  ctx.fill();
  ctx.lineWidth = Math.max(0.8, 0.9 * t.scale);
  ctx.strokeStyle = 'rgba(20,26,32,0.5)';
  ctx.stroke();

  // A couple of dark pentagon marks rotated by accumulated spin.
  const spinAngle = b.spin * 0.02 + world.time * 1.2;
  ctx.fillStyle = COL.ballMark;
  drawPentagon(ctx, sc.x, cy, r * 0.42, spinAngle);
  drawPentagon(ctx, sc.x + Math.cos(spinAngle) * r * 0.5, cy + Math.sin(spinAngle) * r * 0.5, r * 0.2, -spinAngle * 0.7);
  ctx.restore();
}

function drawPentagon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rot: number): void {
  if (r < 0.6) return;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = rot + (i / 5) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

// ───────────────────────────── Off-screen indicators ─────────────────────────────

function drawOffscreenIndicators(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void {
  const pad = 22;
  const minX = pad;
  const minY = pad + 56; // keep clear of the scoreboard up top
  const maxX = t.cx * 2 - pad;
  const maxY = t.cy * 2 - pad;

  ctx.save();

  // Teammates of the user's active player.
  for (const pl of world.players) {
    if (pl.sentOff) continue;
    if (pl.side !== world.userSide) continue;
    if (pl.id === world.activePlayerId) continue;
    const sc = worldToScreen(t, pl.position.x, pl.position.y);
    if (sc.x >= 0 && sc.x <= t.cx * 2 && sc.y >= 0 && sc.y <= t.cy * 2) continue;
    drawEdgeArrow(ctx, sc, minX, minY, maxX, maxY, world.teams[pl.side].kit.primary, 0.42);
  }

  // The ball, if off-screen.
  const bsc = worldToScreen(t, world.ball.position.x, world.ball.position.y);
  if (bsc.x < 0 || bsc.x > t.cx * 2 || bsc.y < 0 || bsc.y > t.cy * 2) {
    drawEdgeArrow(ctx, bsc, minX, minY, maxX, maxY, COL.indicator, 0.7);
  }

  ctx.restore();
}

function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  target: Vec2,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  color: string,
  alpha: number,
): void {
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return;
  // Clamp the point to the inner rectangle along the direction to the target.
  const clampedX = Math.max(minX, Math.min(maxX, target.x));
  const clampedY = Math.max(minY, Math.min(maxY, target.y));
  const ang = Math.atan2(dy, dx);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(clampedX, clampedY);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(-6, 6);
  ctx.lineTo(-6, -6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ───────────────────────────── Set-piece overlay ─────────────────────────────

function drawSetPieceOverlay(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void {
  if (world.state !== MatchState.PENALTY || !world.setPiece) return;
  const sc = worldToScreen(t, world.setPiece.reticle.x, world.setPiece.reticle.y);
  const r = 16 + Math.sin(world.time * 6) * 2.5;
  ctx.save();
  ctx.strokeStyle = COL.reticle;
  ctx.lineWidth = 2.4;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(sc.x, sc.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sc.x, sc.y, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  // Crosshair ticks.
  ctx.beginPath();
  ctx.moveTo(sc.x - r - 5, sc.y);
  ctx.lineTo(sc.x - r + 4, sc.y);
  ctx.moveTo(sc.x + r - 4, sc.y);
  ctx.lineTo(sc.x + r + 5, sc.y);
  ctx.moveTo(sc.x, sc.y - r - 5);
  ctx.lineTo(sc.x, sc.y - r + 4);
  ctx.moveTo(sc.x, sc.y + r - 4);
  ctx.lineTo(sc.x, sc.y + r + 5);
  ctx.stroke();
  ctx.restore();
}

// ───────────────────────────── FPS ─────────────────────────────

function drawFps(ctx: CanvasRenderingContext2D, smoothDt: number): void {
  const fps = smoothDt > 1e-4 ? Math.round(1 / smoothDt) : 0;
  ctx.save();
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(6, 6, 52, 18);
  ctx.fillStyle = '#bfffbf';
  ctx.fillText(`${fps} fps`, 11, 9);
  ctx.restore();
}

// ───────────────────────────── World-space primitives ─────────────────────────────
// All take world coordinates and project corner-by-corner (rectangles/lines) or use the
// uniform scale (circles). The world is rotated 90°, so rectangles become rotated screen quads.

function fillWorldRect(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  color: string,
): void {
  const a = worldToScreen(t, x0, y0);
  const b = worldToScreen(t, x1, y0);
  const c = worldToScreen(t, x1, y1);
  const d = worldToScreen(t, x0, y1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function strokeWorldRect(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  const a = worldToScreen(t, x0, y0);
  const b = worldToScreen(t, x1, y0);
  const c = worldToScreen(t, x1, y1);
  const d = worldToScreen(t, x0, y1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
  ctx.stroke();
}

function strokeWorldLine(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const a = worldToScreen(t, x0, y0);
  const b = worldToScreen(t, x1, y1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function strokeWorldCircle(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  cx: number,
  cy: number,
  r: number,
): void {
  const c = worldToScreen(t, cx, cy);
  ctx.beginPath();
  ctx.arc(c.x, c.y, r * t.scale, 0, Math.PI * 2);
  ctx.stroke();
}

function fillWorldDot(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  cx: number,
  cy: number,
  rPx: number,
): void {
  const c = worldToScreen(t, cx, cy);
  ctx.beginPath();
  ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2);
  ctx.fillStyle = COL.line;
  ctx.fill();
}

// ───────────────────────────── Screen-space primitives ─────────────────────────────

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(0.6, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
