export const meta = {
  name: 'fih-review',
  description: 'Adversarial multi-dimension correctness review of the Football In Your Hand integration, with per-finding verification',
  phases: [
    { title: 'Review', detail: 'one agent per dimension' },
    { title: 'Verify', detail: 'adversarially verify each finding' },
  ],
}

const ROOT = 'c:/Users/joben/Projects/FootballInYourHand'

const PREAMBLE = `
You are reviewing an HTML5 + TypeScript arcade football game ("Football In Your Hand", a Mini Football clone). It is DATA-ORIENTED: one GameWorld object (src/core/types.ts) holds all state; stateless systems mutate it each tick from src/core/game.ts in this ORDER per fixed step: input.sample -> actions.updateControl -> (PLAYING only) actions.updateUserActions -> ai.updateAI -> (sim states only) physics.updatePhysics -> matchController.updateMatch -> camera.updateCamera -> particles.updateParticles -> audio.update -> clear world.events.

KEY CONVENTIONS the code must obey:
- Coordinates: centre origin; +x toward AWAY goal (HOME attacks +x). Ball.z is height. Pitch length runs UP the screen; src/core/viewport.ts is the SOLE owner of world<->screen mapping & the screen-dir->world rotation (screenDirToWorld). Both renderer and input MUST go through it so orientation stays consistent.
- Possession: ball.owner===player.id. ONLY physics.ts changes possession (giveBallTo/kickBall); other systems call those.
- world.controlMode set by actions.updateControl. Exactly ONE player.isUser===true.
- world.events: systems push; camera/particles/audio consume; game.ts clears at end of step. No system should clear it.
- Randomness in the SIM must use world.rng (seeded), never the standard-library generator. No wall-clock time in the sim.
- The blueprint UX fixes that MUST be present: floating joystick with infinite tracking; ~250ms action-lock after winning the ball (world.actionLockTimer) so 'tackle' doesn't instantly become 'shoot'; dot-product pass targeting; FAIR global stamina (AI must NOT cheat on speed/stamina — difficulty only via positioning/pressing/accuracy/decision-speed); no offside.
- Strict TS already PASSES (tsc --noEmit clean) and vite build succeeds — do NOT report type errors or build errors; they don't exist. Focus on RUNTIME CORRECTNESS, logic bugs, crashes (NaN/undefined/divide-by-zero/normalize of zero vector), infinite loops, performance hot-spots, and clear deviations from the conventions/blueprint above.

Read the files you need with the Read tool. Cite exact file:line. Be PRECISE and avoid false positives — only report things you are reasonably confident are real bugs or clear correctness/feel problems. For each finding give a concrete, minimal fix. Prefer fewer high-quality findings over many speculative ones.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'severity', 'confidence', 'description', 'suggestedFix'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          location: { type: 'string', description: 'file:line or function name' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'isReal', 'severity', 'reason'],
  properties: {
    title: { type: 'string' },
    isReal: { type: 'boolean' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reason: { type: 'string' },
    file: { type: 'string' },
    location: { type: 'string' },
    confirmedFix: { type: 'string' },
  },
}

const DIMENSIONS = [
  {
    key: 'loop-state',
    prompt: `DIMENSION: Game loop, match state machine, and match flow.
Read: ${ROOT}/src/core/game.ts, ${ROOT}/src/systems/matchController.ts, ${ROOT}/src/core/world.ts, and skim ${ROOT}/src/core/types.ts + ${ROOT}/src/core/constants.ts (MATCH).
Check: fixed-timestep accumulation & spiral-of-death guard; hitStop freeze (does it clear events / can it strand input?); event queue cleared exactly once after all consumers; system-call ordering & state-gating correctness; GOAL detection sign (HOME scores at +x goal line, AWAY at -x) and that it reads POST-physics ball position; out-of-bounds restarts (touchline kick-in to the opponent of ball.lastTouchSide; goal-kick vs corner attribution); kickoff placement & which side kicks off; HALF_TIME alternation of kickoff side; FULL_TIME at half 2; penalty minigame phases & resolution; FREE_KICK quick-restart clears foul/setPiece; whether world.foul is reliably cleared so it can't re-trigger; clock advance rate (sim/real). Also: does the user's player end up sensible at kickoff, and does the match ever softlock in a state?`,
  },
  {
    key: 'physics-possession',
    prompt: `DIMENSION: Arcade physics, ball, possession, fouls.
