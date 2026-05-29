/**
 * Unified input system: floating virtual joystick + contextual action buttons (Pointer
 * Events), keyboard, and the HTML5 Gamepad API.
 *
 * The HUD is split into two hemispheres (see `ui/hudLayout`): touches starting left of
 * `layout.splitX` drive a dynamic, floating joystick whose origin lands wherever the thumb
 * touches; touches on the right hit-test the three contextual buttons (sprint / mid /
 * action) and also feed the set-piece swipe gesture. `world.controlMode` decides whether the
 * mid/action buttons mean pass/shoot (offensive) or switch/slide (defensive), so downstream
 * consumers read pure semantic intent from `world.input`.
 *
 * Orientation is decided in exactly one place — `screenDirToWorld` — shared with the
 * renderer so "forward" can never disagree between drawing and control.
 */
import type { GameWorld, InputSystem, Vec2 } from '@/core/types';
import { ControlMode } from '@/core/types';
import { HUD } from '@/core/constants';
import { screenDirToWorld } from '@/core/viewport';
import { computeHudLayout, hitButton, type HudLayout, type ButtonSlot } from '@/ui/hudLayout';
import { clamp, clamp01, clampVecLength, normalize } from '@/utils/math';

// ───────────────────────────── Internal types ─────────────────────────────

type PointerRole = 'joystick' | 'button' | 'swipe';

interface ActivePointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  role: PointerRole;
  slot?: ButtonSlot;
}

/** Per-slot accumulated state, independent of which device drove it. */
interface SlotState {
  held: boolean;
  pressed: boolean; // edge: true only the frame it goes down
  released: boolean; // edge: true only the frame it goes up
  holdTime: number; // live accumulator while held
  reportHold: number; // value to surface this frame (the total held on the release frame)
}

function makeSlotState(): SlotState {
  return { held: false, pressed: false, released: false, holdTime: 0, reportHold: 0 };
}

/** Snapshot of the latest finished/in-progress right-side drag, for the swipe gesture. */
interface SwipeState {
  active: boolean;
  start: Vec2;
  current: Vec2;
  released: boolean; // edge: true the frame it lifts
  power: number; // 0..1, computed on release
}

const SLOTS: ButtonSlot[] = ['sprint', 'mid', 'action'];

