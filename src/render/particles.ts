/**
 * Pooled particle system + rarity VFX trails.
 *
 * Architecture: the pool of `Particle` slots lives on `world.particles`. We never let the
 * array grow past `PARTICLES.max`: a fresh spawn reuses an inactive slot, grows the array up
 * to the cap, or (when the cap is reached and all slots are busy) overwrites the particle with
 * the least remaining life. All randomness flows through `world.rng` so replays match.
 *
 * `updateParticles` reads (but never clears) `world.events` to emit reactive bursts, streams
 * rarity trails behind a high-rarity ball carrier, then integrates every active particle.
 * `drawParticles` paints them cheaply, lifting each by its fake `z` height.
 */
import type { GameWorld, Particle, ParticleKind, Player, Vec2 } from '@/core/types';
import { Rarity } from '@/core/types';
import { PARTICLES, RARITY_TIERS } from '@/core/constants';
import { clamp01, TAU } from '@/utils/math';
import { worldToScreen } from '@/core/viewport';
import type { ViewTransform } from '@/core/viewport';

// ───────────────────────────── Module-local scratch ─────────────────────────────

/** Fractional spawn accumulator for the rarity trail (so a 90/s rate spawns ~1.5/frame). */
let trailAccumulator = 0;

/** Bright confetti palette (no asset dependency — pure synthesised colour). */
const CONFETTI_COLORS = [
  '#ff4d6d',
  '#ffb800',
  '#56b3ff',
  '#5be0a0',
  '#b06bff',
  '#ffffff',
  '#ff8a3d',
];

// ───────────────────────────── Pool helper ─────────────────────────────

/**
 * Grab (or create) a pool slot and initialise it from `p`. Unspecified fields default to
 * sensible inert values. Returns the live particle so callers can tweak it further if needed.
 */
function spawn(world: GameWorld, p: Partial<Particle> & { kind: ParticleKind; position: Vec2 }): Particle {
  const pool = world.particles;

  // 1) Reuse the first inactive slot.
  let slot: Particle | null = null;
  for (let i = 0; i < pool.length; i++) {
    if (!pool[i].active) {
      slot = pool[i];
      break;
    }
  }

  // 2) Otherwise grow up to the cap.
  if (!slot && pool.length < PARTICLES.max) {
    slot = blankParticle();
    pool.push(slot);
  }

  // 3) Otherwise overwrite the particle with the least remaining life.
  if (!slot) {
    let worst = pool[0];
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].life < worst.life) worst = pool[i];
    }
    slot = worst;
  }

  const life = p.life ?? 0.6;
  slot.kind = p.kind;
  slot.position.x = p.position.x;
  slot.position.y = p.position.y;
  slot.velocity.x = p.velocity?.x ?? 0;
  slot.velocity.y = p.velocity?.y ?? 0;
  slot.z = p.z ?? 0;
  slot.zVel = p.zVel ?? 0;
  slot.life = life;
  slot.maxLife = p.maxLife ?? life;
  slot.size = p.size ?? 3;
  slot.color = p.color ?? '#ffffff';
  slot.rotation = p.rotation ?? 0;
  slot.rotationVel = p.rotationVel ?? 0;
  slot.gravity = p.gravity ?? 0;
  slot.drag = p.drag ?? 0;
  slot.active = true;
  return slot;
}

function blankParticle(): Particle {
  return {
    kind: 'dust',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    z: 0,
    zVel: 0,
    life: 0,
    maxLife: 1,
    size: 3,
    color: '#ffffff',
    rotation: 0,
    rotationVel: 0,
    gravity: 0,
    drag: 0,
    active: false,
  };
}

// ───────────────────────────── Event-driven bursts ─────────────────────────────

function emitTackleSpray(world: GameWorld, at: Vec2): void {
  const rng = world.rng;
  for (let i = 0; i < PARTICLES.slideGrassCount; i++) {
    const ang = rng.range(0, TAU);
    const speed = rng.range(70, 230);
    const green = rng.pick(['#3f9a4d', '#56b35a', '#2e7d3a', '#74c267']);
    spawn(world, {
      kind: 'grass',
      position: { x: at.x + rng.jitter(6), y: at.y + rng.jitter(6) },
      velocity: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
      z: rng.range(0, 6),
      zVel: rng.range(120, 280),
      life: rng.range(0.35, 0.7),
      size: rng.range(1.6, 3.2),
      color: green,
      gravity: 620,
      drag: 3.4,
    });
  }
}

