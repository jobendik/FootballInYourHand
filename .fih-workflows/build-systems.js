export const meta = {
  name: 'fih-build-systems',
  description: 'Implement the decoupled gameplay systems of the Football In Your Hand clone in parallel against a locked contract',
  phases: [{ title: 'Implement', detail: 'one agent per system/data module' }],
}

const ROOT = 'c:/Users/joben/Projects/FootballInYourHand'

const CONTRACT = `
You are implementing ONE FILE in a TypeScript + Vite arcade football game called "Football In Your Hand" — an original, faithful clone of Mini Football. Architecture is DATA-ORIENTED: one GameWorld object holds all state; stateless systems mutate it each tick. All art is drawn on canvas, all audio synthesised; no proprietary assets, no real player names.

STEP 1 — read these ALREADY-WRITTEN contract files to learn the exact types and tunables (DO NOT modify them):
- ${ROOT}/src/core/types.ts        (all interfaces & enums — the data contract)
- ${ROOT}/src/core/constants.ts    (PITCH, PLAYER, BALL, POSSESSION, PASS, SHOT, TACKLE, CONTROL, AI, CAMERA, PARTICLES, HUD, RARITY_TIERS, PROGRESSION, DEFAULT_CONFIG, DIFFICULTY_AI_LEVEL, maxSpeedFromPace)
- ${ROOT}/src/utils/math.ts        (Vec2 maths: add/sub/scale/dot/len/dist/normalize/clamp/lerp/damp/dampVec/angleDiff/rotateToward/moveToward/ease, etc.)
- ${ROOT}/src/utils/rng.ts         (seeded Rng class; world.rng is the shared instance — use it for ALL randomness; never the standard-library generator)
- ${ROOT}/src/utils/pitch.ts       (attackDir, baseAnchor, ownGoalCenter, oppGoalCenter, ownGoalLineX, oppGoalLineX, isInDefensiveBox, isInAttackingBox, attackingPenaltySpot, clampToPitch, withinGoalMouth)
- ${ROOT}/src/core/viewport.ts     (ViewTransform, computeScale, makeTransform, worldToScreen, screenToWorld, screenDirToWorld, worldDirToScreen, clampCameraCenter, MIN_VISIBLE_LENGTH)
- ${ROOT}/src/ui/hudLayout.ts      (HudLayout, ButtonSlot, computeHudLayout, hitButton — input AND hud share this so taps land on drawn buttons)
Also skim ${ROOT}/blueprint.md for the intended GAME FEEL of your system.

IMPORT RULES (tsconfig: strict, noUnusedLocals, noUnusedParameters, noImplicitOverride, isolatedModules, noFallthroughCasesInSwitch, moduleResolution=bundler):
- Use the '@/' alias (= src/). e.g.  import type { GameWorld, Player } from '@/core/types';
- ENUMS (MatchState, TeamSide, PlayerRole, AIState, Rarity, ControlMode) and all constants/functions are RUNTIME VALUES — import with a NORMAL import, NOT 'import type'. Import pure interfaces with 'import type'.
- No unused locals/params (prefix intentionally-unused params with '_'). No 'any' unless truly unavoidable. NO external npm packages — only the DOM + the files above.
- Every switch over an enum must be exhaustive or have a default (noFallthroughCasesInSwitch).

CROSS-MODULE API — every module conforms EXACTLY to these signatures so the pieces link at build time:
  systems/physics.ts
    export function updatePhysics(world: GameWorld, dt: number): void
    export function kickBall(world: GameWorld, kickerId: string, vx: number, vy: number, zVel: number, spin: number): void
    export function giveBallTo(world: GameWorld, playerId: string | null): void
    export function playerById(world: GameWorld, id: string): Player | undefined
    export function nearestPlayerToPoint(world: GameWorld, p: Vec2, side?: TeamSide, excludeId?: string): Player | null
  systems/actions.ts
    export function updateControl(world: GameWorld, dt: number): void
    export function updateUserActions(world: GameWorld, dt: number): void
    export function executePass(world: GameWorld, passerId: string, target: Vec2, charge: number): void
    export function executeShot(world: GameWorld, shooterId: string, aim: Vec2, charge: number, curveInput: number): void
    export function executeSlide(world: GameWorld, playerId: string): void
    export function selectPassTarget(world: GameWorld, passerId: string, aimDirWorld: Vec2): Player | null
    export function switchToBestDefender(world: GameWorld): void
  systems/ai.ts
    export function updateAI(world: GameWorld, dt: number): void
  systems/camera.ts
    export function updateCamera(world: GameWorld, dt: number): void
    export function snapCameraToBall(world: GameWorld): void
  systems/matchController.ts
    export function updateMatch(world: GameWorld, dt: number): void
    export function setupKickoff(world: GameWorld, forSide: TeamSide): void
  systems/input.ts
    export function createInputSystem(canvas: HTMLCanvasElement): InputSystem
  systems/audio.ts
    export function createAudioSystem(): AudioSystem
  render/particles.ts
    export function updateParticles(world: GameWorld, dt: number): void
    export function drawParticles(ctx: CanvasRenderingContext2D, world: GameWorld, t: ViewTransform): void  // ViewTransform from '@/core/viewport'
  render/renderer.ts
    export function createRenderer(canvas: HTMLCanvasElement): Renderer
  render/hud.ts
    export interface HudView { width: number; height: number; dpr: number }
    export function renderHud(ctx: CanvasRenderingContext2D, world: GameWorld, view: HudView): void
  data/formations.ts
    export const FORMATIONS: FormationDef[]; export function getFormation(id: string): FormationDef; export const DEFAULT_FORMATION_ID: string
  data/cards.ts
    export const CARD_POOL: CardDef[]; export function getCardDef(id: string): CardDef | undefined; export function cardsByRarity(r: Rarity): CardDef[]
  data/teams.ts
    export const TEAM_PRESETS: TeamPreset[]; export const PACKS: PackDef[]; export const STADIUMS: StadiumDef[]; export function generateSquad(targetStrength: number, formationId: string, rng: Rng): SquadMember[]

SHARED CONVENTIONS:
- Coordinates: centre origin; +x toward AWAY goal (HOME attacks +x). Ball.z is height (0=ground). Pitch length runs UP the screen (see viewport.ts).
- player.steer = DESIRED VELOCITY (units/s). Controllers (input for the user's active player; AI for all others) write it each frame; physics integrates toward it with PLAYER.accel/decel & PLAYER.turnRate. {x:0,y:0} = stop.
- Possession: ball.owner === player.id means possession. ONLY physics changes possession (giveBallTo / kickBall); other modules call those, never set ball.owner directly.
- world.controlMode is maintained by actions.updateControl. world.activePlayerId is the user player; keep exactly one player.isUser = true (the active one).
- EVENTS: push transient one-frame events: world.events.push({ type, position?, side?, power?, rarity?, playerId? }). The game loop clears world.events each frame — DO NOT clear it yourself. Event types: 'kick'|'pass'|'shot'|'goal'|'tackle'|'foul'|'whistle'|'post'|'save'|'cheer'|'switch'|'bounce'|'kickoff'|'button'.
- Use world.rng for ALL randomness.

OUTPUT: Use the Write tool to create ONLY your assigned file at its exact absolute path. Then return the structured summary. Do NOT create or modify any other file. Make the code complete, correct, and self-consistent with the signatures above — no TODOs, no stubs.
`

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'exports', 'assumptions'],
  properties: {
    file: { type: 'string', description: 'absolute path written' },
    exports: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'any constants/world-fields you assumed missing, or simplifications made' },
    worldFieldsWritten: { type: 'array', items: { type: 'string' } },
    linesOfCode: { type: 'number' },
  },
}

