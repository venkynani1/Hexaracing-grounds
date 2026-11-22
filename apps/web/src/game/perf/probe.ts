/**
 * Frame-level performance probe (measurement only). Collects what the acceptance test needs:
 * frame-interval distribution (median / 1%-low FPS / p95 frame time / max stall), JS CPU time per frame,
 * render-target (shadow) time, draw calls, triangles, texture memory estimate, compiled shader count + time to
 * first ready frame, long tasks (main-thread blocking ≥ 50 ms), JS heap (Chrome), downloaded bytes, and an FPS
 * timeline (thermal trend). Runs identically on a desktop and on the reference Android device.
 */
import { EngineInstrumentation, SceneInstrumentation, type Engine, type Scene } from '@babylonjs/core';

export interface ProbeReport {
  label: string;
  durationS: number;
  frames: number;
  medianFps: number;
  avgFps: number;
  low1Fps: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  /** frame gaps > 250 ms while the page stayed visible (real stalls — gate criterion) */
  stallsOver250ms: number;
  /** every gap > 250 ms: time into the run, length, overlapping long task (main-thread block), page hidden in between */
  stalls: { atS: number; ms: number; longTaskMs: number; hidden: boolean }[];
  /** page was hidden / frozen by the OS (screen off, app switch, notification) — those gaps are excluded from FPS stats */
  interruptions: number;
  interruptedMs: number;
  jsFrameMsAvg: number;
  jsFrameMsP95: number;
  renderTargetsMsAvg: number;
  activeMeshesEvalMsAvg: number;
  drawCallsAvg: number;
  trianglesK: number;
  textureMemMB: number;
  textures: number;
  effectsCompiled: number;
  firstReadyMs: number;
  longTasks: number;
  longTaskMaxMs: number;
  longTaskTotalMs: number;
  /** shared physics + traffic AI per rendered frame (ms) */
  simMsAvg: number;
  /** GPU frame time from EXT_disjoint_timer_query (null where the browser does not expose it) */
  gpuFrameMsAvg: number | null;
  activeMeshesAvg: number;
  particlesAvg: number;
  heapUsedMB: number | null;
  heapPeakMB: number | null;
  downloadMB: number;
  /** FPS per 10 s window — a sustained downward trend = thermal throttling */
  fpsTimeline: number[];
  quality: string;
  renderScale: number;
  viewport: string;
  gpu: string;
  userAgent: string;
}

const pct = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0);