function emitGoalConfetti(world: GameWorld, at: Vec2): void {
  const rng = world.rng;
  for (let i = 0; i < PARTICLES.goalConfettiCount; i++) {
    const ang = rng.range(0, TAU);
    const speed = rng.range(40, 220);
    spawn(world, {
      kind: 'confetti',
      position: { x: at.x + rng.jitter(40), y: at.y + rng.jitter(40) },
      velocity: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
      z: rng.range(120, 320),
      zVel: rng.range(40, 220),
      life: rng.range(1.4, 2.8),
      size: rng.range(3, 6),
      color: rng.pick(CONFETTI_COLORS),
      rotation: rng.range(0, TAU),
      rotationVel: rng.jitter(12),
      gravity: 240,
      drag: 1.1,
    });
  }
  // A celebratory expanding ring at the goal.
  spawn(world, {
    kind: 'ring',
    position: { x: at.x, y: at.y },
    velocity: { x: 0, y: 0 },
    life: 0.55,
    size: 18,
    color: '#ffffff',
  });
}

function emitKickDust(world: GameWorld, at: Vec2): void {
  const rng = world.rng;
  for (let i = 0; i < PARTICLES.kickDustCount; i++) {
    const ang = rng.range(0, TAU);
    const speed = rng.range(20, 90);
    spawn(world, {
      kind: 'dust',
      position: { x: at.x + rng.jitter(4), y: at.y + rng.jitter(4) },
      velocity: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
      z: rng.range(0, 4),
      zVel: rng.range(20, 80),
      life: rng.range(0.25, 0.5),
      size: rng.range(1.4, 2.8),
      color: 'rgba(220,224,210,0.85)',
      gravity: 200,
      drag: 4.5,
    });
  }
}

function emitPostSparks(world: GameWorld, at: Vec2): void {
  const rng = world.rng;
  const count = rng.int(4, 7);
  for (let i = 0; i < count; i++) {
    const ang = rng.range(0, TAU);
    const speed = rng.range(140, 340);
    spawn(world, {
      kind: 'spark',
      position: { x: at.x + rng.jitter(3), y: at.y + rng.jitter(3) },
      velocity: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
      z: rng.range(0, 14),
      zVel: rng.range(60, 200),
      life: rng.range(0.18, 0.4),
      size: rng.range(2.4, 4.2),
      color: rng.pick(['#fff2b0', '#ffd24d', '#ffffff']),
      gravity: 360,
      drag: 2.6,
    });
  }
}

function emitBounceDust(world: GameWorld, at: Vec2): void {
  const rng = world.rng;
  const count = rng.int(1, 2);
  for (let i = 0; i < count; i++) {
    const ang = rng.range(0, TAU);
    const speed = rng.range(15, 60);
    spawn(world, {
      kind: 'dust',
      position: { x: at.x + rng.jitter(3), y: at.y + rng.jitter(3) },
      velocity: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
      z: rng.range(0, 3),
      zVel: rng.range(10, 50),
      life: rng.range(0.2, 0.4),
      size: rng.range(1.2, 2.2),
      color: 'rgba(210,214,200,0.55)',
      gravity: 180,
      drag: 5,
    });
  }
}

function emitSaveDust(world: GameWorld, at: Vec2): void {
  const rng = world.rng;
  const count = rng.int(3, 5);
  for (let i = 0; i < count; i++) {
    const ang = rng.range(0, TAU);
    const speed = rng.range(30, 120);
    spawn(world, {
      kind: 'dust',
      position: { x: at.x + rng.jitter(5), y: at.y + rng.jitter(5) },
      velocity: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
      z: rng.range(0, 8),
      zVel: rng.range(40, 130),
      life: rng.range(0.3, 0.55),
      size: rng.range(1.6, 3),
      color: 'rgba(230,234,224,0.8)',
      gravity: 320,
      drag: 4,
    });
  }
}

