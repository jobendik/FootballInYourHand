/**
 * Screen router + shared overlays (settings, stadium/play select, shop, pack reveal, match
 * result). Menu screens are plain DOM mounted into #ui-root; the match canvas sits behind it.
 */
import type { AudioSystem, Difficulty, PackDef, Profile, RuntimeConfig, StadiumDef } from '@/core/types';
import { Rarity } from '@/core/types';
import { RARITY_TIERS } from '@/core/constants';
import { PACKS, STADIUMS } from '@/data/teams';
import { getCardDef } from '@/data/cards';
import {
  openPack,
  starRating,
  teamStrength,
  type DrawnCard,
  type MatchOutcome,
} from '@/meta/economy';
import { uiRng } from '@/utils/rng';
import { button, clear, currencyPill, formatNumber, h, starRow, toast } from './components';
import { buildMainMenu } from './mainMenu';
import { buildTeamScreen } from './teamScreen';

export type ScreenName = 'menu' | 'team' | 'shop' | 'play';

export interface MatchRequest {
  opponentStrength: number;
  difficulty: Difficulty;
  stadiumId?: string;
  opponentPresetId?: string;
  entryFee: number;
  prize: number;
  packId?: string;
}

export interface UIContext {
  profile: Profile;
  settings: RuntimeConfig;
  audio: AudioSystem;
  save(): void;
  startMatch(req: MatchRequest): void;
}

export class UI {
  readonly root: HTMLElement;
  readonly ctx: UIContext;
  private current: ScreenName = 'menu';

  constructor(root: HTMLElement, ctx: UIContext) {
    this.root = root;
    this.ctx = ctx;
  }

  get profile(): Profile {
    return this.ctx.profile;
  }

  show(screen: ScreenName): void {
    this.current = screen;
    this.ctx.audio.ui('click');
    this.render();
  }

  /** Make the menu UI visible (after a match). */
  reveal(): void {
    this.root.style.display = '';
    this.render();
  }

  /** Hide the menu UI (during a match). */
  hideForMatch(): void {
    this.root.style.display = 'none';
  }

  render(): void {
    clear(this.root);
    let view: HTMLElement;
    switch (this.current) {
      case 'menu':
        view = buildMainMenu(this);
        break;
      case 'team':
        view = buildTeamScreen(this);
        break;
      case 'shop':
        view = this.buildShop();
        break;
      case 'play':
        view = this.buildPlay();
        break;
      default:
        view = buildMainMenu(this);
    }
    view.classList.add('screen-enter');
    this.root.append(view);
    requestAnimationFrame(() => view.classList.add('screen-enter-active'));
  }

  // ───────────────────────── Top bar (shared) ─────────────────────────

  topBar(title: string, back = true): HTMLElement {
    const p = this.profile;
    const left = h('div', { class: 'topbar-left' }, [
      back
        ? button('‹', () => this.show('menu'), 'ghost', 'btn-back')
        : h('div', { class: 'avatar', text: p.avatar }),
      h('div', { class: 'topbar-titles' }, [
        h('div', { class: 'topbar-title', text: title }),
        !back ? h('div', { class: 'topbar-sub', text: `Lvl ${p.countryLevel} · ${p.name}` }) : null,
      ]),
    ]);
    const right = h('div', { class: 'topbar-right' }, [
      currencyPill('🪙', p.coins, 'coins'),
      currencyPill('💎', p.gems, 'gems'),
      button('⚙', () => this.openSettings(), 'ghost', 'btn-gear'),
    ]);
    return h('div', { class: 'topbar' }, [left, right]);
  }

  // ───────────────────────── Play / stadium select ─────────────────────────

  private buildPlay(): HTMLElement {
    const strength = teamStrength(this.profile);
    const wrap = h('div', { class: 'screen play-screen' }, [this.topBar('Victory Path')]);

    const intro = h('div', { class: 'play-intro' }, [
      h('div', { class: 'play-strength' }, [
        h('span', { text: 'Your Team Strength ' }),
        h('strong', { text: String(strength) }),
      ]),
      starRow(starRating(strength)),
    ]);
    wrap.append(intro);

    // Quick match (free, mirror strength).
    const quick = this.stadiumCard(
      {
        id: 'quick',
        name: 'Friendly Match',
        entryFee: 0,
        prize: 150,
        minStrength: 0,
        packId: 'bronze',
        unlockLevel: 1,
      },
      strength,
      true,
    );
    wrap.append(quick);

    const list = h('div', { class: 'stadium-list' });
    for (const st of STADIUMS) {
      list.append(this.stadiumCard(st, strength, false));
    }
    wrap.append(list);
    return wrap;
  }

