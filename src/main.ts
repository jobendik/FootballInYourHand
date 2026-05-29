/**
 * Bootstrap: build the rendering/input/audio systems, the menu UI, and the match lifecycle.
 * The canvas hosts gameplay; #ui-root overlays it with menus. Starting a match hides the menu
 * and runs the game loop; ending it applies economy rewards and returns to the menu.
 */
import './style.css';

import { TeamSide, type GameWorld } from '@/core/types';
import { createWorld } from '@/core/world';
import { Game } from '@/core/game';
import { createRenderer } from '@/render/renderer';
import { createInputSystem } from '@/systems/input';
import { createAudioSystem } from '@/systems/audio';
import { PACKS } from '@/data/teams';
import {
  applyMatchResult,
  awardPackFree,
  createMatchConfig,
  type DrawnCard,
} from '@/meta/economy';
import { loadProfile, loadSettings, saveProfile, saveSettings } from '@/meta/profile';
import { uiRng } from '@/utils/rng';
import { UI, type MatchRequest, type UIContext } from '@/ui/ui';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const splash = document.getElementById('boot-splash');

const profile = loadProfile();
const settings = loadSettings();

const renderer = createRenderer(canvas);
const input = createInputSystem(canvas);
const audio = createAudioSystem();
audio.setEnabled(settings.sfxEnabled, settings.musicEnabled);

let seedCounter = 0x1a2b3c;
function nextSeed(): number {
  seedCounter = (seedCounter * 1664525 + 1013904223) >>> 0;
  return seedCounter;
}

/** Build a GameWorld for a match request. */
function buildWorld(req: MatchRequest): GameWorld {
  const config = createMatchConfig(profile, {
    opponentStrength: req.opponentStrength,
    difficulty: req.difficulty,
    config: settings,
    seed: nextSeed(),
    opponentPresetId: req.opponentPresetId,
  });
  return createWorld(config);
}

// The Game needs an initial world; build a throwaway one (never started until PLAY).
const game = new Game({ renderer, input, audio }, buildWorld({
  opponentStrength: 500,
  difficulty: settings.difficulty,
  entryFee: 0,
  prize: 0,
}));

let pendingReq: MatchRequest | null = null;
let inMatch = false;

function setCanvasVisible(visible: boolean): void {
  canvas.style.display = visible ? 'block' : 'none';
}

function doResize(): void {
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  game.resize(vw, vh, dpr);
}
window.addEventListener('resize', doResize);
window.visualViewport?.addEventListener('resize', doResize);
window.addEventListener('orientationchange', () => setTimeout(doResize, 100));

// ───────────────────────────── Match lifecycle ─────────────────────────────

const uiContext: UIContext = {
  profile,
  settings,
  audio,
  save() {
    saveProfile(profile);
    saveSettings(settings);
  },
  startMatch(req: MatchRequest) {
    pendingReq = req;
    void audio.resume(); // PLAY is a user gesture — unlocks WebAudio
    audio.setEnabled(settings.sfxEnabled, settings.musicEnabled);

    const world = buildWorld(req);
    game.setWorld(world);

    inMatch = true;
    ui.hideForMatch();
    setCanvasVisible(true);
    input.attach();
    doResize();
    game.startMatch(TeamSide.HOME);
  },
};

const ui = new UI(uiRoot, uiContext);

game.onMatchEnd = (world: GameWorld) => {
  if (!inMatch) return;
  inMatch = false;
  game.stop();
  input.detach();
  setCanvasVisible(false);

  const home = world.teams[TeamSide.HOME].score;
  const away = world.teams[TeamSide.AWAY].score;
  const oppStrength = world.teams[TeamSide.AWAY].teamStrength;
  const outcome = applyMatchResult(profile, home, away, oppStrength);

  let packReveal: { pack: (typeof PACKS)[number]; drawn: DrawnCard[] } | undefined;
  if (outcome.result === 'win' && pendingReq) {
    if (pendingReq.prize) profile.coins += pendingReq.prize;
    if (pendingReq.packId) {
      const pack = PACKS.find((p) => p.id === pendingReq!.packId);
      if (pack) {
        const drawn = awardPackFree(profile, pack, uiRng);
        packReveal = { pack, drawn };
      }
    }
  }

  saveProfile(profile);
  saveSettings(settings);

  ui.reveal();
  // Recompute coins (prize) before the result modal so the topbar is fresh on Continue.
  ui.showResult(outcome, home, away, packReveal);
};

// ───────────────────────────── Boot ─────────────────────────────

setCanvasVisible(false);
doResize();
ui.render();

// Fade out the splash once the first menu frame is up.
requestAnimationFrame(() => {
  if (splash) {
    splash.classList.add('boot-done');
    setTimeout(() => splash.remove(), 500);
  }
});

// Resume audio on the very first interaction anywhere (belt-and-braces for mobile autoplay).
const unlockAudio = () => {
  void audio.resume();
  window.removeEventListener('pointerdown', unlockAudio);
};
window.addEventListener('pointerdown', unlockAudio, { once: true });