// ───────────────────────────── Rarity trail ─────────────────────────────

function rarityHasTrail(r: Rarity): boolean {
  return r === Rarity.EPIC || r === Rarity.LEGENDARY || r === Rarity.MYTHICAL;
}

function emitRarityTrail(world: GameWorld, dt: number, owner: Player): void {
  const rng = world.rng;
  const color = RARITY_TIERS[owner.rarity].color;
  const ball = world.ball;

  // Denser stream while this owner is winding up a shot.
  const charging = world.input.shoot.held;
  const rate = PARTICLES.rarityTrailRate * (charging ? 2.1 : 1);

  trailAccumulator += rate * dt;
  let toSpawn = Math.floor(trailAccumulator);
  if (toSpawn <= 0) return;
  trailAccumulator -= toSpawn;
  // Guard against a huge dt spike flooding the pool.
  if (toSpawn > 24) toSpawn = 24;

  for (let i = 0; i < toSpawn; i++) {
    spawn(world, {
      kind: 'trail',
      position: { x: ball.position.x + rng.jitter(3), y: ball.position.y + rng.jitter(3) },
      velocity: { x: rng.jitter(12), y: rng.jitter(12) },
      z: ball.z + rng.range(0, 4),
      zVel: rng.range(6, 24),
      life: rng.range(0.22, 0.42) * (charging ? 1.25 : 1),
      size: rng.range(2.6, 4.6) * (charging ? 1.2 : 1),
      color,
      drag: 2.2,
    });
  }

  // Occasional sparkle stars for LEGENDARY / MYTHICAL flair.
  if ((owner.rarity === Rarity.LEGENDARY || owner.rarity === Rarity.MYTHICAL) && rng.chance(0.18)) {
    spawn(world, {
      kind: 'star',
      position: { x: ball.position.x + rng.jitter(8), y: ball.position.y + rng.jitter(8) },
      velocity: { x: rng.jitter(20), y: rng.jitter(20) },
      z: ball.z + rng.range(4, 16),
      zVel: rng.range(20, 60),
      life: rng.range(0.3, 0.55),
      size: rng.range(3, 5),
      color,
      rotation: rng.range(0, TAU),
      rotationVel: rng.jitter(6),
      drag: 1.8,
    });
  }
}

// ───────────────────────────── Update ─────────────────────────────

export function updateParticles(world: GameWorld, dt: number): void {
  // 1) Reactive bursts from this frame's events. We read but never clear `world.events`.
  for (const ev of world.events) {
    const at = ev.position;
    switch (ev.type) {
      case 'tackle':
        if (at) emitTackleSpray(world, at);
        break;
      case 'goal': {
        const pos = at ?? world.ball.position;
        emitGoalConfetti(world, pos);
        break;
      }
      case 'kick':
      case 'pass':
      case 'shot':
        if (at) emitKickDust(world, at);
        break;
      case 'post':
        if (at) emitPostSparks(world, at);
        break;
      case 'bounce':
        if (at) emitBounceDust(world, at);
        break;
      case 'save':
        emitSaveDust(world, at ?? world.ball.position);
        break;
      // Non-VFX or audio-only events.
      case 'foul':
      case 'whistle':
      case 'cheer':
      case 'switch':
      case 'kickoff':
      case 'button':
      default:
        break;
    }
  }

  // 2) Rarity trail behind a high-rarity ball carrier.
  if (world.config.rarityVfxEnabled && world.ball.owner) {
    const owner = playerById(world, world.ball.owner);
    if (owner && rarityHasTrail(owner.rarity)) {
      emitRarityTrail(world, dt, owner);
    } else {
      trailAccumulator = 0;
    }
  } else {
    trailAccumulator = 0;
  }

  // 3) Integrate every active particle.
  const pool = world.particles;
  for (let i = 0; i < pool.length; i++) {
    const pt = pool[i];
    if (!pt.active) continue;

    // Exponential-ish drag (frame-rate independent enough for short-lived bits).
    if (pt.drag > 0) {
      const d = Math.max(0, 1 - pt.drag * dt);
      pt.velocity.x *= d;
      pt.velocity.y *= d;
    }

    pt.position.x += pt.velocity.x * dt;
    pt.position.y += pt.velocity.y * dt;

    if (pt.gravity > 0 || pt.z > 0 || pt.zVel !== 0) {
      pt.zVel -= pt.gravity * dt;
      pt.z += pt.zVel * dt;
      if (pt.z <= 0) {
        pt.z = 0;
        // Settle grounded kinds: kill the bounce and let drag stop them.
        if (pt.zVel < 0) pt.zVel = 0;
      }
    }

    pt.rotation += pt.rotationVel * dt;
    pt.life -= dt;
    if (pt.life <= 0) pt.active = false;
  }
}

