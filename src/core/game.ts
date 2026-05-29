/**
 * The master game loop. Fixed-timestep simulation (deterministic) decoupled from rendering,
 * orchestrating the systems in a strict order each tick. Hit-stop freezes the simulation for
 * a few frames of game-feel while rendering continues.
 */
import { FIXED_DT, MAX_FRAME_DT, MAX_SUBSTEPS } from './constants';
import { MatchState, TeamSide, type AudioSystem, type GameWorld, type InputSystem, type Renderer } from './types';

import { updatePhysics } from '@/systems/physics';
import { updateControl, updateUserActions } from '@/systems/actions';
import { updateAI } from '@/systems/ai';
import { updateCamera, snapCameraToBall } from '@/systems/camera';
import { updateMatch, setupKickoff } from '@/systems/matchController';
import { updateParticles } from '@/render/particles';

/** States in which the physics simulation advances. */
const SIM_STATES = new Set<MatchState>([
  MatchState.PLAYING,
  MatchState.KICKOFF,
  MatchState.FREE_KICK,
  MatchState.PENALTY,
]);

export interface GameDeps {
  renderer: Renderer;
  input: InputSystem;
  audio: AudioSystem;
}

export class Game {
  world: GameWorld;
  onMatchEnd?: (world: GameWorld) => void;

  private deps: GameDeps;
  private rafId = 0;
  private lastTime = 0;
  private acc = 0;
  private running = false;
  private endedNotified = false;

  constructor(deps: GameDeps, world: GameWorld) {
    this.deps = deps;
    this.world = world;
  }

  /** Begin a fresh match on the current world: arrange the kickoff and start ticking. */
  startMatch(kickoffSide: TeamSide = TeamSide.HOME): void {
    setupKickoff(this.world, kickoffSide);
    snapCameraToBall(this.world);
    this.acc = 0;
    this.endedNotified = false;
    this.lastTime = 0;
    this.start();
  }

  /** Replace the active world (e.g. for a new match) without recreating systems. */
  setWorld(world: GameWorld): void {
    this.world = world;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.deps.renderer.resize(cssW, cssH, dpr);
    this.deps.input.resize(cssW, cssH);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    if (this.lastTime === 0) this.lastTime = now;
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    if (dt < 0) dt = 0;

    const world = this.world;

    // Hit-stop: freeze the sim, keep the camera + render alive for a punchy beat.
    if (world.hitStop > 0) {
      world.hitStop = Math.max(0, world.hitStop - dt);
      updateCamera(world, dt);
      world.events.length = 0;
      this.deps.renderer.render(world);
      return;
    }

    // Fixed-timestep accumulation for deterministic physics.
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.step(FIXED_DT);
      this.acc -= FIXED_DT;
      steps++;
      if (world.hitStop > 0) {
        // A hit-stop was triggered mid-step; drop leftover accumulation to avoid catch-up.
        this.acc = 0;
        break;
      }
    }
    // Guard against the spiral of death after a long stall.
    if (steps >= MAX_SUBSTEPS) this.acc = 0;

    this.deps.renderer.render(world);
  };

  private step(dt: number): void {
    const world = this.world;

    // 1. Gather input into world.input.
    this.deps.input.sample(world, dt);

    // 2. Control mapping (possession → control mode, switching, action-lock timers).
    updateControl(world, dt);

    // 3. Decision + action layer.
    if (world.state === MatchState.PLAYING) {
      updateUserActions(world, dt);
    }
    updateAI(world, dt); // self-gates on state internally

    // 4. Integrate physics where the sim is active.
    if (SIM_STATES.has(world.state)) {
      updatePhysics(world, dt);
    }

    // 5. Match flow: clock, goals, out-of-bounds, fouls, set pieces, state transitions.
    updateMatch(world, dt);

    // 6. Presentation systems consume the events emitted above.
    updateCamera(world, dt);
    updateParticles(world, dt);
    this.deps.audio.update(world, dt);

    // 7. Clear the per-frame event queue and advance the master clock.
    world.events.length = 0;
    world.time += dt;

    // 8. Match-end notification (once).
    if (world.state === MatchState.MATCH_END && !this.endedNotified) {
      this.endedNotified = true;
      this.onMatchEnd?.(world);
    }
  }
}
