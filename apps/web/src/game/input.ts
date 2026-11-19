import { NEUTRAL_INPUT, type VehicleInput } from '@redline/shared';

export type Control = 'left' | 'right' | 'throttle' | 'brake' | 'nitro' | 'handbrake';

/**
 * Digital controls (keyboard + on-screen touch buttons) → analog input. Steering ramps so tap-steering
 * feels smooth; the ramped value is what gets sent, so server and prediction see identical input.
 */
export class InputState {
  private held = new Set<Control>();
  private steer = 0;
  private readonly keyMap: Record<string, Control> = {
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    ArrowUp: 'throttle',
    KeyW: 'throttle',
    ArrowDown: 'brake',
    KeyS: 'brake',
    ShiftLeft: 'nitro',
    ShiftRight: 'nitro',
    KeyN: 'nitro',
    Space: 'handbrake',
  };

  private onDown = (e: KeyboardEvent) => {
    const c = this.keyMap[e.code];
    if (c) {
      this.held.add(c);
      e.preventDefault();
    }
  };
  private onUp = (e: KeyboardEvent) => {
    const c = this.keyMap[e.code];
    if (c) this.held.delete(c);
  };
  private onBlur = () => this.held.clear();

  attach() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach() {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
  }

  set(c: Control, on: boolean) {
    if (on) this.held.add(c);
    else this.held.delete(c);
  }

  /** Sample one 50 ms step. */
  sample(dt: number): VehicleInput {
    const target = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    const rate = target === 0 ? 6 : Math.sign(target) !== Math.sign(this.steer) && this.steer !== 0 ? 8 : 3.5;
    const delta = target - this.steer;
    this.steer += Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
    this.steer = Math.round(this.steer * 1000) / 1000;
    return {
      ...NEUTRAL_INPUT,
      steer: this.steer,
      throttle: this.held.has('throttle') ? 1 : 0,
      brake: this.held.has('brake') ? 1 : 0,
      nitro: this.held.has('nitro'),
      handbrake: this.held.has('handbrake'),
    };
  }
}
