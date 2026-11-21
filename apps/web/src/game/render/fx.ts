/** Particle effects (visual only): rain, tyre smoke, nitro flame, finale fireworks/confetti. */
import { Color4, DynamicTexture, ParticleSystem, Vector3, type AbstractMesh, type Scene, type TransformNode } from '@babylonjs/core';

function radial(scene: Scene, name: string, stops: [number, string][]) {
  const t = new DynamicTexture(name, { width: 64, height: 64 }, scene, false);
  const c = t.getContext() as unknown as CanvasRenderingContext2D;
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [o, col] of stops) g.addColorStop(o, col);
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  t.update();
  t.hasAlpha = true;
  return t;
}

export class Fx {
  readonly rain: ParticleSystem;
  private readonly smoke: ParticleSystem[] = [];
  private nitro: ParticleSystem | null = null;
  private readonly spark;
  private fireworks: ParticleSystem[] = [];

  constructor(
    private readonly scene: Scene,
    budget: number,
  ) {
    this.spark = radial(scene, 'spark', [
      [0, 'rgba(255,255,255,1)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    // Rain: long thin streaks, falling slightly slanted.
    const drop = new DynamicTexture('raindrop', { width: 8, height: 64 }, scene, false);
    const ctx = drop.getContext() as unknown as CanvasRenderingContext2D;
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, 'rgba(210,225,255,0)');
    g.addColorStop(1, 'rgba(210,225,255,0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(3, 0, 2, 64);
    drop.update();
    drop.hasAlpha = true;
    const ps = new ParticleSystem('rain', Math.round(2600 * budget), scene);
    ps.particleTexture = drop;
    ps.minEmitBox = new Vector3(-35, 18, -35);
    ps.maxEmitBox = new Vector3(35, 24, 35);
    ps.direction1 = new Vector3(-1.5, -30, 0.5);
    ps.direction2 = new Vector3(-0.5, -36, 1.5);
    ps.minSize = 0.05;
    ps.maxSize = 0.09;
    ps.minScaleY = 8;
    ps.maxScaleY = 12;
    ps.minLifeTime = 0.6;
    ps.maxLifeTime = 0.8;
    ps.emitRate = Math.round(2600 * budget);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.color1 = new Color4(0.8, 0.85, 0.95, 0.55);
    ps.color2 = new Color4(0.8, 0.85, 0.95, 0.35);
    ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    ps.emitter = Vector3.Zero();
    this.rain = ps;
  }

  /** Tyre smoke at the rear wheels + nitro flame at the exhaust (own car only). */
  attachCar(rearWheels: TransformNode[], exhaust: TransformNode) {
    const smokeTex = radial(this.scene, 'smoke', [
      [0, 'rgba(235,235,235,0.55)'],
      [0.6, 'rgba(210,210,210,0.25)'],
      [1, 'rgba(200,200,200,0)'],
    ]);
    for (const w of rearWheels) {
      const s = new ParticleSystem('tyre-smoke', 220, this.scene);
      s.particleTexture = smokeTex;
      s.emitter = w as unknown as AbstractMesh;
      s.minEmitBox = new Vector3(-0.15, -0.25, -0.2);
      s.maxEmitBox = new Vector3(0.15, -0.2, 0.2);
      s.direction1 = new Vector3(-0.6, 0.6, -1.2);
      s.direction2 = new Vector3(0.6, 1.2, -0.4);
      s.minSize = 0.6;
      s.maxSize = 1.4;
      s.minLifeTime = 0.6;
      s.maxLifeTime = 1.3;
      s.minEmitPower = 0.5;
      s.maxEmitPower = 1.6;
      s.emitRate = 0;
      s.addSizeGradient(0, 0.5);
      s.addSizeGradient(1, 2.6);
      s.color1 = new Color4(0.9, 0.9, 0.9, 0.5);
      s.color2 = new Color4(0.8, 0.8, 0.8, 0.35);
      s.colorDead = new Color4(0.8, 0.8, 0.8, 0);
      s.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      s.start();
      this.smoke.push(s);
    }
    const n = new ParticleSystem('nitro', 300, this.scene);
    n.particleTexture = this.spark;
    n.emitter = exhaust as unknown as AbstractMesh;
    n.minEmitBox = new Vector3(-0.35, 0, 0);
    n.maxEmitBox = new Vector3(0.35, 0, 0);
    n.direction1 = new Vector3(-0.2, 0.05, -6);
    n.direction2 = new Vector3(0.2, 0.25, -9);
    n.minSize = 0.18;
    n.maxSize = 0.45;
    n.minLifeTime = 0.06;
    n.maxLifeTime = 0.14;
    n.emitRate = 0;
    n.color1 = new Color4(0.35, 0.6, 1, 1);
    n.color2 = new Color4(1, 0.55, 0.15, 1);
    n.colorDead = new Color4(1, 0.3, 0.1, 0);
    n.blendMode = ParticleSystem.BLENDMODE_ADD;
    n.isLocal = false;
    n.start();
    this.nitro = n;
  }

  /** Wet road: tyre spray instead of smoke (lightweight particles behind each rear wheel). */
  wet = false;
  updateCar(slip: number, speed: number, nitro: boolean) {
    const smokeRate = slip > 2.2 && speed > 3 ? Math.min(160, (slip - 2.2) * 45) : 0;
    const sprayRate = this.wet && speed > 6 ? Math.min(140, (speed - 6) * 8) : 0;
    for (const s of this.smoke) {
      s.emitRate = Math.max(smokeRate, sprayRate);
      if (this.wet) {
        s.color1 = new Color4(0.82, 0.86, 0.9, 0.32);
        s.color2 = new Color4(0.75, 0.8, 0.85, 0.2);
        s.minLifeTime = 0.25;
        s.maxLifeTime = 0.55;
      } else {
        s.color1 = new Color4(0.9, 0.9, 0.9, 0.5);
        s.color2 = new Color4(0.8, 0.8, 0.8, 0.35);
        s.minLifeTime = 0.6;
        s.maxLifeTime = 1.3;
      }
    }
    if (this.nitro) this.nitro.emitRate = nitro && speed > 1 ? 900 : 0;
  }

  setRain(on: boolean, at: Vector3) {
    this.rain.emitter = at;
    if (on && !this.rain.isStarted()) this.rain.start();
    if (!on && this.rain.isStarted()) this.rain.stop();
  }

  /* --------------------------------------------------- finale --------------------------------------------------- */

  startCelebration(gate: Vector3) {
    if (this.fireworks.length) return;
    const colors: [number, number, number][] = [
      [1, 0.2, 0.3],
      [1, 0.8, 0.2],
      [0.3, 0.8, 1],
      [0.4, 1, 0.5],
    ];
    colors.forEach((c, i) => {
      const ps = new ParticleSystem(`fw-${i}`, 600, this.scene);
      ps.particleTexture = this.spark;
      ps.emitter = gate.add(new Vector3((i - 1.5) * 18, 40 + i * 4, 10));
      ps.createSphereEmitter(1);
      ps.color1 = new Color4(c[0], c[1], c[2], 1);
      ps.color2 = new Color4(1, 1, 1, 1);
      ps.colorDead = new Color4(c[0], c[1], c[2], 0);
      ps.minSize = 0.6;
      ps.maxSize = 1.4;
      ps.minLifeTime = 0.8;
      ps.maxLifeTime = 1.6;
      ps.minEmitPower = 12;
      ps.maxEmitPower = 22;
      ps.gravity = new Vector3(0, -9, 0);
      ps.manualEmitCount = 0;
      ps.blendMode = ParticleSystem.BLENDMODE_ADD;
      ps.start();
      this.fireworks.push(ps);
    });
    const conf = new ParticleSystem('confetti', 1500, this.scene);
    conf.particleTexture = this.spark;
    conf.emitter = gate.add(new Vector3(0, 30, 0));
    conf.minEmitBox = new Vector3(-50, 0, -50);
    conf.maxEmitBox = new Vector3(50, 0, 50);
    conf.color1 = new Color4(1, 0.3, 0.4, 1);
    conf.color2 = new Color4(0.3, 0.8, 1, 1);
    conf.minSize = 0.3;
    conf.maxSize = 0.6;
    conf.minLifeTime = 4;
    conf.maxLifeTime = 6;
    conf.emitRate = 250;
    conf.gravity = new Vector3(0, -2, 0);
    conf.direction1 = new Vector3(-1, -1, -1);
    conf.direction2 = new Vector3(1, -1, 1);
    conf.start();
    this.fireworks.push(conf);
  }

  tickCelebration(t: number) {
    this.fireworks.forEach((ps, i) => {
      if (ps.name === 'confetti') return;
      if (Math.floor(t * 0.8 + i * 0.37) !== Math.floor((t - 0.05) * 0.8 + i * 0.37)) ps.manualEmitCount = 300;
    });
  }
}