Read: ${ROOT}/src/systems/physics.ts and the relevant parts of ${ROOT}/src/core/constants.ts (PLAYER/BALL/POSSESSION/TACKLE) + ${ROOT}/src/utils/math.ts.
Check: player integration toward steer (accel/decel, turn, low-stamina scaling); stamina drain/regen + sprint gating; dribble snap & that the owner can actually kick (kickCooldown lets the ball leave); loose-ball capture radius & that a just-kicked ball isn't instantly recaptured; standing-jostle steal correctness & immunity; SLIDE foul arbitration (fromBehind/contactSpeed/gotBall math, penalty-box test uses the offender's defensive box, only one foul at a time, only when state===PLAYING && foul===null); goalpost collision; ball bounce/Magnus/spin decay; NaN/divide-by-zero risks (normalize of zero vector, atan2 on zero); ball/player escaping the pitch; possession booleans staleness. Flag anything that could break feel (e.g. ball glued to feet, can't shoot, instant turnovers).`,
  },
  {
    key: 'actions-input',
    prompt: `DIMENSION: User control mapping & input.
Read: ${ROOT}/src/systems/actions.ts, ${ROOT}/src/systems/input.ts, ${ROOT}/src/ui/hudLayout.ts, ${ROOT}/src/core/viewport.ts, and ButtonInput/InputState in ${ROOT}/src/core/types.ts.
Check: control mode derived from possession; auto-switch on losing the ball & manual switch cooldown; ACTION-LOCK after winning ball actually suppresses slide/shoot (the blueprint 'tackle becomes shoot' fix); pass/shoot triggered on RELEASE with holdTime carrying the charge (does input set released + holdTime on the release frame and reset next frame? does actions read shoot.released/pass.released consistently?); the 3-button slot->semantic mapping matches controlMode and the unused pair is zeroed; joystick uses screenDirToWorld so movement orientation matches the renderer; deadzone; preventDefault to stop scroll/zoom; pointer bookkeeping (lost pointers on pointercancel; multiple pointers); keyboard & gamepad mapping; set-piece swipe. Flag any mismatch between input button regions and hudLayout, or move-direction being wrong relative to the pitch orientation.`,
  },
  {
    key: 'ai',
    prompt: `DIMENSION: AI behaviour & fairness.
Read: ${ROOT}/src/systems/ai.ts, and the signatures it depends on in ${ROOT}/src/systems/physics.ts + ${ROOT}/src/systems/actions.ts, plus AI constants in ${ROOT}/src/core/constants.ts.
Check: formation anchoring slides with the ball & compresses correctly per possession; only N chasers pursue while others hold shape; carrier decisions guard ball.owner===self before executeShot/executePass (passing/shooting when not owning the ball would no-op or misbehave); GK clears the ball and returns to line; marking is goal-side; AI never sets player speed/stamina above the same PLAYER limits the user has (NO cheating — fair difficulty only via accuracy/pressing/decision-speed); decision throttling doesn't freeze steering; no per-frame O(n^2) blowups beyond 22 players; no infinite loops; the user's non-active teammates are AI-driven; AI doesn't fight actions.updateControl over isUser/activePlayer. Flag passive/again-and-again behaviours, players running off-pitch, or the AI never shooting.`,
  },
  {
    key: 'render-hud',
    prompt: `DIMENSION: Rendering, HUD, particles, orientation.
Read: ${ROOT}/src/render/renderer.ts, ${ROOT}/src/render/hud.ts, ${ROOT}/src/render/particles.ts, ${ROOT}/src/core/viewport.ts, ${ROOT}/src/ui/hudLayout.ts.
Check: renderer uses worldToScreen for ALL world drawing (consistent with particles) and never double-transforms; camera clamp via clampCameraCenter; dpr handling in resize (canvas.width vs style) so it's crisp and input coords line up with CSS px; painter-order sort of players; ball lifted by z with shadow staying grounded; lineWidth/scale legibility; goals/boxes/circles drawn at correct ends; HUD scoreboard clock format (simSeconds->mm:ss), buttons read the right input state per controlMode, charge arc uses correct max-charge constant; ctx.save/restore balance (leaking transforms/alpha); off-screen arrows; performance (per-frame allocations, gradients created in hot loop). Confirm input's hit regions (hudLayout) match what HUD draws. Flag any orientation inconsistency vs viewport.`,
  },
  {
    key: 'data-economy',
    prompt: `DIMENSION: Data tables, economy, world factory, profiles.
Read: ${ROOT}/src/data/formations.ts, ${ROOT}/src/data/cards.ts, ${ROOT}/src/data/teams.ts, ${ROOT}/src/core/world.ts, ${ROOT}/src/meta/economy.ts, ${ROOT}/src/meta/profile.ts, ${ROOT}/src/meta/progression.ts.
Check: EVERY formation has exactly 11 slots with GK first and norms in [0,1] forming a sane shape; cards.ts has >=2 GK and enough DEF/MID/FWD PER RARITY to field a starter XI from COMMON/RARE (profile.pickStarterRoster must find a card for each 4-4-2 slot — otherwise the starter roster has holes); getCardDef/cardsByRarity correctness; teams.generateSquad lands near targetStrength (average-stat sum convention matching world.buildTeamState and economy.teamStrength) and assigns 11 members GK first; dropRates per pack are sane; stadium/pack unlock gating; world factory pairs squad[i] with formation slot[i] and sets attackDir/facing correctly; economy.teamStrength == world.buildTeamState convention; profile load/save validation & default; upgrade copies/coins indexing into RARITY_TIERS arrays (off-by-one on level-1 index); addXp rollover. Flag any roster hole, strength mismatch, or array index out of range.`,
  },
  {
    key: 'cross-cutting',
    prompt: `DIMENSION: Cross-cutting contract adherence & lifecycle.
Skim ALL of: ${ROOT}/src/systems/*.ts, ${ROOT}/src/render/*.ts, ${ROOT}/src/core/game.ts, ${ROOT}/src/main.ts, ${ROOT}/src/systems/audio.ts.
Check: ONLY physics mutates possession (grep for ball.owner = assignments outside physics.ts); events consumed before game.ts clears them (any consumer running AFTER the clear? any system clearing events itself?); audio guards against missing/suspended AudioContext and resumes on a user gesture (main.ts) — no autoplay crash; input listeners attached/detached around matches without leaks; main.ts match lifecycle (start hides UI + attaches input + resizes; onMatchEnd stops loop, detaches input, applies result once, awards prize/pack, reveals UI); use of world.rng vs the standard library generator inside sim systems; any wall-clock time used in the sim; exactly one isUser maintained; potential undefined access on world.teams[side] / playerById returning undefined. Flag double-application of results, listener leaks, or possession written outside physics.`,
  },
]