export function createInputSystem(canvas: HTMLCanvasElement): InputSystem {
  // ── Sizing / layout ──
  let cssW = canvas.clientWidth || canvas.width || 1;
  let cssH = canvas.clientHeight || canvas.height || 1;
  let layout: HudLayout = computeHudLayout(cssW, cssH);

  // ── Pointer tracking ──
  const pointers = new Map<number, ActivePointer>();
  let joystickPointerId: number | null = null;

  // ── Button held-state, fused across pointer + keyboard + gamepad each frame ──
  const slots: Record<ButtonSlot, SlotState> = {
    sprint: makeSlotState(),
    mid: makeSlotState(),
    action: makeSlotState(),
  };
  // Edge tracking: previous-frame raw "down" state per slot, to derive pressed/released.
  const prevDown: Record<ButtonSlot, boolean> = { sprint: false, mid: false, action: false };

  // ── Pointer-sourced held flags (cleared/rebuilt as pointers come and go) ──
  const pointerDown: Record<ButtonSlot, boolean> = { sprint: false, mid: false, action: false };

  // ── Keyboard ──
  const keys = new Set<string>();

  // ── Swipe (right-side drag) ──
  const swipe: SwipeState = {
    active: false,
    start: { x: 0, y: 0 },
    current: { x: 0, y: 0 },
    released: false,
    power: 0,
  };
  let swipePointerId: number | null = null;
  // Latched on the frame a swipe lifts so sample() can surface the release edge once.
  let swipeReleaseLatched = false;

  // ── Gamepad ──
  let gamepadProvidedInput = false;

  // ─────────────────────── Coordinate helper ───────────────────────
  function toCanvasXY(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function rebuildPointerDown(): void {
    pointerDown.sprint = false;
    pointerDown.mid = false;
    pointerDown.action = false;
    for (const p of pointers.values()) {
      if (p.role === 'button' && p.slot) pointerDown[p.slot] = true;
    }
  }

  // ─────────────────────── Pointer handlers ───────────────────────
  function onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    const { x, y } = toCanvasXY(e);

    // Buttons win over the hemisphere split so a visible button is ALWAYS tappable, even when
    // (on narrow phones) its drawn circle extends into the left/joystick half of the screen.
    const hit = hitButton(layout, x, y);
    if (hit) {
      pointers.set(e.pointerId, { x, y, startX: x, startY: y, role: 'button', slot: hit.slot });
      pointerDown[hit.slot] = true;
      return;
    }

    if (x < layout.splitX) {
      // Left hemisphere (and not on a button) → floating joystick (one at a time).
      if (joystickPointerId === null) {
        joystickPointerId = e.pointerId;
        pointers.set(e.pointerId, { x, y, startX: x, startY: y, role: 'joystick' });
      } else {
        // A second left touch is tracked but does nothing special.
        pointers.set(e.pointerId, { x, y, startX: x, startY: y, role: 'joystick' });
      }
      return;
    }

    // Otherwise it's a set-piece swipe drag (the most recent one wins).
    swipePointerId = e.pointerId;
    swipe.active = true;
    swipe.released = false;
    swipe.power = 0;
    swipe.start = { x, y };
    swipe.current = { x, y };
    pointers.set(e.pointerId, { x, y, startX: x, startY: y, role: 'swipe' });
  }

  function onPointerMove(e: PointerEvent): void {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const { x, y } = toCanvasXY(e);
    p.x = x;
    p.y = y;
    if (e.pointerId === swipePointerId && swipe.active) {
      swipe.current = { x, y };
    }
  }

  function endPointer(e: PointerEvent): void {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();

    if (p.role === 'joystick') {
      if (e.pointerId === joystickPointerId) {
        joystickPointerId = null;
        // If another tracked left-touch exists, promote it to the joystick.
        for (const [id, other] of pointers) {
          if (id !== e.pointerId && other.role === 'joystick') {
            joystickPointerId = id;
            break;
          }
        }
      }
    } else if (p.role === 'swipe' && e.pointerId === swipePointerId) {
      const vx = swipe.current.x - swipe.start.x;
      const vy = swipe.current.y - swipe.start.y;
      const len = Math.hypot(vx, vy);
      const ref = 0.35 * Math.min(cssW, cssH);
      swipe.power = ref > 0 ? clamp01(len / ref) : 0;
      swipe.released = true;
      swipe.active = false;
      swipeReleaseLatched = true;
      swipePointerId = null;
    }

    pointers.delete(e.pointerId);
    rebuildPointerDown();
  }

  // ─────────────────────── Keyboard handlers ───────────────────────
  function onKeyDown(e: KeyboardEvent): void {
    keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  }
  function onKeyUp(e: KeyboardEvent): void {
    keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  }

  function keyDown(...names: string[]): boolean {
    for (const n of names) if (keys.has(n)) return true;
    return false;
  }

  // ─────────────────────── Gamepad ───────────────────────
  function readGamepad(): Gamepad | null {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') return null;
    const pads = nav.getGamepads();
    if (!pads) return null;
    for (const pad of pads) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  // ─────────────────────── InputSystem surface ───────────────────────
  function attach(): void {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  function detach(): void {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', endPointer);
    canvas.removeEventListener('pointercancel', endPointer);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    pointers.clear();
    keys.clear();
    joystickPointerId = null;
    swipePointerId = null;
    swipe.active = false;
  }

  function resize(cssWidth: number, cssHeight: number): void {
    cssW = Math.max(1, cssWidth);
    cssH = Math.max(1, cssHeight);
    layout = computeHudLayout(cssW, cssH);
  }

  // ─────────────────────── Per-frame sampling ───────────────────────

  /**
   * Fuse pointer + keyboard + gamepad "down" state for a slot, then derive
   * pressed/held/released edges and accumulate hold time. On the release frame the total
   * accumulated hold is surfaced via `reportHold`; the following frame it resets to 0.
   */
  function updateSlot(slot: ButtonSlot, rawDown: boolean, dt: number): void {
    const s = slots[slot];
    const was = prevDown[slot];

    s.pressed = rawDown && !was;
    s.released = !rawDown && was;
    s.held = rawDown;

    if (rawDown) {
      if (s.pressed) s.holdTime = 0;
      s.holdTime += dt;
      s.reportHold = s.holdTime;
    } else if (s.released) {
      // Surface the total time it was held, this frame only.
      s.reportHold = s.holdTime;
      s.holdTime = 0;
    } else {
      s.reportHold = 0;
      s.holdTime = 0;
    }

    prevDown[slot] = rawDown;
  }

  function sample(world: GameWorld, dt: number): void {
    const pad = readGamepad();
    gamepadProvidedInput = false;

    // ─────────── MOVEMENT ───────────
    const input = world.input;
    let moveX = 0;
    let moveY = 0;
    let moveMag = 0;

    const joyP = joystickPointerId !== null ? pointers.get(joystickPointerId) : undefined;
    if (joyP) {
      // Floating joystick: origin = touch start, knob clamped to the visual radius.
      const origin: Vec2 = { x: joyP.startX, y: joyP.startY };
      const dx = joyP.x - origin.x;
      const dy = joyP.y - origin.y;
      const dlen = Math.hypot(dx, dy);
      const mag = Math.min(dlen / HUD.joystickRadius, 1);
      const clamped = clampVecLength({ x: dx, y: dy }, HUD.joystickRadius);

      if (mag < HUD.joystickDeadzone) {
        moveX = 0;
        moveY = 0;
        moveMag = 0;
      } else {
        const sdir = normalize({ x: dx, y: dy }); // screen space, y down
        const wdir = screenDirToWorld(sdir.x, sdir.y);
        moveX = wdir.x * mag;
        moveY = wdir.y * mag;
        moveMag = mag;
      }

      input.joystick.active = true;
      input.joystick.origin = origin;
      input.joystick.knob = { x: origin.x + clamped.x, y: origin.y + clamped.y };
      input.joystick.radius = HUD.joystickRadius;
    } else {
      // No joystick touch: fall back to keyboard, then gamepad.
      let sdx = 0;
      let sdy = 0;
      if (keyDown('w', 'ArrowUp')) sdy -= 1; // screen up
      if (keyDown('s', 'ArrowDown')) sdy += 1;
      if (keyDown('a', 'ArrowLeft')) sdx -= 1;
      if (keyDown('d', 'ArrowRight')) sdx += 1;

      if (sdx !== 0 || sdy !== 0) {
        const sdir = normalize({ x: sdx, y: sdy });
        const wdir = screenDirToWorld(sdir.x, sdir.y);
        moveX = wdir.x;
        moveY = wdir.y;
        moveMag = 1;
      } else if (pad) {
        const ax = pad.axes[0] ?? 0; // left stick X (screen right +)
        const ay = pad.axes[1] ?? 0; // left stick Y (screen down +)
        const alen = Math.hypot(ax, ay);
        const deadzone = HUD.joystickDeadzone;
        if (alen > deadzone) {
          const mag = Math.min(alen, 1);
          const sdir = normalize({ x: ax, y: ay });
          const wdir = screenDirToWorld(sdir.x, sdir.y);
          moveX = wdir.x * mag;
          moveY = wdir.y * mag;
          moveMag = mag;
          gamepadProvidedInput = true;
        }
      }
      input.joystick.active = false;
    }

    input.move = { x: moveX, y: moveY };
    input.moveMagnitude = moveMag;

    // ─────────── BUTTONS: fuse raw down per slot ───────────
    // Keyboard: Space = action, J/K = mid, Shift = sprint, L = action.
    const kbSprint = keyDown('Shift');
    const kbMid = keyDown('j', 'k');
    const kbAction = keyDown(' ', 'l');

    // Gamepad: A/button0 = action, B/button1 = sprint, X/button2 = mid; bumpers (4/5) = mid.
    let gpSprint = false;
    let gpMid = false;
    let gpAction = false;
    if (pad) {
      const b = pad.buttons;
      const pressed = (i: number) => !!b[i] && b[i].pressed;
      gpAction = pressed(0);
      gpSprint = pressed(1);
      gpMid = pressed(2) || pressed(4) || pressed(5);
      if (gpAction || gpSprint || gpMid) gamepadProvidedInput = true;
    }

    const rawDown: Record<ButtonSlot, boolean> = {
      sprint: pointerDown.sprint || kbSprint || gpSprint,
      mid: pointerDown.mid || kbMid || gpMid,
      action: pointerDown.action || kbAction || gpAction,
    };

    for (const slot of SLOTS) updateSlot(slot, rawDown[slot], dt);

    // ─────────── Map slots → semantic intents by control mode ───────────
    input.sprint = slots.sprint.held;

    switch (world.controlMode) {
      case ControlMode.OFFENSIVE: {
        input.pass = {
          pressed: slots.mid.pressed,
          held: slots.mid.held,
          released: slots.mid.released,
          holdTime: slots.mid.reportHold,
        };
        input.shoot = {
          pressed: slots.action.pressed,
          held: slots.action.held,
          released: slots.action.released,
          holdTime: slots.action.reportHold,
        };
        input.switchPlayer = false;
        input.slide = false;
        break;
      }
      case ControlMode.DEFENSIVE: {
        input.switchPlayer = slots.mid.pressed;
        input.slide = slots.action.pressed;
        input.pass = { pressed: false, held: false, released: false, holdTime: 0 };
        input.shoot = { pressed: false, held: false, released: false, holdTime: 0 };
        break;
      }
      default: {
        // Exhaustive over ControlMode; safe fallback keeps types satisfied.
        input.pass = { pressed: false, held: false, released: false, holdTime: 0 };
        input.shoot = { pressed: false, held: false, released: false, holdTime: 0 };
        input.switchPlayer = false;
        input.slide = false;
        break;
      }
    }

    // ─────────── SWIPE (set-piece gesture) ───────────
    const vec: Vec2 = { x: swipe.current.x - swipe.start.x, y: swipe.current.y - swipe.start.y };
    input.swipe = {
      active: swipe.active,
      start: { x: swipe.start.x, y: swipe.start.y },
      current: { x: swipe.current.x, y: swipe.current.y },
      vector: vec,
      released: swipeReleaseLatched,
      power: clamp01(swipe.power),
    };
    // The release edge is reported exactly one frame.
    if (swipeReleaseLatched) {
      swipeReleaseLatched = false;
      swipe.released = false;
    }

    // ─────────── Device flag ───────────
    input.gamepadActive = gamepadProvidedInput;

    // Touch left-stick magnitude is already clamped ≤ 1; defensively clamp the final move.
    if (input.moveMagnitude > 1) {
      input.moveMagnitude = clamp(input.moveMagnitude, 0, 1);
    }
  }

  return { attach, detach, sample, resize };
}
