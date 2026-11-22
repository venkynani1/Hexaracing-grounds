/**
 * Roadside place-name boards and Hexaware direction signs (original artwork, text only — real place names from
 * OpenStreetMap, ODbL). Streamed: only the few signs within ~600 m of the camera exist at any time.
 */
import { Color3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, TransformNode, type Scene } from '@babylonjs/core';
import type { RouteSign } from '@redline/shared';

const SHOW_R = 600;
const HIDE_R = 800;

interface Live {
  root: TransformNode;
  tex: DynamicTexture;
  mat: StandardMaterial;
}

export class RouteSigns {
  private readonly signs: RouteSign[];
  private readonly live = new Map<number, Live>();
  private readonly postMat: StandardMaterial;
  private readonly backMat: StandardMaterial;
  private lastCheck = 0;

  constructor(
    private readonly scene: Scene,
    all: readonly RouteSign[],
  ) {
    // overlapping courses share roads: keep one board per title within 80 m
    const kept: RouteSign[] = [];
    for (const s of all) if (!kept.some((k) => k.title === s.title && Math.hypot(k.x - s.x, k.z - s.z) < 80)) kept.push(s);
    this.signs = kept;
    this.postMat = new StandardMaterial('rs-post', scene);
    this.postMat.diffuseColor = new Color3(0.55, 0.56, 0.58);
    this.postMat.specularColor = new Color3(0.2, 0.2, 0.2);
    this.backMat = new StandardMaterial('rs-back', scene);
    this.backMat.diffuseColor = new Color3(0.18, 0.19, 0.2);
    this.backMat.specularColor = Color3.Black();
  }

  get count() {
    return this.signs.length;
  }
  get liveCount() {
    return this.live.size;
  }

  /** Call every frame with the camera/car position; does real work at most every 400 ms. */
  update(x: number, z: number, now = performance.now()) {
    if (now - this.lastCheck < 400) return;
    this.lastCheck = now;
    this.signs.forEach((s, i) => {
      const d = Math.hypot(s.x - x, s.z - z);
      const l = this.live.get(i);
      if (!l && d < SHOW_R) this.live.set(i, this.build(s, i));
      else if (l && d > HIDE_R) {
        l.root.dispose(false, true);
        l.tex.dispose();
        l.mat.dispose();
        this.live.delete(i);
      }
    });
  }

  private build(s: RouteSign, i: number): Live {
    const scene = this.scene;
    const place = s.kind === 'place';
    const W = place ? 5.6 : 7.2;
    const H = place ? 1.8 : 2.6;
    const lift = place ? 2.4 : 2.8;
    const root = new TransformNode(`rs-${i}`, scene);
    root.position.set(s.x, 0, s.z);
    // board's local +Z = travel direction → its front face looks back at approaching drivers; turned slightly toward
    // the carriageway (to the driver's right, the sign is on the left verge)
    root.rotation.y = s.heading - 0.28;

    const tex = new DynamicTexture(`rs-tex-${i}`, { width: 1024, height: Math.round((1024 * H) / W) }, scene, true);
    const c = tex.getContext() as unknown as CanvasRenderingContext2D;
    const tw = tex.getSize().width;
    const th = tex.getSize().height;
    c.fillStyle = place ? '#0b4a9c' : '#0b6b3a';
    c.fillRect(0, 0, tw, th);
    c.strokeStyle = '#ffffff';
    c.lineWidth = 12;
    c.strokeRect(18, 18, tw - 36, th - 36);
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const fit = (text: string, weight: string, max: number, y: number) => {
      let size = max;
      do c.font = `${weight} ${size}px system-ui, "Segoe UI", Roboto, sans-serif`;
      while (c.measureText(text).width > tw - 96 && --size > 14);
      c.fillText(text, tw / 2, y);
    };
    if (place) {
      fit(s.title, '700', 150, th * 0.42);
      if (s.sub) fit(s.sub, '500', 58, th * 0.8);
    } else {
      // "Hexaware · Siruseri  12 km" → destination line, big distance line, next area
      const [dest, dist] = s.title.split(/\s{2,}/);
      fit(`↑  ${dest ?? s.title}`, '700', 96, th * 0.22);
      if (dist) fit(dist, '800', 130, th * 0.52);
      if (s.sub) fit(s.sub, '500', 72, th * 0.82);
    }
    tex.update();
    tex.hasAlpha = false;
    const mat = new StandardMaterial(`rs-mat-${i}`, scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(0.45, 0.45, 0.45); // retro-reflective look; readable in the dusk/rain presets
    mat.specularColor = Color3.Black();

    const face = MeshBuilder.CreatePlane(`rs-face-${i}`, { width: W, height: H }, scene);
    face.parent = root;
    face.position.set(0, lift + H / 2, -0.03);
    face.material = mat;
    const back = MeshBuilder.CreateBox(`rs-back-${i}`, { width: W + 0.1, height: H + 0.1, depth: 0.05 }, scene);
    back.parent = root;
    back.position.set(0, lift + H / 2, 0.01);
    back.material = this.backMat;
    for (const px of [-W / 2 + 0.4, W / 2 - 0.4]) {
      const post = MeshBuilder.CreateCylinder(`rs-post-${i}`, { height: lift + H, diameter: 0.12, tessellation: 6 }, scene);
      post.parent = root;
      post.position.set(px, (lift + H) / 2, 0.08);
      post.material = this.postMat;
    }
    for (const m of root.getChildMeshes()) {
      m.isPickable = false;
      (m as Mesh).freezeWorldMatrix?.();
    }
    return { root, tex, mat };
  }

  dispose() {
    for (const l of this.live.values()) {
      l.root.dispose(false, true);
      l.tex.dispose();
      l.mat.dispose();
    }
    this.live.clear();
    this.postMat.dispose();
    this.backMat.dispose();
  }
}