/** Local mirror of physics' lookup so this module stays leaf-level (no system import). */
function playerById(world: GameWorld, id: string): Player | undefined {
  const players = world.players;
  for (let i = 0; i < players.length; i++) {
    if (players[i].id === id) return players[i];
  }
  return undefined;
}

// ───────────────────────────── Draw ─────────────────────────────

export function drawParticles(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void {
  const pool = world.particles;
  const heightLift = t.scale * 0.6;
  ctx.save();
  const prevComposite = ctx.globalCompositeOperation;

  for (let i = 0; i < pool.length; i++) {
    const pt = pool[i];
    if (!pt.active) continue;

    const s = worldToScreen(t, pt.position.x, pt.position.y);
    const sy = s.y - pt.z * heightLift;
    const alpha = clamp01(pt.life / pt.maxLife);
    if (alpha <= 0) continue;

    ctx.globalAlpha = alpha;
    drawOne(ctx, pt, s.x, sy, t.scale);
  }

  ctx.globalCompositeOperation = prevComposite;
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawOne(ctx: CanvasRenderingContext2D, pt: Particle, x: number, y: number, scale: number): void {
  const sz = pt.size * scale;

  switch (pt.kind) {
    case 'spark': {
      // A short bright streak along the velocity direction.
      ctx.strokeStyle = pt.color;
      ctx.lineWidth = Math.max(1, sz * 0.4);
      ctx.lineCap = 'round';
      const vlen = Math.hypot(pt.velocity.x, pt.velocity.y) || 1;
      const dx = (pt.velocity.y / vlen) * sz; // world +y → screen +x
      const dy = (-pt.velocity.x / vlen) * sz; // world +x → screen -y
      ctx.beginPath();
      ctx.moveTo(x - dx, y - dy);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
      break;
    }
    case 'star': {
      drawStar4(ctx, x, y, sz, pt.rotation, pt.color);
      break;
    }
    case 'confetti': {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(pt.rotation);
      ctx.fillStyle = pt.color;
      const w = sz;
      const h = sz * 0.6;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      break;
    }
    case 'grass':
    case 'dust': {
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, sz * 0.5), 0, TAU);
      ctx.fill();
      break;
    }
    case 'ring': {
      // Expands as life falls (size already grows via shrinking alpha; widen by elapsed).
      const grow = 1 + (1 - clamp01(pt.life / pt.maxLife)) * 4;
      ctx.strokeStyle = pt.color;
      ctx.lineWidth = Math.max(1, scale * 1.4);
      ctx.beginPath();
      ctx.arc(x, y, sz * grow, 0, TAU);
      ctx.stroke();
      break;
    }
    case 'trail': {
      // Soft additive glow dot.
      ctx.globalCompositeOperation = 'lighter';
      const r = Math.max(0.6, sz * 0.5);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
      g.addColorStop(0, pt.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 2, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      break;
    }
    case 'sweat': {
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, sz * 0.4), 0, TAU);
      ctx.fill();
      break;
    }
    default:
      break;
  }
}

/** A compact 4-point star (sparkle). */
function drawStar4(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number, color: string): void {
  const inner = r * 0.32;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * TAU;
    const rad = i % 2 === 0 ? r : inner;
    const px = Math.cos(ang) * rad;
    const py = Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