phase('Review')
const reviews = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(PREAMBLE + '\n' + d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDING_SCHEMA }).then((r) => ({ key: d.key, ...r }))
  )
)

// Flatten findings; verify the ones that matter (critical/high, plus high-confidence medium).
const allFindings = reviews
  .filter(Boolean)
  .flatMap((r) => (r.findings || []).map((f) => ({ ...f, dimension: r.dimension || r.key })))

const toVerify = allFindings.filter(
  (f) => f.severity === 'critical' || f.severity === 'high' || (f.severity === 'medium' && f.confidence === 'high'),
)

log(`Collected ${allFindings.length} findings; verifying ${toVerify.length} significant ones.`)

phase('Verify')
const verdicts = await parallel(
  toVerify.map((f) => () =>
    agent(
      PREAMBLE +
        `\nADVERSARIALLY VERIFY this single claimed finding. Read the cited code yourself and decide if it is a REAL bug/correctness problem. Default to isReal=false if the code is actually correct or the concern is cosmetic/speculative. If real, give the precise confirmedFix.\n\nCLAIM:\nTitle: ${f.title}\nFile: ${f.file}\nLocation: ${f.location || 'n/a'}\nSeverity(claimed): ${f.severity}\nDescription: ${f.description}\nProposed fix: ${f.suggestedFix}`,
      { label: `verify:${(f.title || '').slice(0, 32)}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...v, dimension: f.dimension, originalSeverity: f.severity }))
  )
)

const confirmed = verdicts.filter(Boolean).filter((v) => v.isReal)
const order = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))

return {
  totalFindings: allFindings.length,
  verified: toVerify.length,
  confirmedCount: confirmed.length,
  confirmed,
  unverifiedLowFindings: allFindings.filter((f) => !toVerify.includes(f)).map((f) => ({ title: f.title, file: f.file, severity: f.severity })),
}
