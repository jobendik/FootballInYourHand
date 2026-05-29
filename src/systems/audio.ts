/**
 * WebAudio synthesised SFX + a light crowd-ambience bed.
 *
 * No samples: every sound is built from `OscillatorNode`s, short noise buffers and
 * gain envelopes routed through a master `GainNode` -> destination. Two sub-gains
 * (`sfxGain`, `musicGain`) let the runtime config mute SFX and crowd independently.
 *
 * Everything is guarded so a method called before `resume()` (or while the context is
 * suspended) is a harmless no-op — WebAudio must be unlocked from a user gesture, and
 * the rest of the game must keep running regardless.
 *
 * Scheduling always uses the WebAudio clock (`ctx.currentTime`), never wall-clock time.
 */
import type { AudioSystem, GameWorld } from '@/core/types';
import { clamp, clamp01 } from '@/utils/math';
import { isInAttackingBox, isInDefensiveBox } from '@/utils/pitch';

// ───────────────────────────── Tuning ─────────────────────────────

const MASTER_GAIN = 0.5;
const SFX_BASE = 0.9; // sfxGain level when SFX enabled
const MUSIC_BASE = 0.55; // musicGain level when crowd ambience enabled

/** Crowd bed sits this low at rest and swells toward 1.0× of itself with excitement. */
const CROWD_FLOOR = 0.12;
const CROWD_CEIL = 1.0;
const CROWD_SMOOTH = 0.6; // exponential smoothing factor per call (lower = snappier)

/** Cap concurrent sounds spawned from a single `update()` so a burst of events stays clean. */
const MAX_SOUNDS_PER_FRAME = 4;

/** Tiny ramp used everywhere to avoid hard clicks when starting/stopping gains. */
const RAMP = 0.012;

// ───────────────────────────── Implementation ─────────────────────────────