  private stadiumCard(st: StadiumDef, strength: number, isQuick: boolean): HTMLElement {
    const p = this.profile;
    const locked = p.countryLevel < st.unlockLevel;
    const tooWeak = strength < st.minStrength;
    const tooPoor = p.coins < st.entryFee;
    const diff: Difficulty = this.settings().difficulty;

    const meta = h('div', { class: 'stadium-meta' }, [
      st.entryFee > 0 ? h('span', { class: 'tag', text: `Entry 🪙${formatNumber(st.entryFee)}` }) : h('span', { class: 'tag', text: 'Free' }),
      h('span', { class: 'tag tag-prize', text: `Win 🪙${formatNumber(st.prize)}` }),
      !isQuick ? h('span', { class: 'tag', text: `Min ${st.minStrength}` }) : null,
      st.packId ? h('span', { class: 'tag', text: `+${st.packId} pack` }) : null,
    ]);

    const playBtn = button(
      locked ? `🔒 Lvl ${st.unlockLevel}` : tooWeak ? 'Too weak' : tooPoor ? 'No coins' : 'PLAY',
      () => {
        if (locked || tooWeak || tooPoor) {
          this.ctx.audio.ui('error');
          toast(locked ? `Reach level ${st.unlockLevel}` : tooWeak ? `Need ${st.minStrength} strength` : 'Not enough coins', 'error');
          return;
        }
        // Opponent slightly above the gate to feel challenging.
        const oppStrength = Math.max(st.minStrength, strength) + (isQuick ? 0 : 40);
        if (st.entryFee > 0) {
          p.coins -= st.entryFee;
          this.ctx.save();
        }
        this.ctx.startMatch({
          opponentStrength: oppStrength,
          difficulty: diff,
          stadiumId: st.id,
          entryFee: st.entryFee,
          prize: st.prize,
          packId: st.packId,
        });
      },
      locked || tooWeak || tooPoor ? 'ghost' : 'primary',
      'stadium-play',
    );

    return h('div', { class: `stadium-card ${locked ? 'is-locked' : ''}` }, [
      h('div', { class: 'stadium-info' }, [h('div', { class: 'stadium-name', text: st.name }), meta]),
      playBtn,
    ]);
  }

  // ───────────────────────── Shop / packs ─────────────────────────

  private buildShop(): HTMLElement {
    const wrap = h('div', { class: 'screen shop-screen' }, [this.topBar('Store')]);
    const list = h('div', { class: 'pack-list' });
    for (const pack of PACKS) {
      list.append(this.packCard(pack));
    }
    wrap.append(list);
    return wrap;
  }

  private packCard(pack: PackDef): HTMLElement {
    const p = this.profile;
    const locked = p.countryLevel < pack.unlockLevel;
    const icon = pack.currency === 'coins' ? '🪙' : '💎';
    const balance = pack.currency === 'coins' ? p.coins : p.gems;
    const affordable = balance >= pack.cost;

    // Drop-rate transparency (the v4.0 requirement).
    const totalWeight = Object.values(pack.dropRates).reduce((a, b) => a + b, 0) || 1;
    const rates = h('div', { class: 'drop-rates' });
    for (const r of [Rarity.COMMON, Rarity.RARE, Rarity.EPIC, Rarity.LEGENDARY, Rarity.MYTHICAL]) {
      const pct = ((pack.dropRates[r] ?? 0) / totalWeight) * 100;
      if (pct <= 0) continue;
      rates.append(
        h('span', { class: 'drop-rate', style: { color: RARITY_TIERS[r].color } }, [
          h('span', { class: 'drop-dot', style: { background: RARITY_TIERS[r].color } }),
          `${r[0]}${r.slice(1).toLowerCase()} ${pct.toFixed(pct < 1 ? 1 : 0)}%`,
        ]),
      );
    }

    const buy = button(
      locked ? `🔒 Lvl ${pack.unlockLevel}` : `${icon} ${formatNumber(pack.cost)}`,
      () => {
        if (locked) {
          this.ctx.audio.ui('error');
          toast(`Reach level ${pack.unlockLevel}`, 'error');
          return;
        }
        if (!affordable) {
          this.ctx.audio.ui('error');
          toast(`Not enough ${pack.currency}`, 'error');
          return;
        }
        const drawn = openPack(this.profile, pack, uiRng);
        if (!drawn) {
          toast('Could not open pack', 'error');
          return;
        }
        this.ctx.save();
        this.revealPack(pack, drawn);
      },
      locked || !affordable ? 'ghost' : 'primary',
      'pack-buy',
    );

    return h('div', { class: `pack-card ${locked ? 'is-locked' : ''}`, style: { borderColor: pack.accent } }, [
      h('div', { class: 'pack-head', style: { background: `linear-gradient(135deg, ${pack.accent}, #0b1220)` } }, [
        h('div', { class: 'pack-name', text: pack.name }),
        h('div', { class: 'pack-count', text: `${pack.cardCount} cards` }),
      ]),
      h('div', { class: 'pack-desc', text: pack.description }),
      rates,
      buy,
    ]);
  }

  // ───────────────────────── Overlays ─────────────────────────

