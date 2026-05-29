# Football In Your Hand ⚽

An arcade mobile football game built with **TypeScript + HTML5 Canvas + Vite**. It is an
original, faithful clone of the *Mini Football* design language: short high-tempo matches,
a floating virtual joystick, contextual action buttons, formation-driven AI, an arcade ball
physics model, a card/economy metagame, and plenty of game-feel polish.

All art is procedurally drawn on the canvas and all audio is synthesised at runtime — there
are no proprietary assets, trademarks, or licensed player names.

## Quick start

```bash
npm install
npm run dev        # start the Vite dev server (http://localhost:5173)
npm run build      # type-check + production build into dist/
npm run preview    # preview the production build
```

## Controls

### Touch (mobile)
- **Left half of screen** — floating virtual joystick (movement). Touch anywhere; the stick
  anchors where your thumb lands and keeps tracking even past its radius.
- **Right half** — three contextual action buttons that swap based on possession:
  - *In possession:* **Sprint · Pass · Shoot** (hold Pass for a lofted ball, hold Shoot to charge power)
  - *Out of possession:* **Sprint · Switch · Slide**

### Keyboard (desktop)
- **WASD / Arrows** — move
- **Space** — Shoot (hold to charge) · **J** — Pass (hold to loft) · **Shift** — Sprint
- **K** — Switch player · **L** — Slide tackle

### Gamepad
Plug in a controller — the left stick moves, face buttons map to the action layout, triggers
modulate sprint.

## Architecture

The codebase uses a **data-oriented design**: a single `GameWorld` object holds all match
state as plain data, and stateless *systems* read/mutate it each tick. This keeps every
system independently testable and decoupled.

```
src/
├── main.ts              Bootstrap, splash removal, screen routing
├── style.css            Global styles + responsive layout
├── core/
│   ├── types.ts         All data interfaces + enums (the shared contract)
│   ├── constants.ts     Every tunable gameplay value in one place
│   ├── world.ts         GameWorld factory — builds a match from teams + formations
│   ├── stateMachine.ts  Match state transitions (KICKOFF → PLAYING → … → MATCH_END)
│   └── game.ts          Fixed-timestep loop; orchestrates systems in order
├── utils/
│   ├── math.ts          Vec2 maths, lerp/clamp, easing, angle helpers
│   └── rng.ts           Seedable deterministic RNG (mulberry32)
├── systems/
│   ├── input.ts         Floating joystick, contextual buttons, gamepad, keyboard
│   ├── physics.ts       Arcade ball + player kinematics, possession, collisions
│   ├── ai.ts            Per-agent FSM, formation anchoring, switching logic
│   ├── matchController.ts  Goals, fouls/cards, set pieces, kickoff resets
│   ├── camera.ts        Ball-follow, screen shake, hit-pause
│   └── audio.ts         WebAudio synthesised SFX + crowd ambience
├── render/
│   ├── renderer.ts      Pitch, markings, big-head players, ball, shadows, arrows
│   ├── particles.ts     GPU-light particle pool + rarity VFX trails
│   └── hud.ts           In-match scoreboard, timer, joystick + buttons, indicators
├── data/
│   ├── formations.ts    Normalised anchor coordinates for all 7 formations
│   ├── cards.ts         Player card pool, rarity tiers + base-stat tables
│   └── teams.ts         Preset opponent teams + kits
├── meta/
│   ├── profile.ts       localStorage-backed player profile
│   ├── economy.ts       Team strength, coins/gems, packs, upgrades
│   └── progression.ts   XP / country level gatekeeping
└── ui/
    ├── ui.ts            Screen router + transitions
    ├── mainMenu.ts      Hub screen (top bar, economy, PLAY, packs)
    ├── teamScreen.ts    Drag-and-drop roster + formation picker
    └── components.ts    Shared DOM builders
```

## Faithful-to-source design decisions

This clone intentionally reproduces the source game's *systems* while correcting its
documented UX friction points (see `blueprint.md`):

- **No offside** — liberates AI spatial logic for end-to-end arcade action.
- **Floating joystick with infinite tracking** — fixes the original's input-drop bug.
- **Tackle→Shoot debounce** (~250 ms) — prevents the accidental clearance on a won tackle.
- **Fair, global stamina drain** — replaces the source's blatant AI rubber-banding with
  difficulty expressed through positioning, pressing, and passing accuracy instead.
- **Dot-product pass targeting** — picks the teammate you actually aimed at.