export class PerfProbe {
  private readonly inst: SceneInstrumentation;
  private frames: number[] = [];
  private js: number[] = [];
  private rt: number[] = [];
  private am: number[] = [];
  private dc: number[] = [];
  private tris: number[] = [];
  private longTasks: number[] = [];
  private longTaskSpans: [number, number][] = [];
  private stallList: { from: number; to: number; hidden: boolean }[] = [];
  private hiddenSince = 0;
  private hiddenFlag = false;
  private interruptions = 0;
  private interruptedMs = 0;
  private simAcc = 0;
  private sims: number[] = [];
  private gpu: number[] = [];
  private act: number[] = [];
  private parts: number[] = [];
  private engInst: EngineInstrumentation | null = null;
  private heapPeak = 0;
  private start = 0;
  private last = 0;
  private running = false;
  private window: number[] = [];
  private windowStart = 0;
  private timeline: number[] = [];
  private po: PerformanceObserver | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly engine: Engine,
    private readonly firstReadyMs: () => number,
  ) {
    this.inst = new SceneInstrumentation(scene);
    this.inst.captureFrameTime = true;
    this.inst.captureRenderTargetsRenderTime = true;
    this.inst.captureActiveMeshesEvaluationTime = true;
    try {
      this.po = new PerformanceObserver((l) => {
        if (this.running)
          for (const e of l.getEntries()) {
            this.longTasks.push(e.duration);
            this.longTaskSpans.push([e.startTime, e.startTime + e.duration]);
          }
      });
      this.po.observe({ type: 'longtask', buffered: false });
    } catch {
      /* longtask unsupported (Safari) */
    }
    try {
      this.engInst = new EngineInstrumentation(engine);
      this.engInst.captureGPUFrameTime = true;
    } catch {
      this.engInst = null;
    }
    scene.onAfterRenderObservable.add(() => this.onFrame());
    // OS interruptions (screen off, app switch, freeze): rAF stops, so the next frame gap is not the game's fault
    const hide = () => {
      if (!this.running || this.hiddenFlag) return;
      this.hiddenFlag = true;
      this.hiddenSince = performance.now();
    };
    document.addEventListener('visibilitychange', () => (document.hidden ? hide() : undefined));
    document.addEventListener('freeze', hide);
    addEventListener('pagehide', hide);
  }

  /** time spent in simulation (physics + traffic) since the last rendered frame */
  sim(ms: number) {
    this.simAcc += ms;
  }

  begin() {
    this.frames = [];
    this.js = [];
    this.rt = [];
    this.am = [];
    this.dc = [];
    this.tris = [];
    this.longTasks = [];
    this.longTaskSpans = [];
    this.stallList = [];
    this.hiddenFlag = false;
    this.interruptions = 0;
    this.interruptedMs = 0;
    this.sims = [];
    this.gpu = [];
    this.act = [];
    this.parts = [];
    this.simAcc = 0;
    this.timeline = [];
    this.window = [];
    this.heapPeak = 0;
    this.start = this.last = this.windowStart = performance.now();
    this.running = true;
  }

  private onFrame() {
    if (!this.running) return;
    const now = performance.now();
    const dt = now - this.last;
    const prev = this.last;
    this.last = now;
    if (dt > 250) {
      const hidden = this.hiddenFlag;
      this.stallList.push({ from: prev, to: now, hidden }); // long-task overlap resolved in end(): entries arrive late
      if (hidden) {
        // the page was hidden/frozen by the OS: exclude this gap from the FPS statistics, report it separately
        this.hiddenFlag = false;
        this.interruptions++;
        this.interruptedMs += dt;
        this.windowStart += dt;
        return;
      }
    }
    this.hiddenFlag = false;
    this.frames.push(dt);
    this.window.push(dt);
    this.js.push(this.inst.frameTimeCounter.current);
    this.rt.push(this.inst.renderTargetsRenderTimeCounter.current);
    this.am.push(this.inst.activeMeshesEvaluationTimeCounter.current);
    this.dc.push(this.inst.drawCallsCounter.current);
    this.tris.push(this.scene.getActiveIndices() / 3);
    this.sims.push(this.simAcc);
    this.simAcc = 0;
    this.act.push(this.scene.getActiveMeshes().length);
    let np = 0;
    for (const ps of this.scene.particleSystems) np += ps.getActiveCount();
    this.parts.push(np);
    const g = this.engInst?.gpuFrameTimeCounter;
    if (g && g.current > 0) this.gpu.push(g.current / 1e6);
    if (now - this.windowStart >= 10_000) {
      const avg = this.window.reduce((a, b) => a + b, 0) / this.window.length;
      this.timeline.push(+(1000 / avg).toFixed(1));
      this.window = [];
      this.windowStart = now;
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) this.heapPeak = Math.max(this.heapPeak, mem.usedJSHeapSize);
  }

  textureMemoryMB() {
    let bytes = 0;
    const seen = new Set<number>();
    for (const t of this.scene.textures) {
      const s = t.getSize();
      const internal = t.getInternalTexture();
      if (!internal || !s.width || seen.has(internal.uniqueId)) continue;
      seen.add(internal.uniqueId);
      const faces = t.isCube ? 6 : 1;
      // GPU-compressed (KTX2 transcoded): format is a GL compressed enum — ETC1/ETC2-RGB/BC1 = 0.5 B/px, others 1 B/px;
      // float ≈ 8; else 4 — ×4/3 for mips
      const f = internal.format;
      const bpp = f >= 0x8000 ? ([0x83f0, 0x83f1, 0x9274, 0x8d64, 0x9276].includes(f) ? 0.5 : 1) : internal.type === 1 || internal.type === 2 ? 8 : 4;
      bytes += s.width * s.height * bpp * faces * (internal.generateMipMaps ? 4 / 3 : 1);
    }
    return bytes / 1048576;
  }

  end(label: string, extra: { quality: string; renderScale: number; gpu: string }): ProbeReport {
    this.running = false;
    const f = [...this.frames].sort((a, b) => a - b);
    const avgMs = this.frames.reduce((a, b) => a + b, 0) / Math.max(1, this.frames.length);
    const mean = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const dl = res.reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0);
    const jsSorted = [...this.js].sort((a, b) => a - b);
    return {
      label,
      durationS: +((performance.now() - this.start) / 1000).toFixed(1),
      frames: this.frames.length,
      medianFps: +(1000 / pct(f, 0.5)).toFixed(1),
      avgFps: +(1000 / avgMs).toFixed(1),
      low1Fps: +(1000 / pct(f, 0.99)).toFixed(1),
      p95FrameMs: +pct(f, 0.95).toFixed(1),
      p99FrameMs: +pct(f, 0.99).toFixed(1),
      maxFrameMs: +(f[f.length - 1] ?? 0).toFixed(1),
      stallsOver250ms: this.frames.filter((x) => x > 250).length,
      stalls: this.stallList.map(({ from, to, hidden }) => {
        let lt = 0;
        for (const [a, b] of this.longTaskSpans) lt += Math.max(0, Math.min(b, to) - Math.max(a, from));
        return { atS: +((from - this.start) / 1000).toFixed(1), ms: Math.round(to - from), longTaskMs: Math.round(lt), hidden };
      }),
      interruptions: this.interruptions,
      interruptedMs: Math.round(this.interruptedMs),
      jsFrameMsAvg: mean(this.js),
      jsFrameMsP95: +pct(jsSorted, 0.95).toFixed(2),
      renderTargetsMsAvg: mean(this.rt),
      activeMeshesEvalMsAvg: mean(this.am),
      drawCallsAvg: Math.round(mean(this.dc)),
      trianglesK: Math.round(mean(this.tris) / 1000),
      textureMemMB: +this.textureMemoryMB().toFixed(1),
      textures: new Set(this.scene.textures.map((t) => t.getInternalTexture()?.uniqueId).filter((x) => x != null)).size,
      effectsCompiled: Object.keys((this.engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects ?? {}).length,
      firstReadyMs: Math.round(this.firstReadyMs()),
      longTasks: this.longTasks.length,
      longTaskMaxMs: Math.round(Math.max(0, ...this.longTasks)),
      longTaskTotalMs: Math.round(this.longTasks.reduce((a, b) => a + b, 0)),
      simMsAvg: mean(this.sims),
      gpuFrameMsAvg: this.gpu.length > this.frames.length / 4 ? mean(this.gpu) : null,
      activeMeshesAvg: Math.round(mean(this.act)),
      particlesAvg: Math.round(mean(this.parts)),
      heapUsedMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      heapPeakMB: mem ? +(this.heapPeak / 1048576).toFixed(1) : null,
      downloadMB: +(dl / 1048576).toFixed(2),
      fpsTimeline: this.timeline,
      quality: extra.quality,
      renderScale: extra.renderScale,
      viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      gpu: extra.gpu,
      userAgent: navigator.userAgent,
    };
  }
}
