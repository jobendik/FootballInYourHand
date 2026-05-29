/**
 * The main menu hub — funnels the player toward PLAY (core loop) and the Store (monetisation
 * loop), mirroring the source layout: top bar with profile + economy, a prominent PLAY
 * button, navigation to Team/Store, and a daily reward node.
 */
import type { UI } from './ui';
import { getFormation } from '@/data/formations';
import { starRating, teamStrength } from '@/meta/economy';
import { levelProgress } from '@/meta/progression';
import { saveProfile } from '@/meta/profile';
import { button, h, progressBar, starRow, toast } from './components';

const DAILY_KEY = 'fih.dailyReward.v1';

function todayStamp(): string {
  // Date-free day bucket: use performance origin is not stable across reloads, so we accept
  // a coarse localStorage flag toggled by the user claiming. (No wall-clock dependency.)
  return 'claimed';
}

export function buildMainMenu(ui: UI): HTMLElement {
  const p = ui.profile;
  const strength = teamStrength(p);
  const formation = getFormation(p.formationId);

  // Top bar with XP progress underneath.
  const top = ui.topBar('', false);
  const xp = h('div', { class: 'xp-strip' }, [
    progressBar(levelProgress(p), 'xp-bar'),
    h('span', { class: 'xp-label', text: `Lvl ${p.countryLevel}` }),
  ]);

  const hero = h('div', { class: 'menu-hero' }, [
    h('div', { class: 'hero-club' }, [
      h('div', { class: 'hero-crest', style: { background: p.kit.primary, borderColor: p.kit.accent } }, [
        h('span', { text: p.avatar }),
      ]),
      h('div', {}, [
        h('div', { class: 'hero-name', text: p.name }),
        h('div', { class: 'hero-formation', text: formation.name }),
      ]),
    ]),
    h('div', { class: 'hero-strength' }, [
      h('div', { class: 'hero-strength-num', text: String(strength) }),
      h('div', { class: 'hero-strength-label', text: 'TEAM STRENGTH' }),
      starRow(starRating(strength), 'hero-stars'),
    ]),
  ]);

  const play = button('PLAY', () => ui.show('play'), 'primary', 'play-button');

  const nav = h('div', { class: 'menu-nav' }, [
    navTile('👥', 'Team', () => ui.show('team')),
    navTile('🛒', 'Store', () => ui.show('shop')),
    navTile('🎁', 'Daily', () => claimDaily(ui)),
  ]);

  return h('div', { class: 'screen menu-screen' }, [top, xp, hero, play, nav, footerHint()]);
}

function navTile(icon: string, label: string, onClick: () => void): HTMLElement {
  return h('button', { class: 'nav-tile', onClick }, [
    h('div', { class: 'nav-icon', text: icon }),
    h('div', { class: 'nav-label', text: label }),
  ]);
}

function footerHint(): HTMLElement {
  return h('div', { class: 'menu-footer' }, [
    h('span', { text: 'Touch: left half = move · right = Sprint / Pass / Shoot' }),
    h('span', { text: 'Keys: WASD move · Space shoot · J pass · Shift sprint · K switch · L slide' }),
  ]);
}

function claimDaily(ui: UI): void {
  let claimed = false;
  try {
    claimed = localStorage.getItem(DAILY_KEY) === todayStamp();
  } catch {
    /* ignore */
  }
  if (claimed) {
    ui.ctx.audio.ui('error');
    toast('Daily reward already claimed — come back later!', 'info');
    return;
  }
  ui.profile.coins += 250;
  ui.profile.gems += 5;
  try {
    localStorage.setItem(DAILY_KEY, todayStamp());
  } catch {
    /* ignore */
  }
  saveProfile(ui.profile);
  ui.ctx.audio.ui('reward');
  toast('Daily reward: +🪙250 +💎5', 'success');
  ui.render();
}