  modal(content: HTMLElement, opts: { dismissable?: boolean; cls?: string } = {}): { close: () => void } {
    const overlay = h('div', { class: `overlay ${opts.cls ?? ''}`.trim() });
    const panel = h('div', { class: 'modal' }, [content]);
    overlay.append(panel);
    if (opts.dismissable !== false) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
    }
    this.root.append(overlay);
    requestAnimationFrame(() => overlay.classList.add('overlay-show'));
    const close = () => {
      overlay.classList.remove('overlay-show');
      setTimeout(() => overlay.remove(), 250);
    };
    return { close };
  }

  private settings(): RuntimeConfig {
    return this.ctx.settings;
  }

  openSettings(): void {
    const s = this.ctx.settings;
    const content = h('div', { class: 'settings' }, [h('h2', { text: 'Settings' })]);

    const toggle = (label: string, key: keyof RuntimeConfig) => {
      const row = h('label', { class: 'setting-row' }, [h('span', { text: label })]);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(s[key]);
      input.addEventListener('change', () => {
        (s as unknown as Record<string, unknown>)[key] = input.checked;
        this.ctx.audio.setEnabled(s.sfxEnabled, s.musicEnabled);
        this.ctx.save();
      });
      row.append(input);
      return row;
    };

    content.append(
      toggle('Sound effects', 'sfxEnabled'),
      toggle('Crowd / music', 'musicEnabled'),
      toggle('Rarity VFX', 'rarityVfxEnabled'),
      toggle('Screen shake', 'screenShakeEnabled'),
      toggle('Reduced motion', 'reducedMotion'),
      toggle('Show FPS', 'showFps'),
    );

    // Difficulty selector.
    const diffRow = h('div', { class: 'setting-row' }, [h('span', { text: 'Difficulty' })]);
    const diffSel = document.createElement('select');
    for (const d of ['easy', 'normal', 'hard', 'legend'] as Difficulty[]) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d[0]!.toUpperCase() + d.slice(1);
      if (s.difficulty === d) opt.selected = true;
      diffSel.append(opt);
    }
    diffSel.addEventListener('change', () => {
      s.difficulty = diffSel.value as Difficulty;
      this.ctx.save();
    });
    diffRow.append(diffSel);
    content.append(diffRow);

    const m = this.modal(content);
    content.append(
      h('div', { class: 'settings-actions' }, [
        button('Reset progress', () => {
          if (confirm('Reset all progress? This cannot be undone.')) {
            localStorage.removeItem('fih.profile.v1');
            location.reload();
          }
        }, 'danger'),
        button('Close', () => m.close(), 'primary'),
      ]),
    );
  }

  revealPack(pack: PackDef, drawn: DrawnCard[]): void {
    this.ctx.audio.ui('pack');
    const grid = h('div', { class: 'reveal-grid' });
    const content = h('div', { class: 'pack-reveal' }, [
      h('h2', { text: `${pack.name} opened!` }),
      grid,
    ]);
    const m = this.modal(content, { dismissable: false });

    drawn.forEach((d, i) => {
      const card = getCardDef(d.defId);
      const tier = RARITY_TIERS[d.rarity];
      const el = h(
        'div',
        {
          class: `reveal-card r-${d.rarity.toLowerCase()}`,
          style: { borderColor: tier.color, boxShadow: `0 0 22px ${tier.glow}` },
        },
        [
          h('div', { class: 'reveal-rarity', text: d.rarity, style: { color: tier.color } }),
          h('div', { class: 'reveal-name', text: card?.name ?? d.defId }),
          h('div', { class: 'reveal-role', text: card?.role ?? '' }),
          d.isNew ? h('div', { class: 'reveal-new', text: 'NEW' }) : h('div', { class: 'reveal-dupe', text: '+1 copy' }),
        ],
      );
      el.style.animationDelay = `${i * 0.12}s`;
      grid.append(el);
    });

    content.append(button('Nice!', () => { m.close(); this.render(); }, 'primary', 'reveal-done'));
  }

  showResult(outcome: MatchOutcome, homeScore: number, awayScore: number, packReveal?: { pack: PackDef; drawn: DrawnCard[] }): void {
    const heading = outcome.result === 'win' ? 'VICTORY' : outcome.result === 'loss' ? 'DEFEAT' : 'DRAW';
    this.ctx.audio.ui(outcome.result === 'win' ? 'reward' : 'click');

    const content = h('div', { class: `result result-${outcome.result}` }, [
      h('div', { class: 'result-heading', text: heading }),
      h('div', { class: 'result-score', text: `${homeScore} – ${awayScore}` }),
      h('div', { class: 'result-rewards' }, [
        h('div', { class: 'reward', text: `+🪙 ${formatNumber(outcome.coins)}` }),
        h('div', { class: 'reward', text: `+XP ${outcome.xp}` }),
        outcome.leveledUp ? h('div', { class: 'reward reward-level', text: `Level up! Lvl ${outcome.newLevel}` }) : null,
      ]),
    ]);
    const m = this.modal(content, { dismissable: false });
    content.append(
      button('Continue', () => {
        m.close();
        if (packReveal) this.revealPack(packReveal.pack, packReveal.drawn);
        else this.show('menu');
      }, 'primary'),
    );
  }
}