class WebAudioSystem implements AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;

  // Reusable shared noise buffer (1s of white noise) for transient bursts.
  private noiseBuffer: AudioBuffer | null = null;

  // Continuous crowd bed.
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdGain: GainNode | null = null;
  private crowdLevel = CROWD_FLOOR;

  // Enable flags (mirrors RuntimeConfig; setEnabled is the source of truth).
  private sfxOn = true;
  private musicOn = true;

  // ── Lifecycle ──────────────────────────────────────────────────

  async resume(): Promise<void> {
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.buildGraph();
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      // (Re)start the ambient crowd bed now that we're unlocked.
      this.startCrowd();
    } catch {
      // Autoplay-policy rejections etc. — stay silent, never throw.
    }
  }

  setEnabled(sfx: boolean, music: boolean): void {
    this.sfxOn = sfx;
    this.musicOn = music;
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      if (this.sfxGain) {
        this.sfxGain.gain.cancelScheduledValues(now);
        this.sfxGain.gain.setTargetAtTime(sfx ? SFX_BASE : 0, now, RAMP);
      }
      if (this.musicGain) {
        this.musicGain.gain.cancelScheduledValues(now);
        this.musicGain.gain.setTargetAtTime(music ? MUSIC_BASE : 0, now, RAMP);
      }
      if (music) this.startCrowd();
      else this.stopCrowd();
    } catch {
      /* no-op */
    }
  }

  // ── Per-frame event drain + ambience ───────────────────────────

  update(world: GameWorld, _dt: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;

    // Crowd excitement: ball near either penalty box -> louder bed.
    this.updateCrowd(world);

    if (!this.sfxOn) return;

    // Drain events (read only — the game loop owns clearing world.events).
    // Throttle: de-dupe identical types within the frame and cap total sounds.
    const seen = new Set<string>();
    let played = 0;
    const now = ctx.currentTime;

    for (let i = 0; i < world.events.length; i++) {
      if (played >= MAX_SOUNDS_PER_FRAME) break;
      const ev = world.events[i];
      const type = ev.type;
      if (seen.has(type)) continue;
      // 'cheer' should be able to layer over a 'goal' in the same frame — but each is
      // still de-duped against itself, which the seen-set already handles.
      seen.add(type);

      const power = clamp01(ev.power ?? 0.5);
      try {
        switch (type) {
          case 'kick':
          case 'pass':
            this.playThump(now, 140, 0.18, 0.7);
            this.playNoiseBurst(now, 0.04, 1200, 0.08, 'highpass');
            played++;
            break;
          case 'shot':
            this.playShot(now, power);
            played++;
            break;
          case 'goal':
            this.playGoal(now);
            this.playCheer(now, 1.0);
            played++;
            break;
          case 'cheer':
            this.playCheer(now, 0.7);
            played++;
            break;
          case 'whistle':
            this.playWhistle(now);
            played++;
            break;
          case 'post':
            this.playPost(now);
            played++;
            break;
          case 'save':
            this.playNoiseBurst(now, 0.16, 320, 0.5, 'lowpass');
            played++;
            break;
          case 'tackle':
            this.playNoiseBurst(now, 0.13, 900, 0.5, 'bandpass', 1.6);
            played++;
            break;
          case 'switch':
            this.playBlip(now, 720, 0.06, 0.35);
            played++;
            break;
          case 'bounce':
            this.playBlip(now, 260, 0.03, 0.12, 'triangle');
            played++;
            break;
          case 'foul':
            // No bespoke foul sting — the controller follows with a 'whistle'; keep quiet.
            break;
          case 'kickoff':
            // Kickoff is announced by the referee 'whistle' event; no separate cue.
            break;
          case 'button':
            this.playBlip(now, 540, 0.05, 0.3);
            played++;
            break;
          default: {
            // Exhaustiveness guard: any unhandled event type is silently ignored.
            const _exhaustive: never = type;
            void _exhaustive;
            break;
          }
        }
      } catch {
        // A failed node creation should never break the game loop.
      }
    }
  }

  // ── One-off UI sounds ──────────────────────────────────────────

  ui(name: 'click' | 'whoosh' | 'reward' | 'error' | 'pack'): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfxOn) return;
    const now = ctx.currentTime;
    try {
      switch (name) {
        case 'click':
          this.playBlip(now, 660, 0.05, 0.3);
          break;
        case 'whoosh':
          this.playNoiseSweep(now, 0.28, 400, 3000, 0.32);
          break;
        case 'reward':
          this.playArpeggio(now, [523.25, 659.25, 783.99, 1046.5], 0.09, 'sine', 0.32);
          break;
        case 'error':
          this.playBuzz(now, 110, 0.26, 0.34);
          break;
        case 'pack':
          this.playArpeggio(now, [659.25, 880, 1174.66, 1567.98, 2093.0], 0.07, 'triangle', 0.26);
          break;
        default: {
          const _exhaustive: never = name;
          void _exhaustive;
          break;
        }
      }
    } catch {
      /* no-op */
    }
  }

  // ── Graph construction ─────────────────────────────────────────

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.master = ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(ctx.destination);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxOn ? SFX_BASE : 0;
    this.sfxGain.connect(this.master);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.musicOn ? MUSIC_BASE : 0;
    this.musicGain.connect(this.master);

    // Shared 1-second white-noise buffer reused by every noise-based effect.
    const len = Math.floor(ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  // ── Crowd ambience ─────────────────────────────────────────────

  private startCrowd(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicGain || !this.noiseBuffer) return;
    if (this.crowdSource) return; // already running
    if (!this.musicOn) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 420;
      filter.Q.value = 0.7;

      const gain = ctx.createGain();
      gain.gain.value = this.crowdLevel;

      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.musicGain);
      src.start();

      this.crowdSource = src;
      this.crowdFilter = filter;
      this.crowdGain = gain;
    } catch {
      /* no-op */
    }
  }

  private stopCrowd(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (this.crowdGain) {
        this.crowdGain.gain.cancelScheduledValues(ctx.currentTime);
        this.crowdGain.gain.setTargetAtTime(0, ctx.currentTime, RAMP);
      }
      if (this.crowdSource) {
        // Stop slightly after the fade so we don't click.
        this.crowdSource.stop(ctx.currentTime + 0.1);
      }
    } catch {
      /* no-op */
    }
    this.crowdSource = null;
    this.crowdFilter = null;
    this.crowdGain = null;
  }

  private updateCrowd(world: GameWorld): void {
    const ctx = this.ctx;
    if (!ctx || !this.crowdGain || !this.crowdFilter) return;

    // Excitement rises as the ball approaches either penalty box.
    let excitement = 0;
    const ball = world.ball.position;
    const userSide = world.userSide;
    if (isInAttackingBox(ball, userSide, world.pitch)) excitement = 1; // user attacking
    else if (isInDefensiveBox(ball, userSide, world.pitch)) excitement = 0.85; // user defending
    else {
      // Smooth proximity falloff using normalised distance to the nearer goal line.
      const halfLen = world.pitch.halfLength;
      const nearGoalDist = halfLen - Math.abs(ball.x);
      const norm = clamp01(nearGoalDist / halfLen); // 0 at a goal line, 1 at midfield
      excitement = clamp01(1 - norm) * 0.6;
    }

    const target = CROWD_FLOOR + (CROWD_CEIL - CROWD_FLOOR) * clamp01(excitement);
    // Frame-light exponential smoothing toward the target level.
    this.crowdLevel = this.crowdLevel + (target - this.crowdLevel) * (1 - CROWD_SMOOTH);

    try {
      const now = ctx.currentTime;
      this.crowdGain.gain.setTargetAtTime(this.crowdLevel, now, 0.25);
      // Brighten the bed a touch as it swells.
      this.crowdFilter.frequency.setTargetAtTime(
        420 + 280 * clamp01(excitement),
        now,
        0.25,
      );
    } catch {
      /* no-op */
    }
  }

  // ── Synthesis primitives (all schedule on the WebAudio clock) ──

  /** Short low thump: a single sine with a fast amplitude decay. */
  private playThump(t0: number, freq: number, dur: number, amp: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.6), t0 + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** A stronger thump plus a quick downward pitch sweep; louder with power. */
  private playShot(t0: number, power: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const amp = 0.6 + 0.35 * power;
    this.playThump(t0, 170, 0.22, amp);

    // Downward whoomph sweep on a saw, low-passed for body.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(360 + 240 * power, t0);
    osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.2);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t0);
    lp.frequency.exponentialRampToValueAtTime(360, t0 + 0.2);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22 + 0.18 * power, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);

    osc.connect(lp);
    lp.connect(g);
    g.connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + 0.26);
  }

  /** Celebratory triad arpeggio (3 oscillators). */
  private playGoal(t0: number): void {
    this.playArpeggio(t0, [392.0, 493.88, 587.33], 0.08, 'triangle', 0.34); // G major
    // Final sustained high note for a little lift.
    this.playTone(t0 + 0.24, 783.99, 0.45, 'sine', 0.22);
  }

  /** Crowd cheer swell: filtered noise rising then falling. */
  private playCheer(t0: number, intensity: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain || !this.noiseBuffer) return;
    const dur = 1.4 * intensity + 0.4;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, t0);
    bp.frequency.linearRampToValueAtTime(1100, t0 + dur * 0.4);
    bp.frequency.linearRampToValueAtTime(700, t0 + dur);
    bp.Q.value = 0.6;

    const g = ctx.createGain();
    const peak = 0.32 * intensity;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + dur * 0.35);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfxGain);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /** Referee whistle: two quick high tones with a warble. */
  private playWhistle(t0: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;

    const blast = (start: number, dur: number) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(2400, start);

      // Warble via a small LFO modulating frequency.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 28;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 60;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.26, start + 0.012);
      g.gain.setValueAtTime(0.26, start + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;

      osc.connect(lp);
      lp.connect(g);
      g.connect(this.sfxGain!);
      osc.start(start);
      osc.stop(start + dur + 0.02);
      lfo.start(start);
      lfo.stop(start + dur + 0.02);
    };

    blast(t0, 0.12);
    blast(t0 + 0.16, 0.16);
  }

  /** Metallic post ping: high sine + slightly detuned partner, fast decay. */
  private playPost(t0: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const dur = 0.5;
    const freqs = [1320, 1330.5, 2640];
    const amps = [0.22, 0.18, 0.08];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freqs[i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amps[i], t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }
  }

  /** Generic short noise burst through a filter. */
  private playNoiseBurst(
    t0: number,
    dur: number,
    cutoff: number,
    amp: number,
    filterType: BiquadFilterType,
    q = 1,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = cutoff;
    f.Q.value = q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(f);
    f.connect(g);
    g.connect(this.sfxGain);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** Filtered noise with a swept cutoff — UI whoosh. */
  private playNoiseSweep(
    t0: number,
    dur: number,
    fromHz: number,
    toHz: number,
    amp: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(fromHz, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), t0 + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfxGain);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** Short single-tone UI blip. */
  private playBlip(
    t0: number,
    freq: number,
    dur: number,
    amp: number,
    type: OscillatorType = 'square',
  ): void {
    this.playTone(t0, freq, dur, type, amp);
  }

  /** Low buzzy error tone (saw with mild amplitude wobble). */
  private playBuzz(t0: number, freq: number, dur: number, amp: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.linearRampToValueAtTime(freq * 0.85, t0 + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.01);
    g.gain.setValueAtTime(amp, t0 + dur - 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;

    osc.connect(lp);
    lp.connect(g);
    g.connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Sequence of short tones (reward / pack sparkle). */
  private playArpeggio(
    t0: number,
    freqs: readonly number[],
    step: number,
    type: OscillatorType,
    amp: number,
  ): void {
    for (let i = 0; i < freqs.length; i++) {
      this.playTone(t0 + i * step, freqs[i], step * 1.8, type, amp);
    }
  }

  /** A single enveloped oscillator tone. */
  private playTone(
    t0: number,
    freq: number,
    dur: number,
    type: OscillatorType,
    amp: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const g = ctx.createGain();
    const a = clamp(amp, 0, 1);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, a), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
}

/** Factory matching the cross-module API. */
export function createAudioSystem(): AudioSystem {
  return new WebAudioSystem();
}
