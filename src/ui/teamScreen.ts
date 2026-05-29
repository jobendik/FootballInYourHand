/**
 * Squad management: formation picker, drag-free tap-to-swap pitch grid, the owned-card
 * collection, and a card-detail modal with the duplicate-and-coins upgrade flow.
 */
import type { UI } from './ui';
import { Rarity, type CardDef, type OwnedCard } from '@/core/types';
import { RARITY_TIERS } from '@/core/constants';
import { FORMATIONS, getFormation } from '@/data/formations';
import { getCardDef } from '@/data/cards';
import {
  canUpgrade,
  findOwned,
  ownedRating,
  scaledStats,
  starRating,
  teamStrength,
  upgradeCard,
} from '@/meta/economy';
import { saveProfile } from '@/meta/profile';
import { button, clear, h, starRow, toast } from './components';

export function buildTeamScreen(ui: UI): HTMLElement {
  const p = ui.profile;
  const screen = h('div', { class: 'screen team-screen' });

  let selectedSlot: number | null = null;
  let selectedCardId: string | null = null;

  const save = () => {
    saveProfile(p);
  };

  function assignCardToSlot(defId: string, slot: number): void {
    const existingIndex = p.activeRoster.indexOf(defId);
    if (existingIndex === slot) return;
    if (existingIndex >= 0) {
      // Swap positions of two on-pitch cards.
      const tmp = p.activeRoster[slot]!;
      p.activeRoster[slot] = defId;
      p.activeRoster[existingIndex] = tmp;
    } else {
      // Bench card replaces the slot occupant (occupant returns to the bench).
      p.activeRoster[slot] = defId;
    }
    selectedSlot = null;
    selectedCardId = null;
    save();
    ui.ctx.audio.ui('click');
    rebuild();
  }

  function swapSlots(a: number, b: number): void {
    const tmp = p.activeRoster[a]!;
    p.activeRoster[a] = p.activeRoster[b]!;
    p.activeRoster[b] = tmp;
    selectedSlot = null;
    save();
    ui.ctx.audio.ui('click');
    rebuild();
  }

  function onSlotClick(slot: number): void {
    if (selectedCardId) {
      assignCardToSlot(selectedCardId, slot);
      return;
    }
    if (selectedSlot === null) {
      selectedSlot = slot;
    } else if (selectedSlot === slot) {
      selectedSlot = null;
    } else {
      swapSlots(selectedSlot, slot);
    }
    rebuild();
  }

  function onCardClick(defId: string): void {
    if (selectedSlot !== null) {
      assignCardToSlot(defId, selectedSlot);
      return;
    }
    // Toggle selection; if already selected, open the detail/upgrade modal.
    if (selectedCardId === defId) {
      openCardDetail(defId);
      selectedCardId = null;
      rebuild();
    } else {
      selectedCardId = defId;
      rebuild();
    }
  }

  function openCardDetail(defId: string): void {
    const card = getCardDef(defId);
    const owned = findOwned(p, defId);
    if (!card || !owned) return;
    const tier = RARITY_TIERS[card.rarity];
    const stats = scaledStats(card, owned.level);

    const statRows = (
      [
        ['PAC', stats.pace],
        ['SHO', stats.shooting],
        ['PAS', stats.passing],
        ['DRI', stats.dribbling],
        ['DEF', stats.defending],
        ['PHY', stats.physical],
      ] as const
    ).map(([label, v]) =>
      h('div', { class: 'stat-row' }, [
        h('span', { class: 'stat-label', text: label }),
        h('span', { class: 'stat-val', text: String(v) }),
        h('div', { class: 'stat-bar' }, [h('div', { class: 'stat-bar-fill', style: { width: `${v}%`, background: tier.color } })]),
      ]),
    );

    const check = canUpgrade(p, defId);
    const upgradeInfo = h('div', { class: 'upgrade-info' }, [
      owned.level >= tier.maxLevel
        ? h('span', { text: 'Max level reached' })
        : h('span', {
            text: `Upgrade: ${owned.copies}/${check.copiesNeeded ?? '?'} copies · 🪙${check.coinCost ?? '?'}`,
          }),
    ]);

    const content = h('div', { class: `card-detail r-${card.rarity.toLowerCase()}` }, [
      h('div', { class: 'card-detail-head', style: { color: tier.color } }, [
        h('div', { class: 'card-detail-name', text: card.name }),
        h('div', { class: 'card-detail-sub', text: `${card.role} · ${card.rarity} · Lvl ${owned.level} · ${ownedRating(owned)} OVR` }),
      ]),
      h('div', { class: 'card-detail-stats' }, statRows),
      upgradeInfo,
    ]);

    const m = ui.modal(content);
    content.append(
      h('div', { class: 'card-detail-actions' }, [
        button(
          'Upgrade',
          () => {
            const res = upgradeCard(p, defId);
            if (res.ok) {
              ui.ctx.audio.ui('reward');
              toast(`Upgraded to Lvl ${res.newLevel}!${res.leveledUpAccount ? ' Account level up!' : ''}`, 'success');
              save();
              m.close();
              rebuild();
            } else {
              ui.ctx.audio.ui('error');
              toast(res.reason ?? 'Cannot upgrade', 'error');
            }
          },
          check.ok ? 'primary' : 'ghost',
        ),
        button('Close', () => m.close(), 'secondary'),
      ]),
    );
  }

  function cardMini(defId: string, role: string, onPitch: boolean): HTMLElement {
    const card = getCardDef(defId);
    const owned = findOwned(p, defId);
    const tier = card ? RARITY_TIERS[card.rarity] : RARITY_TIERS[Rarity.COMMON];
    const selected = selectedCardId === defId;
    return h(
      'button',
      {
        class: `card-mini r-${(card?.rarity ?? Rarity.COMMON).toLowerCase()} ${selected ? 'is-selected' : ''} ${onPitch ? 'on-pitch' : ''}`,
        style: { borderColor: tier.color },
        onClick: () => onCardClick(defId),
      },
      [
        h('div', { class: 'card-mini-rating', text: owned ? String(ownedRating(owned)) : '—', style: { color: tier.color } }),
        h('div', { class: 'card-mini-name', text: card?.name ?? '—' }),
        h('div', { class: 'card-mini-pos', text: role || card?.role || '' }),
        owned && owned.copies > 0 ? h('div', { class: 'card-mini-copies', text: `+${owned.copies}` }) : null,
      ],
    );
  }

  function pitchView(): HTMLElement {
    const formation = getFormation(p.formationId);
    const pitch = h('div', { class: 'team-pitch' });
    for (let i = 0; i < 11; i++) {
      const slot = formation.slots[i]!;
      const defId = p.activeRoster[i];
      const node = h(
        'div',
        {
          class: `pitch-slot ${selectedSlot === i ? 'is-selected' : ''}`,
          style: { top: `${(1 - slot.norm.x) * 100}%`, left: `${slot.norm.y * 100}%` },
          onClick: () => onSlotClick(i),
        },
        [defId ? cardMini(defId, slot.label, true) : h('div', { class: 'pitch-slot-empty', text: slot.label })],
      );
      pitch.append(node);
    }
    return pitch;
  }

  function collectionView(): HTMLElement {
    const wrap = h('div', { class: 'collection' }, [h('div', { class: 'collection-title', text: 'Collection' })]);
    const grid = h('div', { class: 'collection-grid' });
    // Sort: bench first, then by rating desc.
    const entries = [...p.cards].sort((a, b) => {
      const aOn = p.activeRoster.includes(a.defId) ? 1 : 0;
      const bOn = p.activeRoster.includes(b.defId) ? 1 : 0;
      if (aOn !== bOn) return aOn - bOn;
      return ratingOf(b) - ratingOf(a);
    });
    for (const owned of entries) {
      const card = getCardDef(owned.defId);
      grid.append(cardMini(owned.defId, card?.role ?? '', p.activeRoster.includes(owned.defId)));
    }
    wrap.append(grid);
    return wrap;
  }

  function ratingOf(o: OwnedCard): number {
    return ownedRating(o);
  }

  function formationRow(): HTMLElement {
    const row = h('div', { class: 'formation-row' });
    for (const f of FORMATIONS) {
      const locked = p.countryLevel < f.unlockLevel;
      const active = p.formationId === f.id;
      row.append(
        button(
          locked ? `🔒 ${f.name}` : f.name,
          () => {
            if (locked) {
              ui.ctx.audio.ui('error');
              toast(`Reach level ${f.unlockLevel}`, 'error');
              return;
            }
            p.formationId = f.id;
            save();
            ui.ctx.audio.ui('click');
            rebuild();
          },
          active ? 'primary' : 'ghost',
          'formation-chip',
        ),
      );
    }
    return row;
  }

  function strengthBar(): HTMLElement {
    const s = teamStrength(p);
    return h('div', { class: 'team-strength-bar' }, [
      h('div', {}, [h('span', { class: 'ts-num', text: String(s) }), h('span', { class: 'ts-label', text: ' Team Strength' })]),
      starRow(starRating(s)),
    ]);
  }

  function hint(): HTMLElement {
    const msg = selectedCardId
      ? 'Tap a pitch position to place this player'
      : selectedSlot !== null
        ? 'Tap another position to swap, or a collection card to assign'
        : 'Tap a player to select · tap again for details & upgrades';
    return h('div', { class: 'team-hint', text: msg });
  }

  function rebuild(): void {
    clear(screen);
    screen.append(ui.topBar('Squad'), strengthBar(), formationRow(), pitchView(), hint(), collectionView());
  }

  rebuild();
  return screen;
}

/** Re-export so callers needn't import from economy directly. */
export type { CardDef };