const MODULES = [
  {
    label: 'physics',
    path: `${ROOT}/src/systems/physics.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/systems/physics.ts ===
The foundational arcade-physics + possession system. Exports: updatePhysics, kickBall, giveBallTo, playerById, nearestPlayerToPoint.

updatePhysics(world, dt) — run order inside:
1) PLAYERS (skip sentOff): decrement timers (kickCooldown, actionCooldown, stunTimer, slideTimer, kickAnimTimer) clamped >=0. If stunTimer>0 the player is grounded: damp velocity to ~0, no steer integration. If slideTimer>0: the player is committed to a slide — keep current velocity decaying via PLAYER.decel, ignore steer, advance position. Otherwise integrate toward player.steer: effectiveMax = player.maxSpeed * (player.sprintActive?PLAYER.sprintMultiplier:1) * (stamina<lowStaminaThreshold ? lerp(lowStaminaSpeedMul,1, stamina/lowStaminaThreshold) : 1); clamp the steer's magnitude to effectiveMax to get desiredVel; accelerate velocity toward desiredVel (use PLAYER.accel when speeding up, PLAYER.decel when slowing) limited by dt; update facing by rotateToward(facing, angleOf(velocity), PLAYER.turnRate*dt) when moving; position += velocity*dt. Stamina: drain PLAYER.staminaSprintDrain*dt when sprintActive AND |velocity|>0.3*maxSpeed, else regen PLAYER.staminaRegen*dt; clamp 0..max; force sprintActive=false if stamina<staminaMinToSprint. animPhase += |velocity|*PLAYER.runCycleScale*dt. Finally clampToPitch(position, PITCH, small margin like 8).
2) PLAYER-PLAYER soft collision (O(n^2), 22 players is fine): if two non-slide players overlap within sum of radii, push them apart equally (skip if one is sliding — slider pushes through).
3) BALL: if ball.owner set and that player not sentOff and ball.z < BALL.controlHeight => DRIBBLE: target foot = owner.position + fromAngle(owner.facing)*POSSESSION.dribbleOffset; move ball toward it (dampVec with POSSESSION.dribbleSnap) and set ball.velocity≈owner.velocity, ball.z->0,zVel->0, looseTime=0, lastTouch=owner.id, lastTouchSide=owner.side. Possession booleans: owner side possession=true, other false. ELSE LOOSE BALL: integrate — horizontal friction (if z<=2: reduce speed by BALL.groundDecel*dt toward 0; bounce horizontal energy handled below), airborne apply multiplicative BALL.airDrag per second to horizontal velocity; Magnus: add perpendicular accel = perp(normalize(vel)) * BALL.magnus * ball.spin * |vel| * dt; decay spin by BALL.spinDecay*dt toward 0; vertical: zVel -= BALL.gravity*dt, z += zVel*dt, if z<=0 => z=0, if zVel<-30: bounce zVel=-zVel*BALL.restitution and horizontal vel*=BALL.rollRestitution and push {type:'bounce',position:ball.position}; else zVel=0. position += velocity*dt. Clamp |velocity|<=BALL.maxSpeed. looseTime+=dt.
   GOALPOST collision: posts at (oppGoalLineX & ownGoalLineX for both sides) at y=±goalWidth/2; if ball within (BALL.radius+SHOT.postRadius) of a post and z<goalHeight, reflect horizontal velocity and push {type:'post',position:ball.position}.
   CAPTURE: when loose, find nearest player with kickCooldown<=0, not sentOff, within POSSESSION.captureRadius and ball.z<=BALL.controlHeight; if found => giveBallTo(world, that.id). Prefer the genuinely nearest. A sliding player within POSSESSION.captureRadius also captures (this is how slide steals the ball).
   STANDING JOSTLE: if ball.owner set and an OPPONENT (different side) is within TACKLE.standingStealRadius of the owner and not in kickCooldown, each frame roll world.rng.chance( TACKLE.standingStealChanceBase * dt * 60 * clamp(defending/dribbling ratio) ); on success knock the ball loose toward the opponent (giveBallTo(null) then set a small velocity), or transfer to opponent — knocking loose is fine.
4) SLIDE FOUL ARBITRATION (only if world.state===PLAYING and world.foul===null): for each player with slideTimer>0, check overlap with opponents within TACKLE.slideStealRadius. If the slider got the ball first (ball within slideStealRadius of slider just captured) treat as clean. On body contact with an opponent: gotBall = (ball.owner===sliderId) or ball very close to slider; fromBehind = dot(normalize(slider.velocity), fromAngle(victim.facing)) > 0.3 (hit into victim's back); contactSpeed=|slider.velocity|; foulChance = TACKLE.foulBaseChance + (fromBehind?foulFromBehindBonus:0) + (contactSpeed> 0.8*slider.maxSpeed?foulHighSpeedBonus:0); if gotBall: foulChance *= (1-TACKLE.foulCleanBallReduction). If world.rng.chance(foulChance): set world.foul = { position: victim.position clone, offenderId: sliderId, offenderSide: slider.side, victimId: victim.id, card: (roll red via TACKLE.redChance else yellow via TACKLE.yellowChance else 'none'), isPenalty: isInDefensiveBox(foul.position, slider.side, PITCH), awardedTo: victim.side }; victim.stunTimer=TACKLE.stunDuration; slider.stunTimer=TACKLE.offenderRecover; push {type:'foul',position,side:victim.side}. Else (no foul) if gotBall and ball loose: capture handled above.
   Only ONE foul at a time; once world.foul set, stop arbitrating this frame.

kickBall(world, kickerId, vx, vy, zVel, spin): ball.owner=null; ball.velocity={x:vx,y:vy}; ball.zVel=zVel; ball.spin=spin; ball.lastTouch=kickerId; set lastTouchSide from the kicker's side; ball.looseTime=0; nudge ball.position slightly forward (in velocity dir) by ~ (player.radius+ball.radius+2) so it doesn't re-capture instantly; set kicker.kickCooldown=POSSESSION.kickCooldown; kicker.kickAnimTimer=PLAYER.kickAnimTime. Do NOT push an event (callers push 'pass'/'shot').
giveBallTo(world, playerId|null): if id => set owner, lastTouch, lastTouchSide, ball.velocity≈player.velocity, z=0,zVel=0,looseTime=0, possession booleans. if null => owner=null (leave looseTime as is).
playerById: linear find by id. nearestPlayerToPoint(world,p,side?,excludeId?): linear scan, optional side filter & exclude, skip sentOff, return nearest or null.

Keep it allocation-light in the hot loop where reasonable, but clarity first. This module must be self-contained (no imports from actions/ai/matchController).`,
  },
  {
    label: 'actions',
    path: `${ROOT}/src/systems/actions.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/systems/actions.ts ===
User control mapping + shared action primitives (used by both user input AND ai.ts). Imports kickBall, giveBallTo, playerById, nearestPlayerToPoint from '@/systems/physics'. Exports: updateControl, updateUserActions, executePass, executeShot, executeSlide, selectPassTarget, switchToBestDefender.

updateControl(world, dt): decrement world.actionLockTimer & world.switchCooldown by dt (>=0). owner = ball.owner? playerById : undefined. userHasBall = !!owner && owner.side===world.userSide. world.controlMode = userHasBall ? OFFENSIVE : DEFENSIVE. If OFFENSIVE: set world.activePlayerId = owner.id. Maintain isUser flags so exactly the active player has isUser=true (clear all others). If DEFENSIVE and the current active player is invalid (sentOff / is the GK / wrong side) OR we JUST lost possession (controlMode changed from OFFENSIVE this frame — track via comparing to the previous controlMode you read at the start), auto-call switchToBestDefender. Manual switch: if world.input.switchPlayer && world.switchCooldown<=0 && DEFENSIVE => switchToBestDefender(world).

updateUserActions(world, dt): active = playerById(world.activePlayerId); if missing or sentOff or stunTimer>0 return. MOVEMENT: set active.steer = scale(world.input.move, active.maxSpeed) (world.input.move is already world-space, magnitude<=1). active.sprintActive = world.input.sprint && active.stamina>PLAYER.staminaMinToSprint. If active.slideTimer>0, set steer to {0,0} (physics drives slide).
OFFENSIVE actions (only when ball.owner===active.id):
 - SHOOT on world.input.shoot.released: charge = clamp01(world.input.shoot.holdTime / SHOT.maxChargeTime); aim = a world point toward the opponent goal blended with joystick direction: base = oppGoalCenter(active.side,PITCH); if |world.input.move|>0.15 aim = active.position + scale(normalize(world.input.move), 300) else aim = base. curveInput = the lateral component of the joystick relative to the shot direction in [-1,1] (e.g. cross product sign * magnitude). executeShot(world, active.id, aim, charge, curveInput).
 - PASS on world.input.pass.released: charge = clamp01(world.input.pass.holdTime / PASS.maxChargeTime). aimDir = |world.input.move|>0.15 ? normalize(world.input.move) : fromAngle(active.facing). target = selectPassTarget(world, active.id, aimDir); point = target ? add(target.position, scale(target.velocity, PASS.leadFactor)) : add(active.position, scale(aimDir, 220)); executePass(world, active.id, point, charge).
DEFENSIVE actions: SLIDE if world.input.slide && active.slideTimer<=0 && active.actionCooldown<=0 && world.actionLockTimer<=0 => executeSlide(world, active.id). (world.actionLockTimer suppresses the action button briefly after winning the ball — the documented "tackle becomes shoot" fix.)

executePass(world, passerId, target, charge): passer=playerById; if !passer or ball.owner!==passerId return. dir=normalize(sub(target,passer.position)); d=dist(target,passer.position); speed = clamp(lerp(PASS.groundSpeedMin,PASS.groundSpeedMax, passer.stats.passing/100) + d*PASS.distanceSpeedGain, PASS.groundSpeedMin, 900); add aim jitter: rotate dir by world.rng.jitter(PASS.inaccuracyBase*(1-passer.stats.passing/100)). zVel = charge>0.2 ? PASS.loftZVelMax*charge : 0; if lofted speed*=PASS.loftForwardBoost. spin = world.rng.jitter(0.3). kickBall(world,passerId,dir.x*speed,dir.y*speed,zVel,spin). push {type:'pass',position:passer.position,side:passer.side,power:charge,rarity:passer.rarity,playerId:passerId}. stats[passer.side].passes++.
executeShot(world, shooterId, aim, charge, curveInput): shooter=playerById; if !shooter or ball.owner!==shooterId return. dir=normalize(sub(aim,shooter.position)); rotate dir by world.rng.jitter(SHOT.inaccuracyBase*(1-shooter.stats.shooting/100)); speed = lerp(SHOT.speedMin,SHOT.speedMax, 0.35+0.65*charge) * (0.75+0.25*shooter.stats.shooting/100); spin = curveInput*SHOT.curveMax*(0.5+0.5*shooter.stats.dribbling/100); zVel = SHOT.minLoft + SHOT.loftZVelMax*charge; kickBall(world,shooterId,dir.x*speed,dir.y*speed,zVel,spin); push {type:'shot',position:shooter.position,side:shooter.side,power:Math.max(charge,0.4),rarity:shooter.rarity,playerId:shooterId}; stats[shooter.side].shots++; if the shot is roughly on target for the opponent goal mouth, stats[shooter.side].shotsOnTarget++.
executeSlide(world, playerId): p=playerById; if !p or p.slideTimer>0 return. p.slideTimer=TACKLE.slideDuration; lunge = fromAngle(p.facing); p.velocity = add(p.velocity, scale(lunge, TACKLE.slideLungeSpeed)); p.stamina=Math.max(0,p.stamina-PLAYER.staminaSlideCost); p.actionCooldown=TACKLE.slideDuration+TACKLE.slideRecover; push {type:'tackle',position:p.position,side:p.side,playerId,power:0.7}.
selectPassTarget(world, passerId, aimDirWorld): passer=playerById; consider teammates same side, not self, not sentOff, role!==GK (allow GK only as last resort). For each: to=sub(t.position,passer.position); d=len(to); if d<1 skip; dirT=normalize(to); align=dot(dirT, normalize(aimDirWorld)); forward = (t.position.x - passer.position.x)*attackDir(passer.side); score = align*PASS.aimWeight + forward*PASS.forwardBias*0.002 - d*PASS.distanceWeight; track best. Prefer candidates with align>PASS.aimConeDot; if none clear the cone, fall back to best score overall. Return best Player or null.
switchToBestDefender(world): among world.userSide outfielders (role!==GK, !sentOff), score = -distToBall - CONTROL.switchGoalsideBias*howFarFromGoalsideLine; pick the one nearest the ball but bias toward players positioned between the ball and the user's OWN goal. Set world.activePlayerId, update isUser flags, world.switchCooldown=CONTROL.switchCooldown, push {type:'switch',position: chosen.position}.`,
  },
  {
    label: 'ai',
    path: `${ROOT}/src/systems/ai.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/systems/ai.ts ===
Per-agent finite-state AI: formation anchoring that slides with the ball, nearest-N ball contest, carrier decisions, goalkeeper, fair difficulty. Imports from '@/systems/physics' (playerById, nearestPlayerToPoint, giveBallTo) and '@/systems/actions' (executePass, executeShot, executeSlide, selectPassTarget). Exports: updateAI.

CRITICAL FAITHFULNESS NOTE (blueprint): difficulty must be expressed through POSITIONING, PRESSING INTENSITY, PASS/SHOT ACCURACY and DECISION SPEED only. DO NOT cheat on max speed or stamina — AI obeys the same PLAYER physics as the user. Interpolate AI.passAccuracyByLevel / shotChanceByLevel / pressIntensityByLevel / anticipationByLevel / decisionIntervalByLevel by the team's aiLevel.

updateAI(world, dt): run when world.state===PLAYING or KICKOFF (during KICKOFF only do return-to-anchor, no actions). For EVERY player that is NOT the user's active player (i.e. !player.isUser) and !sentOff:
 - level = world.teams[player.side].aiLevel.
 - Compute the player's dynamic anchor: base = baseAnchor(player.formationNorm, world.teams[player.side].attackDir, PITCH). Slide the whole shape toward the ball: anchor.x = base.x + (ball.position.x - base.x)*AI.ballInfluenceX ; anchor.y = base.y + (ball.position.y - base.y)*AI.ballInfluenceY. Add possession bias: if the player's team has possession shift anchor.x toward opp goal by AI.offensiveShift*halfLength*attackDir; else toward own goal by AI.defensiveShift*halfLength*attackDir. Store into player.anchor (clampToPitch).
 - GK (role===GK): GOALKEEP. Stay on a line AI.gkLineDepth off the own goal, tracking ball.y clamped to ±AI.gkRangeY; advance off the line if ball is close & inside own half (sweeper). If GK owns the ball, after a brief beat clear it up-field via executePass to a teammate (selectPassTarget toward opp goal) — call it once. Steer toward the intercept point at up to maxSpeed (use sprint when ball is a clear breakaway). Let physics handle the actual catch (GK is usually nearest).
 - Outfield decision (throttle real decisions with player.aiDecisionTimer counting down by dt; when <=0 re-pick state & target, reset timer to lerp(decisionIntervalByLevel) + rng jitter; but ALWAYS update steering toward the current target every frame):
    * Determine the team's N=AI.chasers closest outfielders to the ball. If this player is one of them AND (ball loose OR owned by opponent): state CHASE_BALL/PRESS — steer to an intercept point (lead the ball by its velocity); if within slide range of an opponent carrier, occasionally executeSlide (chance scaled by pressIntensity & proximity, respect cooldowns); otherwise body-press (physics standing-jostle may win it).
    * If team has possession and this player IS the carrier (ball.owner===player.id): CARRIER LOGIC — face/dribble toward opp goal while veering away from the nearest opponent (steer = blend of toGoal and awayFromPressure). Decisions gated by aiDecisionTimer: if in shooting range (within ~ 320 of opp goal and a roughly open lane) and rng.chance(shotChanceByLevel) -> executeShot(player.id, oppGoalCenter±rng aim, charge≈0.5, curve). Else if under pressure (opponent within ~70) and a teammate is open and rng.chance(passAccuracyByLevel) -> executePass to selectPassTarget(toward goal). Else keep dribbling. Set sprintActive when space ahead & stamina ok.
    * If team has possession and NOT carrier: SUPPORT_ATTACK — move to space: offset from anchor toward the attacking third and away from other teammates/markers to offer a passing lane.
    * Else (out of possession, not a chaser): RETURN_TO_ANCHOR or MARK the nearest opponent in the player's zone (within AI.markRadius) — goal-side marking position between opponent and own goal.
 - Set player.steer = scale(normalize(sub(target, player.position)), desiredSpeed) where desiredSpeed = player.maxSpeed*(player.sprintActive?PLAYER.sprintMultiplier:1). If essentially at the target (dist< ~14) set steer to a small value or {0,0} to avoid jitter. Never set steer magnitude above player.maxSpeed*sprintMultiplier.
Make it feel like a coordinated team: only 1-2 players chase, the rest hold shape and shift with the ball. Keep CPU cost reasonable (precompute the ball-distance sorted list per team once per frame).`,
  },
  {
    label: 'camera',
    path: `${ROOT}/src/systems/camera.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/systems/camera.ts ===
Ball-follow camera + screen shake + hit-stop, all driven from world events. Exports: updateCamera, snapCameraToBall.

updateCamera(world, dt):
- Target: during set pieces (state PENALTY or FREE_KICK and world.setPiece) target = world.setPiece.position (or reticle for penalties); otherwise target = ball.position + ball.velocity*CAMERA.lookAhead (clamp the look-ahead offset to a sane max ~140 units). Store camera.target.
- camera.position = dampVec(camera.position, camera.target, CAMERA.smooth, dt).
- Zoom: ease camera.zoom toward camera.targetZoom with CAMERA.zoomSmooth (use a per-frame lerp factor). Default targetZoom=CAMERA.baseZoom; nudge targetZoom slightly in (e.g. *1.06) during GOAL_CELEBRATION/PENALTY for drama, back to base otherwise.
- Events → feel: scan world.events. If config.screenShakeEnabled and not reducedMotion, add to camera.shake (take max, don't sum unboundedly): 'shot'→CAMERA.shotShake*(event.power||1), 'post'→CAMERA.postShake, 'goal'→CAMERA.goalShake, 'tackle'→CAMERA.tackleShake. Clamp camera.shake to CAMERA.shakeMaxOffset. If not reducedMotion, set world.hitStop = max(world.hitStop, ...) on 'goal'→CAMERA.hitStopGoal, 'post'→CAMERA.hitStopPost, 'tackle' with power>0.5→CAMERA.hitStopTackle.
- Resolve shake: decay camera.shake by CAMERA.shakeDecay*dt (toward 0). camera.offset = { x: world.rng.jitter(camera.shake), y: world.rng.jitter(camera.shake) } (zero offset when shake≈0).
snapCameraToBall(world): camera.position = clone(ball.position); camera.target = clone(ball.position); camera.offset={x:0,y:0}; camera.shake=0; camera.zoom=CAMERA.baseZoom; camera.targetZoom=CAMERA.baseZoom.
Note: do NOT clamp the camera to the pitch here (the renderer does that when it knows the viewport size).`,
  },
  {
    label: 'matchController',
    path: `${ROOT}/src/systems/matchController.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/systems/matchController.ts ===
The match state machine: clock, kickoff, goals, out-of-bounds restarts, fouls→free kick/penalty, half time, full time. Imports from '@/systems/physics' (giveBallTo, kickBall, playerById, nearestPlayerToPoint). Exports: updateMatch, setupKickoff.

Use a helper transition(world,newState) that sets prevState, state, stateTimer=0.

updateMatch(world, dt): world.stateTimer += dt. switch on world.state:
- KICKOFF: players already placed by setupKickoff. After MATCH.kickoffDelay: pick the kicking side's central forward/mid nearest centre, giveBallTo(that.id), push {type:'whistle'} and {type:'kickoff'}, transition PLAYING.
- PLAYING:
   * Advance clock: rate = clock.durationSimSeconds / MATCH.durationRealSeconds. clock.simSeconds += dt*rate; clock.realElapsed += dt. Possession stat: increment world.stats[ownerSide].possessionFrames when ball.owner set.
   * HALF TIME: if half===1 and clock.simSeconds >= durationSimSeconds/2 => transition HALF_TIME.
   * FULL TIME: if half===2 and clock.simSeconds >= durationSimSeconds => set resultText (e.g. "FULL TIME") and transition MATCH_END.
   * FOUL: if world.foul!==null => push {type:'whistle'}; if foul.isPenalty => set up world.setPiece={type:'penalty',forSide:foul.awardedTo,position:attackingPenaltySpot(foul.awardedTo,PITCH),phase:'aim',reticle:clone(oppGoalCenter(foul.awardedTo,PITCH)),reticleVel:{x:0,y:0},keeperDive:0,timer:0} and transition PENALTY; else set world.setPiece={type:'free_kick',forSide:foul.awardedTo,position:clone(foul.position),phase:'setup',reticle:clone(foul.position),reticleVel:{x:0,y:0},keeperDive:0,timer:0} and transition FREE_KICK. (Leave world.foul set; it is cleared on the next kickoff/restart.)
   * GOAL detection (after physics moved the ball this frame): a goal is scored when the ball fully crosses a goal line within the mouth and under the bar. HOME attacks +x so HOME scores when ball.position.x > PITCH.halfLength and withinGoalMouth(ball.y) and ball.z < PITCH.goalHeight. AWAY scores when ball.position.x < -PITCH.halfLength similarly. On goal: scoringSide gets score++, world.stats updated, push {type:'goal',side:scoringSide} and {type:'cheer'}; remember the CONCEDING side; transition GOAL_CELEBRATION.
   * OUT OF BOUNDS (only if not a goal):
       - Over a goal line outside the mouth (|ball.x|>halfLength and (!withinGoalMouth(ball.y) or ball.z>=goalHeight)): determine which goal line; if the ball was last touched by the ATTACKING team for that goal => goal kick to the defending side (place ball in defending team's goal-area, giveBallTo their GK); else => corner to the attacking side (place ball at the near corner, giveBallTo nearest attacker). Then continue PLAYING (quick restart, no state change).
       - Over a touchline (|ball.y|>halfWidth): kick-in to the opponent of ball.lastTouchSide: clamp ball to the touchline at its x, giveBallTo nearest player of that opponent side, continue PLAYING.
     Keep restarts instant (arcade flow). Reset ball.z/zVel on restarts.
- GOAL_CELEBRATION: after MATCH.goalCelebration => setupKickoff(world, concedingSide) (the side that conceded kicks off).
- HALF_TIME: after MATCH.halfTimePause => clock.half=2; setupKickoff(world, the side that did NOT kick off the first half) — track first-half kickoff side (default AWAY kicks off second half if unknown).
- FREE_KICK: SIMPLIFIED quick free kick — after a short MATCH.foulPause, place the awarded side's nearest player on the ball at world.setPiece.position, giveBallTo(that.id), clear world.foul & world.setPiece, transition PLAYING. (A full swipe minigame is out of scope; document this in assumptions.)
- PENALTY: full minigame. phase 'aim': the ATTACKING side is forced; if the attacker is the user (forSide===userSide) the user aims by moving world.input.move to nudge setPiece.reticle within the goal mouth (clamp reticle.y to ±goalWidth/2 *0.95, reticle.x at the opp goal line) and strikes on world.input.shoot.released (or a tap) -> phase 'strike'. If the attacker is AI, after ~1.2s pick a reticle target (rng, with accuracy by aiLevel) -> 'strike'. The defending GK chooses a dive direction keeperDive ∈ {-1,0,1}: if the DEFENDER is the user, read world.input.swipe (or world.input.move x) on the strike to pick dive; else AI guesses (rng, better guess at high aiLevel). On 'strike': compute whether it is a goal — taker shot goes toward reticle with small inaccuracy; save if keeperDive matches the reticle side (and centre handling). kickBall the ball toward the reticle for visuals. Resolve after a beat: if goal -> score++ and push 'goal'/'cheer' then GOAL_CELEBRATION (conceding = defender side); if saved -> push 'save' then a goal kick restart to the defending side and PLAYING. Clear setPiece/foul on resolve.
- MATCH_END: stop the clock (clock.running=false); nothing else (UI handles it).

setupKickoff(world, forSide): clear world.foul=null, world.setPiece=null. Reset EVERY player to baseAnchor(formationNorm, team.attackDir, PITCH) with velocity {0,0}, slideTimer/stun/cooldowns 0, sprintActive false, steer {0,0}. Place the ball at centre {0,0}, z 0, velocity 0, owner null. Move two of forSide's central players just behind/at centre to take the kickoff. transition KICKOFF. Record which side kicked off so HALF_TIME can alternate (store it on a module-level variable scoped to this module; reset appropriately at match start — note this in assumptions).

Be careful with noFallthroughCasesInSwitch — break/return each case.`,
  },
  {
    label: 'input',
    path: `${ROOT}/src/systems/input.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/systems/input.ts ===
Touch (Pointer Events) floating joystick + contextual buttons + keyboard + Gamepad API. Implements the InputSystem interface (attach, detach, sample, resize). Export: createInputSystem(canvas).

Read core/viewport.ts (screenDirToWorld) and ui/hudLayout.ts (computeHudLayout, hitButton, ButtonSlot). The system keeps internal mutable state (closures over local vars), and writes world.input only in sample().

DOM handling (attach):
- Set canvas.style.touchAction='none'; add Pointer Event listeners (pointerdown/move/up/cancel) on the canvas; call e.preventDefault() to stop scroll/zoom; also listen window keydown/keyup. Track active pointers in a Map<pointerId, {x,y,startX,startY,role,slot?}>.
- A pointerdown with x < layout.splitX (left half) and no existing joystick pointer => role 'joystick', anchor origin at (x,y). A pointerdown on the right => hitButton(layout,x,y); if it hits a button, role 'button' with the slot, mark that slot pressed. The most recent right-side drag also feeds the set-piece swipe (record start/current; on up compute released+power).
- pointermove updates the pointer's x,y. pointerup/cancel removes it (and on a button pointer, marks release; on joystick pointer, deactivates joystick).
detach: remove all listeners.
resize(cssW, cssH): store size; recompute layout via computeHudLayout.

sample(world, dt): build world.input fresh each frame:
- JOYSTICK: if a joystick pointer exists: origin=its start, knob = clamp the (cur-origin) vector to HUD.joystickRadius; mag = min(len(cur-origin)/HUD.joystickRadius, 1); if mag<HUD.joystickDeadzone => move {0,0},mag 0; else screenDir = normalize(cur-origin) (screen space, y down) and worldDir = screenDirToWorld(screenDir.x, screenDir.y); world.input.move = scale(worldDir, mag); world.input.moveMagnitude=mag. Fill world.input.joystick {active:true, origin, knob: origin+clamped, radius:HUD.joystickRadius}. Else if keyboard movement keys are down, build a screen-dir from WASD/arrows (W/up = screen up), convert via screenDirToWorld, magnitude 1, joystick.active=false. Else if gamepad left stick beyond deadzone, use it. Else move {0,0}, joystick.active=false.
- BUTTONS: maintain per-slot held state from pointer buttons + keyboard (Space=action slot, J=mid slot, Shift=sprint slot; also allow K=mid, L=action) + gamepad (A/button0=action, B/button1=sprint, X/button2=mid, optionally bumpers). For each slot track: held(boolean), pressed(true only the frame it goes down), released(true only the frame it goes up), holdTime(accumulate dt while held; ON the release frame report the total holdTime that WAS accumulated, then reset to 0 the following frame).
  Map slots to semantic intents using world.controlMode:
    sprint slot -> world.input.sprint = held.
    if OFFENSIVE: world.input.pass = {pressed,held,holdTime,released} of mid slot; world.input.shoot = {...} of action slot; world.input.switchPlayer=false; world.input.slide=false.
    if DEFENSIVE: world.input.switchPlayer = mid slot pressed (edge); world.input.slide = action slot pressed (edge); world.input.pass/shoot = {pressed:false,held:false,holdTime:0,released:false}.
- SWIPE: fill world.input.swipe from the most recent right-side drag (start, current, vector=cur-start, released edge, power=clamp01(len(vector)/ (0.35*min(cssW,cssH)))). Set active while a drag is in progress.
- GAMEPAD: poll navigator.getGamepads(); set world.input.gamepadActive=true when a gamepad provides input this frame.
NOTE: ButtonInput type has fields pressed/held/holdTime AND released (read types.ts to confirm the exact shape and match it). The screen-dir→world conversion is the ONLY place movement orientation is decided besides the renderer; rely on screenDirToWorld so it stays consistent.`,
  },
  {
    label: 'audio',
    path: `${ROOT}/src/systems/audio.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/systems/audio.ts ===
WebAudio synthesised SFX + light crowd ambience. Implements AudioSystem (resume, setEnabled, update, ui). Export: createAudioSystem().

No samples — synthesise everything with OscillatorNode / noise buffers / gain envelopes through a master GainNode -> destination. Lazily create the AudioContext (and resume it) in resume(); guard EVERY method so nothing throws if the context isn't created yet or is suspended (just no-op). Keep two sub-gains: sfxGain and musicGain, toggled by setEnabled(sfx, music).

update(world, dt): if no context or suspended, return. Drain world.events (read, do not clear) and play a short synth per type, but THROTTLE: cap total sounds per frame (e.g. 4) and de-dupe identical types in the same frame. Suggested sounds:
 - 'kick'/'pass': short low thump (sine ~140Hz, fast decay) + tiny noise burst.
 - 'shot': stronger thump + a quick downward pitch sweep, louder when power high.
 - 'goal': a celebratory triad/arpeggio (3 oscillators) + crowd cheer swell (filtered noise rising then falling).
 - 'cheer': crowd noise swell (separate from goal so it can layer).
 - 'whistle': two quick high tones (~2.4kHz) with a warble.
 - 'post': metallic ping (high sine + slight detune, fast decay).
 - 'save': muffled thud (low noise burst).
 - 'tackle': scuffle (band-passed noise burst).
 - 'switch': short UI blip.
 - 'bounce': soft short click (very quiet).
Crowd ambience: a continuous low-level filtered-noise bed (musicGain) whose volume rises gently with match excitement (e.g. when ball near either box) — keep subtle; start/stop it in resume()/setEnabled appropriately.
ui(name): 'click' (short blip), 'whoosh' (noise sweep), 'reward' (rising arpeggio), 'error' (low buzz), 'pack' (sparkly arpeggio).
setEnabled(sfx,music): set the two gains (0 when disabled). resume(): create context if needed, await ctx.resume(), build the graph + ambience.
Keep amplitudes modest (master gain ~0.5) and always ramp gains to avoid clicks. Do not reference DOM beyond AudioContext. Use the WebAudio time clock (ctx.currentTime) for scheduling, never wall-clock time.`,
  },
  {
    label: 'particles',
    path: `${ROOT}/src/render/particles.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/render/particles.ts ===
Pooled particle system + rarity VFX trails. Exports: updateParticles(world,dt), drawParticles(ctx, world, t: ViewTransform). Import ViewTransform & worldToScreen from '@/core/viewport'.

The pool lives in world.particles (Particle[] — see types.ts). Maintain up to PARTICLES.max; reuse inactive slots (active:false) rather than growing unbounded; if full, overwrite the one with the least life. Provide an internal spawn(world, partialParticle) helper that grabs/initialises a slot.

updateParticles(world, dt):
1) Spawn FROM EVENTS (read world.events, do not clear):
   - 'tackle' -> grass spray: PARTICLES.slideGrassCount green 'grass' bits flung backward from position with upward zVel.
   - 'goal' -> PARTICLES.goalConfettiCount 'confetti' from around the scoring goal / ball, bright colours, gravity, spin.
   - 'kick'/'pass'/'shot' -> PARTICLES.kickDustCount small 'dust' puffs at position.
   - 'post' -> a few 'spark' bits.
   - 'bounce' -> 1-2 faint 'dust'.
   - 'save' -> small 'dust'.
2) RARITY TRAILS: if config.rarityVfxEnabled and ball.owner is set and that player's rarity is EPIC/LEGENDARY/MYTHICAL, emit 'trail' particles at the ball position at PARTICLES.rarityTrailRate*dt (accumulate fractional spawns in a module-local accumulator), colour from RARITY_TIERS[rarity].color, small, short life, slight rise. Emit a denser burst while that owner is charging a shot (world.input.shoot.held).
3) INTEGRATE active particles: velocity affected by drag (vel *= drag^dt or vel -= vel*drag*dt), position += vel*dt, zVel -= gravity*dt, z += zVel*dt (clamp z>=0; for grounded kinds let them settle), rotation += rotationVel*dt, life -= dt; deactivate when life<=0.

drawParticles(ctx, world, t): for each active particle compute screen = worldToScreen(t, pos.x, pos.y) and lift by z (subtract z * t.scale * ~0.6 from screen.y to fake height). alpha = clamp01(life/maxLife). Draw by kind: 'spark'/'star' small bright lines/4-point stars; 'confetti' small rotated rects; 'grass'/'dust' tiny circles; 'ring' expanding stroked circle (size grows as life falls); 'trail' soft additive glow dot; 'sweat' tiny circle. Scale sizes by t.scale. Use ctx.save/restore; set globalAlpha then reset. Keep it cheap.`,
  },
  {
    label: 'renderer',
    path: `${ROOT}/src/render/renderer.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/render/renderer.ts ===
The main canvas renderer. Export: createRenderer(canvas) returning a Renderer {resize, render}. Import worldToScreen/makeTransform/computeScale/clampCameraCenter from '@/core/viewport', drawParticles from '@/render/particles', renderHud from '@/render/hud'. Use MANUAL projection (worldToScreen) for ALL world-space drawing — do NOT set a world transform on the ctx (the only ctx transform is the dpr scale). This keeps it consistent with particles.

resize(cssW, cssH, dpr): canvas.width=round(cssW*dpr); canvas.height=round(cssH*dpr); canvas.style.width=cssW+'px'; canvas.style.height=cssH+'px'; get '2d' context; ctx.setTransform(dpr,0,0,dpr,0,0) so all drawing is in CSS px. Store cssW/cssH/dpr/ctx.

render(world):
- scale = computeScale(cssW,cssH,PITCH). Clamp the camera centre for drawing: clampedCenter = clampCameraCenter({x:camera.position.x+camera.offset.x, y:camera.position.y+camera.offset.y}, cssW, cssH, scale, PITCH). Build t = makeTransform(cssW,cssH,{position:clampedCenter, offset:{x:0,y:0}, ...other camera fields}, scale). t is a ViewTransform.
- Clear whole canvas (in CSS px). Fill background with a dark out-of-pitch colour.
- DRAW PITCH (world space via worldToScreen): mown grass stripes running across the width (alternating greens) covering the pitch rectangle [-halfLength..halfLength]x[-halfWidth..halfWidth]; white boundary lines (lineWidth ~ max(1.5, 2.5*t.scale)); halfway line; centre circle (radius centerCircleRadius) + centre spot; both penalty boxes (penaltyBoxDepth x penaltyBoxWidth at each goal line), goal areas, penalty spots (penaltySpotDist), penalty arcs; corner arcs; and the GOALS at each end: posts at y=±goalWidth/2 extending goalDepth behind the line, a net hatch. Because the projection rotates the world 90°, project each corner point with worldToScreen and stroke/fill the resulting screen polygons; circles stay circles (uniform scale) so use ctx.arc at the projected centre with radius*t.scale.
- SHADOWS: soft dark ellipse under each player at its ground position; under the ball at its ground position (the shadow stays on the ground while the ball lifts).
- PLAYERS (skip sentOff): sort by projected screen.y ascending (painter's order). Draw a stylised BIG-HEAD cartoon footballer: small body/torso in the team kit primary (with secondary trim), shorts, two legs animated using sin(animPhase) for a running cycle (longer stride when fast), a large round head (skin tone) above, jersey number on the torso, a thin dark outline. When slideTimer>0 draw a sliding pose (body low, one leg extended along facing). When kickAnimTimer>0 draw a kicking leg pose. Orient the player by facing. For world.activePlayerId draw a coloured RING at the feet (e.g. cyan) to mark the user-controlled player. Optionally a tiny stamina arc.
- BALL: a white circle with a couple of dark pentagon marks rotated by accumulated spin; size = ball.radius*t.scale; draw it RAISED by ball.z (subtract z*t.scale*0.6 from screen.y) so it visibly lifts on lofted balls/shots, with its shadow left on the ground.
- drawParticles(ctx, world, t).
- OFF-SCREEN INDICATORS: for the user's teammates (and the ball if off-screen) that fall outside the viewport, draw small arrows clamped to the screen edges pointing toward them. Keep subtle.
- SET-PIECE world overlay: if state PENALTY and setPiece, draw the aiming reticle (a red target ring) at worldToScreen(setPiece.reticle).
- FPS: if config.showFps, track frame times internally (you may keep a rolling average using the dt implied by successive renders — but DO NOT call wall-clock APIs; instead expose nothing and simply skip FPS if you cannot measure without them). Prefer to draw a small fps number top-left only if you can derive it cheaply; otherwise omit.
- Finally call renderHud(ctx, world, {width:cssW, height:cssH, dpr}).
Use ctx.save/restore around grouped draws. Aim for clean, readable, performant 2D.`,
  },
  {
    label: 'hud',
    path: `${ROOT}/src/render/hud.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/render/hud.ts ===
In-match HUD overlay, screen space. Export interface HudView {width;height;dpr} and function renderHud(ctx, world, view). Import computeHudLayout + ButtonSlot from '@/ui/hudLayout'. Draw in CSS px (dpr already applied by the renderer's ctx transform). Respect HUD.opacity for the controls' transparency.

layout = computeHudLayout(view.width, view.height).
- SCOREBOARD (top centre, unobtrusive pill): home shortName, score "H - A", away shortName, and the match clock formatted mm:ss from world.clock.simSeconds (e.g. 5400s -> 90:00), plus a small half indicator (1st/2nd). Slightly translucent dark pill, white text.
- JOYSTICK: if world.input.joystick.active draw a translucent base ring at origin (radius) and a knob circle at knob.
- ACTION BUTTONS: draw the three circular buttons from layout. Labels/icons depend on world.controlMode: OFFENSIVE => sprint:"⚡"/Sprint, mid:"Pass", action:"Shoot"; DEFENSIVE => sprint:"⚡"/Sprint, mid:"Switch", action:"Slide". Style: translucent filled circle, ring, centred label. Highlight (brighter/scale) when its input is active: sprint when world.input.sprint; mid when (OFFENSIVE? input.pass.held : input.switchPlayer); action when (OFFENSIVE? input.shoot.held : input.slide). For the offensive pass/shoot buttons, draw a CHARGE ARC around the button growing with holdTime/maxChargeTime while held (PASS.maxChargeTime / SHOT.maxChargeTime).
- BANNERS (centre, large, animated alpha via world.stateTimer easing): KICKOFF -> "KICK OFF"; GOAL_CELEBRATION -> "GOAL!"; HALF_TIME -> "HALF TIME"; MATCH_END -> world.resultText + final score; FREE_KICK -> "FREE KICK"; PENALTY -> "PENALTY" plus a small instruction ("Aim & shoot" if attacking user / "Swipe to dive" if defending user).
- Optional small possession % bar derived from world.stats possessionFrames.
Keep typography clean (system sans). Use ctx.save/restore. Do not draw any world-space gameplay (the renderer owns that).`,
  },
  {
    label: 'formations',
    path: `${ROOT}/src/data/formations.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/data/formations.ts ===
All seven formations from the blueprint plus helpers. Exports: FORMATIONS: FormationDef[], getFormation(id) (falls back to the default), DEFAULT_FORMATION_ID.

Each FormationDef has exactly 11 slots, GK FIRST, with normalised coords: norm.x = depth (0 = own goal line, 1 = opponent goal line), norm.y = width (0 = one touchline, 1 = the other). GK ≈ {x:0.05, y:0.5}. Spread defenders ≈ x 0.20-0.26, midfield ≈ x 0.45-0.60, forwards ≈ x 0.74-0.86, with y values spreading players across the pitch (e.g. a back four at y ≈ 0.18/0.39/0.61/0.82). Give each slot a sensible label (GK, RB, RCB, LCB, LB, CDM, CM, CAM, RW, LW, ST, etc.). Fill shape + description from the blueprint table.
Formations (use these exact ids & names):
 '4-3-3' (GK+4DEF+3MID+3FWD, wing-focused high press),
 '4-4-2' (balanced, symmetrical) — DEFAULT_FORMATION_ID = '4-4-2',
 '4-2-3-1' (2 CDM + 3 AM + 1 ST, deep midfield control),
 '3-5-2' (3 CB + 5 MID + 2 ST, wingbacks stretch),
 '4-4-2-diamond' name '4-4-2 Diamond' (1 CDM, 2 CM, 1 CAM, 2 ST),
 '4-1-4-1' (1 CDM + 4 MID + 1 ST, compact low block),
 '3-3-3' (symmetrical width, passing triangles).
unlockLevel: 4-4-2 and 4-3-3 = 1; others increasing (e.g. 3,5,7,9,11). Make the coordinates look like a real, balanced shape for each.`,
  },
  {
    label: 'cards',
    path: `${ROOT}/src/data/cards.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/data/cards.ts ===
The collectible card pool. Exports: CARD_POOL: CardDef[], getCardDef(id), cardsByRarity(r).

Invent ~72 cards (NO real player names — invent plausible footballer-style names). Distribute across rarities AND roles so a full team can be built at every tier:
 - COMMON ~18, RARE ~18, EPIC ~16, LEGENDARY ~12, MYTHICAL ~8.
 - Each rarity must include enough of every PlayerRole (GK/DEF/MID/FWD) to field a squad (at least 2 GK, several DEF/MID/FWD per rarity).
baseStats (PlayerStats: pace/shooting/passing/dribbling/defending/physical, 0-100) should reflect BOTH the rarity tier and the role. Scale GAMEPLAY stats by rarity: COMMON avg ≈ 50-60, RARE ≈ 60-68, EPIC ≈ 68-76, LEGENDARY ≈ 78-86, MYTHICAL ≈ 88-95. And by role: GK high defending/physical, low shooting; DEF high defending/physical; MID high passing/dribbling; FWD high pace/shooting/dribbling. Vary within tiers so cards feel distinct. Ids like 'c-com-gk-1', 'c-myth-fw-2'. nation: an invented or generic country (optional). Provide a small internal name pool and assign deterministically — hand-author the data or use fixed arrays/indices; do NOT introduce any nondeterministic randomness at module load. getCardDef: lookup by id; cardsByRarity: filter.`,
  },
  {
    label: 'teams',
    path: `${ROOT}/src/data/teams.ts`,
    spec: `
=== IMPLEMENT: ${ROOT}/src/data/teams.ts ===
Opponent presets, packs, stadiums (Victory Path), and a squad generator. Exports: TEAM_PRESETS: TeamPreset[], PACKS: PackDef[], STADIUMS: StadiumDef[], generateSquad(targetStrength, formationId, rng). Import getFormation from '@/data/formations'. NO real club/country names — invent them.

TEAM_PRESETS (~12): invented club/national names + shortName (3 letters) + a KitConfig (primary/secondary/shorts/socks/accent hex colours, visually distinct) + formationId (from the formation ids) + baseStrength spanning a range (e.g. 380 weak → 980 elite) for matchmaking.
PACKS (~4-5): e.g. 'bronze'(coins, cheap, mostly Common/Rare), 'silver'(coins, Rare/Epic), 'gold'(gems or coins, Epic/Legendary), 'legendary'(gems, Legendary/Mythical), 'starter'. Each with cost, currency, cardCount, dropRates as a Record<Rarity, number> (relative weights that reflect the tier and satisfy the v4.0 transparency idea — higher packs have real Legendary/Mythical odds), unlockLevel, accent colour, name, description.
STADIUMS (~6): the Victory Path tiers — name, entryFee (coins), prize (coins on win > entryFee), minStrength (matchmaking gate, rising), packId (awarded pack), unlockLevel (rising).
generateSquad(targetStrength, formationId, rng): use getFormation(formationId).slots (11, GK first) to know roles. Produce 11 SquadMember {name, number, role, rarity, stats}. The squad's total rating (sum of per-player average stat) should land near targetStrength: perPlayerAvg = targetStrength/11; for each slot, build PlayerStats centred on perPlayerAvg with role weighting (GK→defending/physical high & shooting low; DEF→defending/physical; MID→passing/dribbling; FWD→pace/shooting/dribbling) and rng jitter (use the passed rng, clamp 1..99). Assign rarity by the resulting average (higher avg → higher rarity tier thresholds). Numbers 1..11 (GK=1). Invent names from an internal pool indexed by rng. Keep it deterministic given the rng.`,
  },
]

phase('Implement')
const results = await parallel(
  MODULES.map((m) => () =>
    agent(CONTRACT + m.spec, { label: m.label, phase: 'Implement', schema: OUT_SCHEMA }).then((r) => ({ module: m.label, ...r }))
  )
)

return { count: results.filter(Boolean).length, modules: results.filter(Boolean) }
