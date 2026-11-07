import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

/* ================= domain model ================= */
interface Vec2 { x: number; y: number; }
interface LightOffset { dx: number; dy: number; }
interface Camera { x: number; y: number; zoom: number; }

interface Token {
  id: string; kind: string; assetId: string | null;
  x: number; y: number; r: number;
  facing: number; facingTarget: number;
  lightFacing: number; lightFacingTarget: number; followToken: boolean;
  cone: number; light: boolean; lightOffset: LightOffset;
  locked: boolean; flip: boolean; flipScale: number;
  layer: "back" | "normal" | "front";
  sx: number; sy: number;
}
interface Wall { a: Vec2; b: Vec2; }
interface LightPoint {
  id: string; x: number; y: number; on: boolean; color: string;
  intensity: number; radius: number; sx: number; sy: number;
}
interface MapObject {
  id: string; assetId: string; x: number; y: number; w: number; h: number;
  rotation: number; rotationTarget: number; locked: boolean;
  layer: "back" | "normal" | "front";
}
interface AssetFolder { id: string; color: string; }
interface TokenAsset { id: string; name: string; folderId: string; url: string; }
interface MapAsset { id: string; name: string; folderId: string; url: string; }
interface Track { id: string; name: string; url: string; cover: string | null; }
interface Campaign { id: string; name: string; }
interface WallHandle { wall: Wall; idx: number; end: "a" | "b"; }
/** What gets fed into the renderer per frame for each light-emitting thing (token or torch). */
interface LightSource {
  x: number; y: number; facing: number; cone: number;
  color: string; intensity: number; radius: number; flicker: number;
}

interface AppState {
  openTab: string | null; railOpen: boolean; tool: string;
  darkness: number; lightColor: string; absoluteDarkness: boolean; snap: boolean;
  camera: Camera;
  tokens: Token[]; walls: Wall[]; lights: LightPoint[]; mapObjects: MapObject[];
  wallDraft: Vec2 | null; wallDraftCursor: Vec2 | null;
  selectedToken: string | null; selectedWall: number | null; selectedMap: string | null;
  draggingWallHandle: WallHandle | null; rotatingToken: Token | null; repositioning: string | null;
  maps: MapAsset[];
  tokenFolders: AssetFolder[]; currentFolder: string;
  mapFolders: AssetFolder[]; currentMapFolder: string;
  tokenAssets: TokenAsset[]; assetImages: Record<string, HTMLImageElement>;
  tracks: Track[]; trackIndex: number; audioEl: HTMLAudioElement; audioAltEl: HTMLAudioElement;
  campaigns: Campaign[]; currentCampaignId: string | null; tokensSub: string;
}

const imageLoads: Record<string, Promise<HTMLImageElement | null> | undefined> = {};

const ACCENT = "#8777a1";
const PALETTE = ["#ffb3b3","#ffd9a6","#fff3a6","#c6f2c6","#b3dcff","#c9b3ff","#f3b3e0","#d6d6d6"];
const ROT_LERP = 0.16;
const TOKEN_MIN_R = 5, TOKEN_MAX_R = 300;
const RENDER_SCALE = Math.min(devicePixelRatio, 1.5);
const uid = (): string => Math.random().toString(36).slice(2, 10);
const TOKEN_LAYERS: Token["layer"][] = ["back", "normal", "front"];

/* ================= state ================= */
const state: AppState = {
  openTab: null, railOpen: true, tool: "select",
  darkness: 78, lightColor: "#ffd98a", absoluteDarkness: true, snap: false,
  camera: { x: 0, y: 0, zoom: 1 },
  tokens: [], walls: [], lights: [], mapObjects: [],
  wallDraft: null, wallDraftCursor: null,
  selectedToken: null, selectedWall: null, selectedMap: null,
  draggingWallHandle: null, rotatingToken: null, repositioning: null,
  maps: [],
  tokenFolders: [{ id: "root", color: PALETTE[0] }], currentFolder: "root",
  mapFolders: [{ id: "root", color: PALETTE[0] }], currentMapFolder: "root",
  tokenAssets: [], assetImages: {},
  tracks: [], trackIndex: -1, audioEl: new Audio(), audioAltEl: new Audio(),
  campaigns: [], currentCampaignId: null, tokensSub: "tokens",
};

/* ================= undo ================= */
let undoStack: string[] = [];
let sceneDirty = false;
let sceneRevision = 0;
let saveTimer: number | null = null;
function markSceneDirty(): void {
  sceneDirty = true;
  sceneRevision += 1;
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void saveCurrentScene(); }, 1200);
}
function snapshotScene(): string {
  return JSON.stringify({
    tokens: state.tokens.map(t => ({ ...t })),
    walls: state.walls.map(w => ({ a: { ...w.a }, b: { ...w.b } })),
    lights: state.lights.map(l => ({ ...l })),
    mapObjects: state.mapObjects.map(m => ({ ...m })),
  });
}
function pushUndo(): void {
  undoStack.push(snapshotScene());
  if (undoStack.length > 3) undoStack.shift();
  markSceneDirty();
}
function doUndo(): void {
  const raw = undoStack.pop();
  if (!raw) return;
  const s = JSON.parse(raw);
  state.tokens = s.tokens; state.walls = s.walls; state.lights = s.lights; state.mapObjects = s.mapObjects || [];
  state.tokens.forEach(token => { token.layer ??= "normal"; });
  state.mapObjects.forEach(map => { map.layer ??= "back"; });
  state.selectedToken = null; state.selectedWall = null; state.selectedMap = null;
  closeCtxMenu();
  if (state.openTab) renderPanel();
  markSceneDirty();
}

/* ================= canvas + fog layer ================= */
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const fogCanvas = document.createElement("canvas");
const fogCtx = fogCanvas.getContext("2d")!;
// Cached "background/maps/walls" layer - see rebuildStaticLayer() below.
// Declared here (ahead of resize(), which references lastStaticSig) rather
// than near where it's used, specifically to avoid a temporal-dead-zone
// crash: resize() runs immediately at module load, before any `let`/`const`
// further down the file has been evaluated.
const staticCanvas = document.createElement("canvas");
const staticCtx = staticCanvas.getContext("2d")!;
const frontCanvas = document.createElement("canvas");
const frontCtx = frontCanvas.getContext("2d")!;
let lastStaticSig: number | null = null;
let frameRequested = false;
let ambientLightTimer: number | null = null;
function requestRender(): void {
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(render);
  }
}
function requestAmbientLightRender(): void {
  if (ambientLightTimer != null) return;
  ambientLightTimer = window.setTimeout(() => {
    ambientLightTimer = null;
    requestRender();
  }, 33);
}
function invalidateStaticLayer(): void { lastStaticSig = null; }
function resize(): void {
  canvas.width = innerWidth * RENDER_SCALE; canvas.height = innerHeight * RENDER_SCALE;
  canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px";
  fogCanvas.width = canvas.width; fogCanvas.height = canvas.height;
  staticCanvas.width = canvas.width; staticCanvas.height = canvas.height;
  frontCanvas.width = canvas.width; frontCanvas.height = canvas.height;
  invalidateStaticLayer(); // dimensions aren't part of the signature - force a rebuild next frame
  requestRender();
}
resize();
addEventListener("resize", resize);

function addToken(kind: string, x: number, y: number, assetId: string | null = null): Token {
  const t: Token = {
    id: uid(), kind, assetId, x, y, r: 26,
    facing: -Math.PI / 2, facingTarget: -Math.PI / 2,
    lightFacing: -Math.PI / 2, lightFacingTarget: -Math.PI / 2, followToken: true,
    cone: 40, light: true, lightOffset: { dx: 0, dy: 0 },
    locked: false, flip: false, flipScale: 1, sx: 0, sy: 0,
    layer: "normal",
  };
  state.tokens.push(t);
  markSceneDirty();
  return t;
}
addToken("circle", -60, 40);
const seedToken = addToken("tri", 40, -20);
state.selectedToken = seedToken.id;

function loadImage(id: string, url: string): Promise<HTMLImageElement | null> {
  const cached = state.assetImages[id];
  if (cached) return Promise.resolve(cached);
  if (imageLoads[id]) return imageLoads[id]!;
  imageLoads[id] = new Promise(resolve => {
    const image = new Image();
    image.onload = () => { state.assetImages[id] = image; delete imageLoads[id]; invalidateStaticLayer(); requestRender(); resolve(image); };
    image.onerror = () => { delete imageLoads[id]; resolve(null); };
    image.src = url;
  });
  return imageLoads[id]!;
}
function ensureTokenImage(assetId: string): Promise<HTMLImageElement | null> {
  const asset = state.tokenAssets.find(item => item.id === assetId);
  return asset ? loadImage(assetId, asset.url) : Promise.resolve(null);
}
function ensureMapImage(assetId: string): Promise<HTMLImageElement | null> {
  const asset = state.maps.find(item => item.id === assetId);
  return asset ? loadImage("map:" + assetId, asset.url) : Promise.resolve(null);
}
async function addMapObject(assetId: string): Promise<MapObject | undefined> {
  const image = await ensureMapImage(assetId);
  if (!image) return;
  const maxDim = 280;
  const scale = Math.min(maxDim / image.width, maxDim / image.height, 1);
  const m: MapObject = {
    id: uid(), assetId, x: 0, y: 0,
    w: image.width * scale, h: image.height * scale,
    rotation: 0, rotationTarget: 0, locked: false,
    layer: "back",
  };
  state.mapObjects.push(m);
  state.selectedMap = m.id;
  markSceneDirty();
  return m;
}
function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

/* ================= geometry ================= */
function toScreen(x: number, y: number, cw: number, ch: number): Vec2 {
  return { x: cw / 2 + (x - state.camera.x) * state.camera.zoom, y: ch / 2 + (y - state.camera.y) * state.camera.zoom };
}
function toWorld(sx: number, sy: number, cw: number, ch: number): Vec2 {
  return { x: state.camera.x + (sx - cw / 2) / state.camera.zoom, y: state.camera.y + (sy - ch / 2) / state.camera.zoom };
}
// Wall-vs-light raycasting itself now lives in src-tauri/src/lighting.rs
// (see refreshLightPolys below) - nothing left to do with it here.

/* ================= lighting (two-pass: reveal fog, then tint) ================= */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Identifies the *world-space* inputs to raycasting: which lights are on
 * and where/how they point, plus every wall. Camera x/y (panning) is
 * deliberately excluded - panning moves nothing in world space, only the
 * screen projection, so it must not trigger a Rust re-raycast. Zoom stays
 * in, since it changes each light's world-space reach (radius/zoom).
 * A numeric rolling hash instead of string concatenation - this runs
 * unconditionally every single frame just to check "did anything change",
 * so it should cost as close to nothing as possible when the answer is no. */
function worldSignature(sampleCount: number): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => { h = (Math.imul(h ^ (v * 1000 | 0), 16777619)) | 0; };
  mix(state.camera.zoom);
  mix(sampleCount);
  for (const t of state.tokens) if (t.light) { mix(t.x); mix(t.y); mix(t.lightFacing); mix(t.cone); mix(t.lightOffset.dx); mix(t.lightOffset.dy); }
  for (const l of state.lights) if (l.on) { mix(l.x); mix(l.y); mix(l.radius); }
  for (const w of state.walls) { mix(w.a.x); mix(w.a.y); mix(w.b.x); mix(w.b.y); }
  return h;
}
function clipToPoly(c: CanvasRenderingContext2D, poly: Vec2[], src: LightSource, originS: Vec2, cw: number, ch: number, baseRadius: number): boolean {
  if (poly.length < 3) return false;
  c.beginPath();
  poly.forEach((p, i) => { const s = toScreen(p.x, p.y, cw, ch); if (i === 0) c.moveTo(s.x, s.y); else c.lineTo(s.x, s.y); });
  c.closePath(); c.clip();
  if (src.cone < 359.5) {
    const coneRad = Math.PI * 2 * (src.cone / 360);
    c.beginPath(); c.moveTo(originS.x, originS.y);
    c.arc(originS.x, originS.y, baseRadius * 2, src.facing - coneRad / 2, src.facing + coneRad / 2);
    c.closePath(); c.clip();
  }
  return true;
}
function revealFog(src: LightSource, poly: Vec2[], cw: number, ch: number): void {
  const baseRadius = 360 * ((src.radius ?? 100) / 100);
  const originS = toScreen(src.x, src.y, cw, ch);
  fogCtx.save();
  if (!clipToPoly(fogCtx, poly, src, originS, cw, ch, baseRadius)) { fogCtx.restore(); return; }
  const inten = (src.intensity ?? 100) / 100;
  const grad = fogCtx.createRadialGradient(originS.x, originS.y, 0, originS.x, originS.y, baseRadius);
  grad.addColorStop(0, `rgba(255,255,255,${Math.min(1, 0.97 * inten)})`);
  grad.addColorStop(0.3, `rgba(255,255,255,${Math.min(1, 0.8 * inten)})`);
  grad.addColorStop(0.65, `rgba(255,255,255,${Math.min(1, 0.4 * inten)})`);
  grad.addColorStop(1, "rgba(255,255,255,0)");
  fogCtx.globalCompositeOperation = "destination-out";
  fogCtx.filter = "blur(2px)";
  fogCtx.fillStyle = grad;
  fogCtx.fillRect(originS.x - baseRadius, originS.y - baseRadius, baseRadius * 2, baseRadius * 2);
  fogCtx.filter = "none";
  fogCtx.restore();
}
function fillTintGradient(c: CanvasRenderingContext2D, src: LightSource, origin: Vec2, radius: number, strength: number): void {
  const [r, g, b] = hexToRgb(src.color || state.lightColor);
  const intensity = ((src.intensity ?? 100) / 100) * (src.flicker || 1) * strength;
  const gradient = c.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, radius);
  gradient.addColorStop(0, `rgba(${r},${g},${b},${Math.min(1, 0.7 * intensity)})`);
  gradient.addColorStop(0.14, `rgba(${r},${g},${b},${Math.min(1, 0.5 * intensity)})`);
  gradient.addColorStop(0.48, `rgba(${r},${g},${b},${Math.min(1, 0.22 * intensity)})`);
  gradient.addColorStop(0.78, `rgba(${r},${g},${b},${Math.min(1, 0.06 * intensity)})`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
  c.fillStyle = gradient;
  c.fillRect(origin.x - radius, origin.y - radius, radius * 2, radius * 2);
}
function tintLight(src: LightSource, poly: Vec2[], cw: number, ch: number): void {
  const baseRadius = 360 * ((src.radius ?? 100) / 100);
  const originS = toScreen(src.x, src.y, cw, ch);
  if (src.cone < 359.5) {
    ctx.save();
    const penumbra = { ...src, cone: Math.min(360, src.cone + 14) };
    if (clipToPoly(ctx, poly, penumbra, originS, cw, ch, baseRadius)) {
      ctx.globalCompositeOperation = "lighter";
      fillTintGradient(ctx, penumbra, originS, baseRadius, 0.16);
    }
    ctx.restore();
  }
  ctx.save();
  if (!clipToPoly(ctx, poly, src, originS, cw, ch, baseRadius)) { ctx.restore(); return; }
  ctx.globalCompositeOperation = "lighter";
  fillTintGradient(ctx, src, originS, baseRadius, 1);
  ctx.restore();
}

/* ================= glyphs ================= */
function drawTokenGlyph(t: Token): void {
  const img = t.assetId ? state.assetImages[t.assetId] ?? null : null;
  if (!img && t.assetId) void ensureTokenImage(t.assetId);
  ctx.save(); ctx.translate(t.sx, t.sy);
  const s = t.r * state.camera.zoom * 0.4;
  ctx.rotate(t.facing + Math.PI / 2);
  ctx.scale(t.flipScale ?? 1, 1);
  if (img) {
    const d = t.r * state.camera.zoom * 2;
    const scale = Math.min(d / img.width, d / img.height);
    ctx.drawImage(img, -img.width * scale / 2, -img.height * scale / 2, img.width * scale, img.height * scale);
  } else {
    ctx.fillStyle = "#e4e4e6";
    if (t.kind === "tri") { ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.86, s * 0.7); ctx.lineTo(-s * 0.86, s * 0.7); ctx.closePath(); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  if (t.id === state.selectedToken) {
    const fx = t.sx + Math.cos(t.facing) * (Math.max(t.r * state.camera.zoom, 10) + 9);
    const fy = t.sy + Math.sin(t.facing) * (Math.max(t.r * state.camera.zoom, 10) + 9);
    ctx.beginPath(); ctx.arc(fx, fy, 2.6, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill();
    if (t.light) {
      const lx = t.sx + t.lightOffset.dx * state.camera.zoom, ly = t.sy + t.lightOffset.dy * state.camera.zoom;
      const lfx = lx + Math.cos(t.lightFacing) * 16, lfy = ly + Math.sin(t.lightFacing) * 16;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lfx, lfy); ctx.strokeStyle = "#ffd98a"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.strokeStyle = "#ffd98a"; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
}
function drawTorchGlyph(l: LightPoint): void {
  ctx.save(); ctx.translate(l.sx, l.sy);
  ctx.fillStyle = l.color || state.lightColor;
  ctx.beginPath(); ctx.arc(0, 0, 7 * state.camera.zoom, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}
function drawMapObject(c: CanvasRenderingContext2D, m: MapObject, cw: number, ch: number): void {
  const img = state.assetImages["map:" + m.assetId];
  if (!img) { void ensureMapImage(m.assetId); return; }
  const p = toScreen(m.x, m.y, cw, ch);
  c.save(); c.translate(p.x, p.y); c.rotate(m.rotation);
  c.drawImage(img, -m.w * state.camera.zoom / 2, -m.h * state.camera.zoom / 2, m.w * state.camera.zoom, m.h * state.camera.zoom);
  if (m.id === state.selectedMap) {
    c.strokeStyle = ACCENT; c.lineWidth = 2; c.setLineDash(m.locked ? [3, 3] : []);
    c.strokeRect(-m.w * state.camera.zoom / 2, -m.h * state.camera.zoom / 2, m.w * state.camera.zoom, m.h * state.camera.zoom);
  }
  c.restore();
}

/* ================= render loop ================= */
function drawBase(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "#1c1c1e"); g.addColorStop(1, "#000");
  c.fillStyle = g; c.fillRect(0, 0, w, h);
}
function drawWallsStatic(c: CanvasRenderingContext2D, cw: number, ch: number): void {
  c.lineCap = "round";
  state.walls.forEach((w, i) => {
    const a = toScreen(w.a.x, w.a.y, cw, ch), b = toScreen(w.b.x, w.b.y, cw, ch);
    c.strokeStyle = i === state.selectedWall ? ACCENT : "rgba(255,255,255,0.55)";
    c.lineWidth = i === state.selectedWall ? 3 : 2;
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    if (state.tool === "walls") {
      c.fillStyle = i === state.selectedWall ? ACCENT : "rgba(255,255,255,0.7)";
      [a, b].forEach(p => { c.beginPath(); c.arc(p.x, p.y, 4, 0, Math.PI * 2); c.fill(); });
    }
  });
}

/* Static layer: background + map objects + walls. These only change on an
 * explicit edit, a camera move, or (briefly) while a map's rotation is
 * mid-animation - not every single frame the way lights/flicker do. Caching
 * them to an offscreen canvas and blitting with one drawImage() instead of
 * redrawing a gradient fill, every map image, and every wall stroke 60
 * times a second is the "offscreen canvas buffering" from the original
 * spec, which hadn't actually been implemented until now - this is the
 * direct fix for the idle CPU/wake-up numbers Activity Monitor was showing. */
function staticSignature(): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => { h = (Math.imul(h ^ (v * 1000 | 0), 16777619)) | 0; };
  mix(state.camera.x); mix(state.camera.y); mix(state.camera.zoom);
  mix(state.selectedWall ?? -1); mix(state.tool === "walls" ? 1 : 0);
  for (const m of state.mapObjects) {
    mix(m.x); mix(m.y); mix(m.w); mix(m.h); mix(m.rotation);
    mix(m.layer === "back" ? 0 : m.layer === "normal" ? 1 : 2);
    mix(m.id === state.selectedMap ? 1 : 0);
  }
  for (const w of state.walls) { mix(w.a.x); mix(w.a.y); mix(w.b.x); mix(w.b.y); }
  return h;
}
function rebuildStaticLayer(cw: number, ch: number): void {
  staticCanvas.width = canvas.width; staticCanvas.height = canvas.height;
  staticCtx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
  drawBase(staticCtx, cw, ch);
  state.mapObjects.filter(m => m.layer !== "front").forEach(m => drawMapObject(staticCtx, m, cw, ch));
  drawWallsStatic(staticCtx, cw, ch);

  frontCanvas.width = canvas.width; frontCanvas.height = canvas.height;
  frontCtx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
  state.mapObjects.filter(m => m.layer === "front").forEach(m => drawMapObject(frontCtx, m, cw, ch));
}

let lastWorldSig: number | null = null, pendingSig: number | null = null, cachedPolys: Vec2[][] | null = null;
let visibilityRequest = 0;
let lastFogProjSig: string | null = null; // camera + darkness only - cheap to rebuild from, no raycasting involved
// Reused across frames instead of a fresh array literal every frame - cuts
// one GC allocation per frame on top of the token/light object literals,
// which is as far as it's worth going for a scene with a handful of lights.
const activeLights: LightSource[] = [];
let sceneInteractionActive = false;
let interactionQualityTimer: number | null = null;
function useInteractiveLightingQuality(): void {
  sceneInteractionActive = true;
  if (interactionQualityTimer != null) window.clearTimeout(interactionQualityTimer);
  interactionQualityTimer = window.setTimeout(() => {
    interactionQualityTimer = null;
    sceneInteractionActive = false;
    requestRender();
  }, 160);
}
function restoreFullLightingQuality(): void {
  if (interactionQualityTimer != null) window.clearTimeout(interactionQualityTimer);
  interactionQualityTimer = null;
  if (sceneInteractionActive) {
    sceneInteractionActive = false;
    requestRender();
  }
}

/** Redraws the fog canvas by reprojecting the *already-known* world-space
 * polygons to current screen coordinates. Pure local work, no raycasting,
 * no IPC - safe to call every time the camera pans/zooms or darkness
 * changes, which is the common case (dragging the view around). */
function rebuildFogCanvas(lights: LightSource[], polys: Vec2[][], cw: number, ch: number): void {
  fogCtx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
  fogCtx.clearRect(0, 0, cw, ch);
  fogCtx.fillStyle = `rgba(0,0,0,${state.darkness / 100})`;
  fogCtx.fillRect(0, 0, cw, ch);
  lights.forEach((src, i) => revealFog(src, polys[i], cw, ch));
}

function fallbackLightPolygon(source: LightSource): Vec2[] {
  const radius = (360 * ((source.radius ?? 100) / 100)) / state.camera.zoom;
  const points: Vec2[] = [];
  const cone = Math.min(360, Math.max(5, source.cone));
  const start = cone >= 359.5 ? -Math.PI : source.facing - (cone * Math.PI / 360);
  const sweep = cone >= 359.5 ? Math.PI * 2 : cone * Math.PI / 180;
  const samples = cone >= 359.5 ? 32 : 16;
  for (let index = 0; index <= samples; index += 1) {
    const angle = start + sweep * (index / samples);
    points.push({ x: source.x + Math.cos(angle) * radius, y: source.y + Math.sin(angle) * radius });
  }
  return cone >= 359.5 ? points : [{ x: source.x, y: source.y }, ...points];
}

/** Kicks off the Rust-side raycast for the current light set, in the
 * background, as a single batched call (one IPC round-trip covering every
 * light, not one per light). render() never awaits this - it keeps drawing
 * with the last known-good polygons until this resolves, so a slow frame
 * here never stalls the 60fps loop. Only called when world-space geometry
 * actually changed (see worldSignature) - panning/zooming alone handles
 * the view locally via rebuildFogCanvas instead. */
async function refreshLightPolys(sig: number, lights: LightSource[], sampleCount: number): Promise<void> {
  const request = ++visibilityRequest;
  pendingSig = sig;
  try {
    const walls = state.walls.map(w => ({ a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } }));
    const lightReqs = lights.map(src => ({
      ox: src.x, oy: src.y, max_dist: (360 * ((src.radius ?? 100) / 100)) / state.camera.zoom,
      facing: src.facing, cone: src.cone,
    }));
    const results = await invoke<[number, number][][]>("compute_visibility_batch", { input: { walls, lights: lightReqs, sampleCount } });
    if (request === visibilityRequest) {
      cachedPolys = results.map((pts, index) => {
        const polygon = pts.map(([x, y]) => ({ x, y }));
        return polygon.length >= 3 ? polygon : fallbackLightPolygon(lights[index]);
      });
      lastWorldSig = sig;
      lastFogProjSig = null; // force a fog rebuild next frame with the fresh polygons
      requestRender();
    }
  } catch (e) {
    console.error("compute_visibility_batch failed", e);
    if (request === visibilityRequest) {
      cachedPolys = lights.map(fallbackLightPolygon);
      lastWorldSig = sig;
      lastFogProjSig = null;
      requestRender();
    }
  } finally {
    if (request === visibilityRequest) pendingSig = null;
  }
}

function render(): void {
  frameRequested = false;
  const cw = innerWidth, ch = innerHeight;
  const now = performance.now();
  let animationActive = false;
  let ambientLightActive = false;

  // Single pass per entity type: animate (lerp) and compute screen position
  // - merged from what used to be 3-4 separate forEach passes over the same
  // arrays. Map objects no longer draw themselves here; staticSignature()
  // picks up their animated rotation below and the static layer rebuilds
  // only while that animation is actually in progress.
  activeLights.length = 0;
  for (const m of state.mapObjects) {
    if (Math.abs(lerpAngle(m.rotation, m.rotationTarget, 1) - m.rotation) > 0.0005) {
      m.rotation = lerpAngle(m.rotation, m.rotationTarget, ROT_LERP);
      animationActive = true;
    } else m.rotation = m.rotationTarget;
  }
  for (const t of state.tokens) {
    if (Math.abs(lerpAngle(t.facing, t.facingTarget, 1) - t.facing) > 0.0005) {
      t.facing = lerpAngle(t.facing, t.facingTarget, ROT_LERP);
      animationActive = true;
    } else t.facing = t.facingTarget;
    if (t.followToken) t.lightFacingTarget = t.facingTarget;
    if (Math.abs(lerpAngle(t.lightFacing, t.lightFacingTarget, 1) - t.lightFacing) > 0.0005) {
      t.lightFacing = lerpAngle(t.lightFacing, t.lightFacingTarget, ROT_LERP);
      animationActive = true;
    } else t.lightFacing = t.lightFacingTarget;
    const flipTarget = t.flip ? -1 : 1;
    if (Math.abs(t.flipScale - flipTarget) > 0.004) {
      t.flipScale += (flipTarget - t.flipScale) * 0.22;
      animationActive = true;
    } else t.flipScale = flipTarget;
    const p = toScreen(t.x, t.y, cw, ch); t.sx = p.x; t.sy = p.y;
    if (t.light) {
      activeLights.push({
        x: t.x + t.lightOffset.dx, y: t.y + t.lightOffset.dy, facing: t.lightFacing,
        cone: t.cone, color: state.lightColor, intensity: 100, radius: 100, flicker: 1,
      });
    }
  }
  for (const l of state.lights) {
    const p = toScreen(l.x, l.y, cw, ch); l.sx = p.x; l.sy = p.y;
    if (l.on) {
      ambientLightActive ||= state.absoluteDarkness;
      const seed = l.id.charCodeAt(0) + l.id.charCodeAt(l.id.length - 1);
      const flicker = 1 + Math.sin(now / 180 + seed) * 0.05 + Math.sin(now / 53 + seed * 2) * 0.025;
      activeLights.push({ x: l.x, y: l.y, facing: 0, cone: 360, color: l.color, intensity: l.intensity, radius: l.radius, flicker });
    }
  }

  const ssig = staticSignature();
  if (ssig !== lastStaticSig) { rebuildStaticLayer(cw, ch); lastStaticSig = ssig; }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(staticCanvas, 0, 0); ctx.restore();
  ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);

  if (state.absoluteDarkness) {
    const sampleCount = sceneInteractionActive ? 32 : 72;
    const sig = worldSignature(sampleCount);
    if (sig !== lastWorldSig && sig !== pendingSig) {
      refreshLightPolys(sig, activeLights.slice(), sampleCount);
    }
    if (cachedPolys && cachedPolys.length === activeLights.length) {
      // Cheap, local, synchronous: only reruns when the camera moved or
      // darkness changed, not every frame and never via Rust.
      const projSig = `${state.camera.x}|${state.camera.y}|${state.camera.zoom}|${state.darkness}`;
      if (projSig !== lastFogProjSig) {
        rebuildFogCanvas(activeLights, cachedPolys, cw, ch);
        lastFogProjSig = projSig;
      }
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(fogCanvas, 0, 0); ctx.restore();
      activeLights.forEach((src, i) => tintLight(src, cachedPolys![i], cw, ch));
    }
  }

  if (state.wallDraft && state.wallDraftCursor) {
    const a = toScreen(state.wallDraft.x, state.wallDraft.y, cw, ch);
    ctx.save(); ctx.strokeStyle = ACCENT; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(state.wallDraftCursor.x, state.wallDraftCursor.y); ctx.stroke();
    ctx.restore();
  }

  state.lights.forEach(l => drawTorchGlyph(l));
  for (const layer of TOKEN_LAYERS) {
    for (const t of state.tokens) {
      if (t.layer !== layer) continue;
      const hasImg = t.assetId && state.assetImages[t.assetId];
      if (!hasImg) {
        const selected = t.id === state.selectedToken;
        ctx.save(); ctx.beginPath(); ctx.arc(t.sx, t.sy, t.r * state.camera.zoom, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(28,28,30,0.96)"; ctx.fill();
        ctx.lineWidth = selected ? 2 : 1; ctx.strokeStyle = selected ? ACCENT : "rgba(255,255,255,0.3)"; ctx.stroke();
        ctx.restore();
      }
      drawTokenGlyph(t);
    }
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(frontCanvas, 0, 0); ctx.restore();

  if (animationActive) requestRender();
  else if (ambientLightActive) requestAmbientLightRender();
}
requestRender();

/* ================= interaction ================= */
let dragging: Token | null = null, draggingMap: MapObject | null = null;
let panStart: Vec2 | null = null, camStart: Camera | null = null;

function hitTestToken(mx: number, my: number): Token | null {
  for (let i = state.tokens.length - 1; i >= 0; i--) {
    const t = state.tokens[i];
    if (Math.hypot(mx - t.sx, my - t.sy) <= Math.max(t.r * state.camera.zoom, 10)) return t;
  }
  return null;
}
function hitTestLight(mx: number, my: number): LightPoint | null {
  for (let i = state.lights.length - 1; i >= 0; i--) {
    const l = state.lights[i];
    if (Math.hypot(mx - l.sx, my - l.sy) <= 10) return l;
  }
  return null;
}
function hitTestMap(mx: number, my: number, cw: number, ch: number): MapObject | null {
  for (let i = state.mapObjects.length - 1; i >= 0; i--) {
    const m = state.mapObjects[i];
    const w = toWorld(mx, my, cw, ch);
    const dx = w.x - m.x, dy = w.y - m.y;
    const c = Math.cos(-m.rotation), s = Math.sin(-m.rotation);
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (Math.abs(lx) <= m.w / 2 && Math.abs(ly) <= m.h / 2) return m;
  }
  return null;
}
function hitTestWallHandle(mx: number, my: number): WallHandle | null {
  const cw = innerWidth, ch = innerHeight;
  for (let i = 0; i < state.walls.length; i++) {
    const w = state.walls[i];
    const a = toScreen(w.a.x, w.a.y, cw, ch), b = toScreen(w.b.x, w.b.y, cw, ch);
    if (Math.hypot(mx - a.x, my - a.y) < 9) return { wall: w, idx: i, end: "a" };
    if (Math.hypot(mx - b.x, my - b.y) < 9) return { wall: w, idx: i, end: "b" };
  }
  return null;
}
function hitTestWallBody(mx: number, my: number): number | null {
  const cw = innerWidth, ch = innerHeight;
  for (let i = 0; i < state.walls.length; i++) {
    const w = state.walls[i];
    const a = toScreen(w.a.x, w.a.y, cw, ch), b = toScreen(w.b.x, w.b.y, cw, ch);
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    let t = l2 ? ((mx - a.x) * (b.x - a.x) + (my - a.y) * (b.y - a.y)) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
    if (Math.hypot(mx - px, my - py) < 7) return i;
  }
  return null;
}
function snap(v: number): number { return state.snap ? Math.round(v / 25) * 25 : v; }

canvas.addEventListener("dblclick", e => {
  requestRender();
  const cw = innerWidth, ch = innerHeight;
  const hit = hitTestToken(e.clientX, e.clientY);
  if (hit) { state.selectedToken = hit.id; openTokenMenu(hit, e.clientX, e.clientY); return; }
  const lh = hitTestLight(e.clientX, e.clientY);
  if (lh) { openLightMenu(lh, e.clientX, e.clientY); return; }
  const mh = hitTestMap(e.clientX, e.clientY, cw, ch);
  if (mh) { state.selectedMap = mh.id; openMapMenu(mh, e.clientX, e.clientY); return; }
  if (state.tool === "walls") {
    const wi = hitTestWallBody(e.clientX, e.clientY);
    if (wi != null) { pushUndo(); state.walls.splice(wi, 1); state.selectedWall = null; }
  }
});

canvas.addEventListener("mousedown", e => {
  requestRender();
  useInteractiveLightingQuality();
  const cw = innerWidth, ch = innerHeight;
  if (state.repositioning) {
    const t = state.tokens.find(t => t.id === state.repositioning);
    if (t) {
      const w = toWorld(e.clientX, e.clientY, cw, ch);
      let dx = w.x - t.x, dy = w.y - t.y;
      const dist = Math.hypot(dx, dy);
      if (dist > t.r) { dx = dx / dist * t.r; dy = dy / dist * t.r; }
      pushUndo(); t.lightOffset = { dx, dy };
    }
    state.repositioning = null; canvas.classList.remove("reposition-mode"); return;
  }
  closeCtxMenu(); closePalette();
  if (state.tool === "light") {
    const existing = hitTestLight(e.clientX, e.clientY);
    pushUndo();
    if (existing) { state.lights = state.lights.filter(l => l !== existing); }
    else { const w = toWorld(e.clientX, e.clientY, cw, ch); state.lights.push({ id: uid(), x: snap(w.x), y: snap(w.y), on: true, color: state.lightColor, intensity: 100, radius: 100, sx: 0, sy: 0 }); }
    return;
  }
  if (state.tool === "walls") {
    const handle = hitTestWallHandle(e.clientX, e.clientY);
    if (handle) { pushUndo(); state.draggingWallHandle = handle; state.selectedWall = handle.idx; return; }
    const body = hitTestWallBody(e.clientX, e.clientY);
    if (body != null) { state.selectedWall = body; return; }
    const w = toWorld(e.clientX, e.clientY, cw, ch); const p = { x: snap(w.x), y: snap(w.y) };
    if (!state.wallDraft) { state.wallDraft = p; }
    else { pushUndo(); state.walls.push({ a: state.wallDraft, b: p }); state.wallDraft = e.shiftKey ? p : null; }
    return;
  }
  if (state.tool === "rotate") {
    const hit = hitTestToken(e.clientX, e.clientY);
    if (hit && !hit.locked) { pushUndo(); state.selectedToken = hit.id; state.rotatingToken = hit; }
    return;
  }
  const hit = hitTestToken(e.clientX, e.clientY);
  if (hit && e.button === 0) {
    state.selectedToken = hit.id;
    if (!hit.locked) { pushUndo(); dragging = hit; canvas.classList.add("token-drag"); }
    return;
  }
  const mapHit = hitTestMap(e.clientX, e.clientY, cw, ch);
  if (mapHit && e.button === 0) {
    state.selectedMap = mapHit.id;
    if (!mapHit.locked) { pushUndo(); draggingMap = mapHit; canvas.classList.add("token-drag"); }
    return;
  }
  panStart = { x: e.clientX, y: e.clientY }; camStart = { ...state.camera }; canvas.classList.add("panning");
});
addEventListener("mousemove", e => {
  requestRender();
  if (dragging || draggingMap || panStart || state.draggingWallHandle || state.rotatingToken || state.wallDraft) useInteractiveLightingQuality();
  const cw = innerWidth, ch = innerHeight;
  if (state.tool === "walls" && state.wallDraft) state.wallDraftCursor = { x: e.clientX, y: e.clientY };
  if (state.draggingWallHandle) {
    const w = toWorld(e.clientX, e.clientY, cw, ch);
    const h = state.draggingWallHandle;
    h.wall[h.end] = { x: snap(w.x), y: snap(w.y) };
    return;
  }
  if (state.rotatingToken) { const t = state.rotatingToken; t.facing = t.facingTarget = Math.atan2(e.clientY - t.sy, e.clientX - t.sx); return; }
  if (dragging) { const w = toWorld(e.clientX, e.clientY, cw, ch); dragging.x = snap(w.x); dragging.y = snap(w.y); return; }
  if (draggingMap) { const w = toWorld(e.clientX, e.clientY, cw, ch); draggingMap.x = snap(w.x); draggingMap.y = snap(w.y); return; }
  if (panStart && camStart) {
    state.camera.x = camStart.x - (e.clientX - panStart.x) / state.camera.zoom;
    state.camera.y = camStart.y - (e.clientY - panStart.y) / state.camera.zoom;
  }
});
addEventListener("mouseup", () => {
  dragging = null; draggingMap = null; panStart = null; state.draggingWallHandle = null; state.rotatingToken = null;
  canvas.classList.remove("token-drag", "panning");
  restoreFullLightingQuality();
  requestRender();
});
canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const d = -e.deltaY * 0.001;
  state.camera.zoom = Math.min(2.6, Math.max(0.4, state.camera.zoom * (1 + d)));
  useInteractiveLightingQuality();
  requestRender();
}, { passive: false });
addEventListener("keydown", e => {
  requestRender();
  if (e.ctrlKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); doUndo(); return; }
  if (e.key === "Escape") { state.wallDraft = null; state.repositioning = null; closeCtxMenu(); closePalette(); }
  if (e.key === "Backspace") {
    if (state.selectedToken) { pushUndo(); state.tokens = state.tokens.filter(t => t.id !== state.selectedToken); state.selectedToken = null; closeCtxMenu(); return; }
    if (state.selectedWall != null) { pushUndo(); state.walls.splice(state.selectedWall, 1); state.selectedWall = null; if (state.openTab) renderPanel(); return; }
    if (state.selectedMap) {
      const m = state.mapObjects.find(m => m.id === state.selectedMap);
      if (m && !m.locked) { pushUndo(); state.mapObjects = state.mapObjects.filter(x => x.id !== m.id); state.selectedMap = null; closeCtxMenu(); }
      return;
    }
  }
  const t = state.tokens.find(t => t.id === state.selectedToken);
  if (t && !t.locked) {
    if (e.key === "q" || e.key === "Q") { t.facingTarget -= Math.PI / 9; markSceneDirty(); return; }
    if (e.key === "e" || e.key === "E") { t.facingTarget += Math.PI / 9; markSceneDirty(); return; }
    if (e.key === "+" || e.key === "=") { t.r = Math.min(TOKEN_MAX_R, t.r + 4); markSceneDirty(); return; }
    if (e.key === "-" || e.key === "_") { t.r = Math.max(TOKEN_MIN_R, t.r - 4); markSceneDirty(); return; }
    if (e.key === "f" || e.key === "F") { t.flip = !t.flip; markSceneDirty(); return; }
    return;
  }
  const m = state.mapObjects.find(m => m.id === state.selectedMap);
  if (m && !m.locked) {
    if (e.key === "q" || e.key === "Q") { m.rotationTarget -= Math.PI / 9; markSceneDirty(); }
    if (e.key === "r" || e.key === "R") { m.rotationTarget += Math.PI / 9; markSceneDirty(); }
    if (e.key === "+" || e.key === "=") { m.w *= 1.08; m.h *= 1.08; markSceneDirty(); }
    if (e.key === "-" || e.key === "_") { m.w *= 0.92; m.h *= 0.92; markSceneDirty(); }
  }
});

/* ================= context menus ================= */
const ctxmenu = document.getElementById("ctxmenu") as HTMLElement;
const ICO2: Record<string, string> = {
  rot: '<path d="M3 12a9 9 0 1 1 3 6.7M3 12v5h5"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  pin: '<circle cx="12" cy="10" r="3"/><path d="M12 21s-6-5.7-6-10a6 6 0 1 1 12 0c0 4.3-6 10-6 10z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.3-1.8"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
  front: '<path d="M12 19V5m0 0-4 4m4-4 4 4"/><path d="M5 20h14"/>',
  back: '<path d="M12 5v14m0 0-4-4m4 4 4-4"/><path d="M5 4h14"/>',
};
function ic2(n: string): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICO2[n]}</svg>`; }
function positionMenu(x: number, y: number, h?: number): void {
  ctxmenu.style.left = Math.min(x + 10, innerWidth - 180) + "px";
  ctxmenu.style.top = Math.min(y + 10, innerHeight - (h || 240)) + "px";
  ctxmenu.classList.add("open");
}
function q<T extends HTMLElement>(sel: string): T { return ctxmenu.querySelector(sel) as T; }

function openTokenMenu(t: Token, x: number, y: number): void {
  ctxmenu.innerHTML = `
    <div class="ctx-btns">
      <div class="ctx-btn" id="cRotL">${ic2("rot")}</div><div class="ctx-btn" id="cMinus">${ic2("minus")}</div>
      <div class="ctx-btn" id="cPlus">${ic2("plus")}</div><div class="ctx-btn danger" id="cDel">${ic2("trash")}</div>
    </div>
    <div class="ctx-btn ctx-wide" id="cLockBtn">${ic2(t.locked ? "unlock" : "lock")} ${t.locked ? "Unlock" : "Lock"} token</div>
    <div class="ctx-btn ctx-wide" id="cReposition">${ic2("pin")} Reposition light</div>
    <div class="ctx-btns">
      <div class="ctx-btn" id="cSendBack" title="Send to back layer">${ic2("back")}</div>
      <div class="ctx-btn" id="cBringFront" title="Bring to front layer">${ic2("front")}</div>
    </div>
    <div class="ctx-row"><span>Light</span><div class="switch ${t.light ? "on" : ""}" id="cLight"></div></div>
    <div class="ctx-row"><span>Follow token facing</span><div class="switch ${t.followToken ? "on" : ""}" id="cFollow"></div></div>
    <div class="row" style="margin:6px 0 0;"><label><span>Cone</span>${numBox("cConeNum", 5, 360, t.cone)}</label><input type="range" id="cCone" min="5" max="360" value="${t.cone}"></div>
    <div class="row" style="margin:6px 0 0;" id="cLARow"><label><span>Light angle</span>${numBox("cLANum", -180, 180, Math.round(t.lightFacingTarget * 180 / Math.PI))}</label><input type="range" id="cLA" min="-180" max="180" value="${Math.round(t.lightFacingTarget * 180 / Math.PI)}" ${t.followToken ? "disabled" : ""}></div>
    <div class="ctx-btn ctx-wide" id="cRecenter" style="margin-top:4px;">${ic2("target")} Recenter light</div>
  `;
  positionMenu(x, y, 360);
  q<HTMLElement>("#cRotL").onclick = () => { pushUndo(); t.facingTarget -= Math.PI / 6; };
  q<HTMLElement>("#cMinus").onclick = () => { pushUndo(); t.r = Math.max(TOKEN_MIN_R, t.r - 6); };
  q<HTMLElement>("#cPlus").onclick = () => { pushUndo(); t.r = Math.min(TOKEN_MAX_R, t.r + 6); };
  q<HTMLElement>("#cDel").onclick = () => { pushUndo(); state.tokens = state.tokens.filter(x => x.id !== t.id); closeCtxMenu(); };
  q<HTMLElement>("#cLockBtn").onclick = () => { pushUndo(); t.locked = !t.locked; openTokenMenu(t, x, y); };
  q<HTMLElement>("#cLight").onclick = e => { pushUndo(); t.light = !t.light; (e.target as HTMLElement).classList.toggle("on", t.light); };
  q<HTMLElement>("#cFollow").onclick = e => {
    pushUndo(); t.followToken = !t.followToken; (e.target as HTMLElement).classList.toggle("on", t.followToken);
    if (t.followToken) t.lightFacingTarget = t.facingTarget;
    openTokenMenu(t, x, y);
  };
  syncRangeNum(q("#cCone"), q("#cConeNum"), v => { t.cone = v; markSceneDirty(); });
  syncRangeNum(q("#cLA"), q("#cLANum"), v => { t.lightFacingTarget = v * Math.PI / 180; markSceneDirty(); });
  q<HTMLElement>("#cReposition").onclick = () => { state.repositioning = t.id; canvas.classList.add("reposition-mode"); closeCtxMenu(); };
  q<HTMLElement>("#cRecenter").onclick = () => { pushUndo(); t.lightOffset = { dx: 0, dy: 0 }; t.lightFacingTarget = t.facingTarget; openTokenMenu(t, x, y); };
  q<HTMLElement>("#cSendBack").onclick = () => { pushUndo(); t.layer = "back"; openTokenMenu(t, x, y); };
  q<HTMLElement>("#cBringFront").onclick = () => { pushUndo(); t.layer = "front"; openTokenMenu(t, x, y); };
}
function openLightMenu(l: LightPoint, x: number, y: number): void {
  ctxmenu.innerHTML = `
    <div class="ctx-row"><span>On</span><div class="switch ${l.on ? "on" : ""}" id="lOn"></div></div>
    <div class="row" style="margin:8px 0;"><label><span>Color</span><span></span></label><input type="color" id="lColor" value="${l.color || state.lightColor}"></div>
    <div class="row"><label><span>Intensity</span>${numBox("lIntNum", 10, 400, l.intensity ?? 100)}</label><input type="range" id="lInt" min="10" max="400" value="${l.intensity ?? 100}"></div>
    <div class="row"><label><span>Radius</span>${numBox("lRadNum", 20, 800, l.radius ?? 100)}</label><input type="range" id="lRad" min="20" max="800" value="${l.radius ?? 100}"></div>
    <div class="ctx-btn danger ctx-wide" id="lDel">${ic2("trash")} Delete</div>
  `;
  positionMenu(x, y, 280);
  q<HTMLElement>("#lOn").onclick = e => { pushUndo(); l.on = !l.on; (e.target as HTMLElement).classList.toggle("on", l.on); };
  (q<HTMLInputElement>("#lColor")).oninput = e => { l.color = (e.target as HTMLInputElement).value; markSceneDirty(); };
  syncRangeNum(q("#lInt"), q("#lIntNum"), v => { l.intensity = v; markSceneDirty(); });
  syncRangeNum(q("#lRad"), q("#lRadNum"), v => { l.radius = v; markSceneDirty(); });
  q<HTMLElement>("#lDel").onclick = () => { pushUndo(); state.lights = state.lights.filter(x => x !== l); closeCtxMenu(); };
}
function openMapMenu(m: MapObject, x: number, y: number): void {
  ctxmenu.innerHTML = `
    <div class="ctx-btns">
      <div class="ctx-btn" id="mRotL">${ic2("rot")}</div><div class="ctx-btn" id="mMinus">${ic2("minus")}</div>
      <div class="ctx-btn" id="mPlus">${ic2("plus")}</div><div class="ctx-btn danger" id="mDel">${ic2("trash")}</div>
    </div>
    <div class="ctx-btn ctx-wide" id="mLock">${ic2(m.locked ? "unlock" : "lock")} ${m.locked ? "Unlock" : "Lock"} position</div>
    <div class="ctx-btn ctx-wide" id="mLayer">${m.layer === "front" ? "Send to back layer" : "Bring to front layer"}</div>
  `;
  positionMenu(x, y, 180);
  q<HTMLElement>("#mRotL").onclick = () => { pushUndo(); m.rotationTarget -= Math.PI / 9; };
  q<HTMLElement>("#mMinus").onclick = () => { pushUndo(); m.w *= 0.9; m.h *= 0.9; };
  q<HTMLElement>("#mPlus").onclick = () => { pushUndo(); m.w *= 1.1; m.h *= 1.1; };
  q<HTMLElement>("#mDel").onclick = () => { pushUndo(); state.mapObjects = state.mapObjects.filter(x => x.id !== m.id); closeCtxMenu(); };
  q<HTMLElement>("#mLock").onclick = () => { pushUndo(); m.locked = !m.locked; openMapMenu(m, x, y); };
  q<HTMLElement>("#mLayer").onclick = () => { pushUndo(); m.layer = m.layer === "front" ? "back" : "front"; openMapMenu(m, x, y); };
}
function closeCtxMenu(): void { ctxmenu.classList.remove("open"); }
addEventListener("mousedown", e => {
  if (ctxmenu.classList.contains("open") && !ctxmenu.contains(e.target as Node) && e.target !== canvas) closeCtxMenu();
}, true);

/* ================= color palette popup (folders: recolor + delete) ================= */
const palettePopup = document.getElementById("palettePopup") as HTMLElement;
function openPalette(x: number, y: number, onPick: (c: string) => void, onDelete: (() => void) | null): void {
  palettePopup.innerHTML = "";
  PALETTE.forEach(c => {
    const sw = document.createElement("div"); sw.className = "sw"; sw.style.background = c;
    sw.onclick = () => { onPick(c); closePalette(); };
    palettePopup.appendChild(sw);
  });
  if (onDelete) {
    const del = document.createElement("div"); del.className = "delsw"; del.innerHTML = icon("trash");
    del.onclick = () => { onDelete(); closePalette(); };
    palettePopup.appendChild(del);
  }
  palettePopup.style.left = Math.min(x, innerWidth - 150) + "px";
  palettePopup.style.top = Math.min(y, innerHeight - 100) + "px";
  palettePopup.classList.add("open");
}
function closePalette(): void { palettePopup.classList.remove("open"); }
addEventListener("mousedown", e => {
  if (palettePopup.classList.contains("open") && !palettePopup.contains(e.target as Node)) closePalette();
}, true);

/* ================= name modal (native dialogs aren't available in the webview) ================= */
function showNameModal(title: string, placeholder: string, onConfirm: (name: string) => void): void {
  const overlay = document.createElement("div"); overlay.id = "modalOverlay";
  overlay.innerHTML = `<div id="modalBox"><div class="mt">${title}</div>
    <input type="text" id="modalInput" placeholder="${placeholder}">
    <div class="mrow"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalOk">Create</button></div></div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#modalInput") as HTMLInputElement;
  input.focus();
  const close = () => overlay.remove();
  (overlay.querySelector("#modalCancel") as HTMLElement).onclick = close;
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });
  (overlay.querySelector("#modalOk") as HTMLElement).onclick = () => { const v = input.value.trim(); if (v) onConfirm(v); close(); };
  input.onkeydown = e => {
    if (e.key === "Enter") { const v = input.value.trim(); if (v) onConfirm(v); close(); }
    if (e.key === "Escape") close();
  };
}

/* ================= shared UI helpers ================= */
const ICO: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>', trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  prev: '<path d="M19 5 9 12l10 7zM5 5v14"/>', next: '<path d="M5 5l10 7-10 7zM19 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>', pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>', chev: '<path d="m6 9 6 6 6-6"/>',
};
function icon(name: string): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICO[name]}</svg>`; }
function numBox(id: string, min: number, max: number, val: number): string {
  return `<input type="number" id="${id}" min="${min}" max="${max}" value="${val}" style="width:52px; background:rgba(255,255,255,0.06); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:11px; padding:3px 5px; text-align:center; font-family:inherit;">`;
}
function syncRangeNum(range: HTMLInputElement, num: HTMLInputElement, onChange: (v: number) => void): void {
  range.oninput = () => { num.value = range.value; onChange(+range.value); };
  num.oninput = () => {
    let v = +num.value; if (isNaN(v)) return;
    v = Math.max(+num.min, Math.min(+num.max, v)); range.value = String(v); onChange(v);
  };
}

/* ================= rail / panel ================= */
const hamburger = document.getElementById("hamburger") as HTMLElement;
const rail = document.getElementById("rail") as HTMLElement;
const subpanel = document.getElementById("subpanel") as HTMLElement;
function resetTool(): void { state.tool = "select"; canvas.className = ""; state.wallDraft = null; state.selectedWall = null; state.repositioning = null; }
function setRail(open: boolean): void {
  state.railOpen = open; hamburger.classList.toggle("open", open); rail.classList.toggle("open", open);
  if (!open) closeTab();
}
setRail(true);
hamburger.addEventListener("click", () => setRail(!state.railOpen));
function openTab(tab: string): void {
  if (state.openTab === tab) { closeTab(); return; }
  state.openTab = tab;
  document.querySelectorAll(".rail-btn").forEach(b => b.classList.toggle("active", (b as HTMLElement).dataset.tab === tab));
  subpanel.classList.add("open");
  renderPanel();
}
function closeTab(): void {
  state.openTab = null;
  document.querySelectorAll(".rail-btn").forEach(b => b.classList.remove("active"));
  subpanel.classList.remove("open");
  resetTool();
}
document.querySelectorAll(".rail-btn").forEach(btn => btn.addEventListener("click", () => openTab((btn as HTMLElement).dataset.tab!)));

function folderRow(
  folders: AssetFolder[], currentId: string,
  onSelect: (id: string) => void, onAdd: () => void,
  onRecolor: (f: AssetFolder, color: string) => void, onDelete: (f: AssetFolder) => void,
): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "folder-row";
  folders.forEach(f => {
    const sq = document.createElement("div"); sq.className = "folder-sq" + (f.id === currentId ? " active" : ""); sq.style.background = f.color;
    sq.onclick = () => onSelect(f.id);
    sq.oncontextmenu = e => { e.preventDefault(); openPalette(e.clientX, e.clientY, c => onRecolor(f, c), folders.length > 1 ? () => onDelete(f) : null); };
    wrap.appendChild(sq);
  });
  const add = document.createElement("div"); add.className = "folder-add"; add.innerHTML = icon("plus"); add.onclick = onAdd;
  wrap.appendChild(add);
  return wrap;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]!);
}

function renderPanel(): void {
  if (!state.openTab) return;
  const c = subpanel;
  if (state.openTab === "tools") {
    c.innerHTML = `
      <h2>Tools</h2>
      <div class="seg"><div data-t="select">Select</div><div data-t="rotate">Rotate</div><div data-t="walls">Walls</div><div data-t="light">Light</div></div>
      ${state.tool === "walls" && state.selectedWall != null ? `<button class="btn danger" id="delWall">${icon("trash")} Delete selected wall</button>` : ""}
      ${state.tool === "walls" ? `<div class="toggle-row" style="margin-top:4px;"><span>Snap to grid</span><div class="switch ${state.snap ? "on" : ""}" id="snapT"></div></div>` : ""}
    `;
    c.querySelectorAll(".seg div").forEach(el => {
      const d = el as HTMLElement;
      d.classList.toggle("active", state.tool === d.dataset.t);
      d.onclick = () => {
        state.tool = d.dataset.t!; state.wallDraft = null; state.selectedWall = null;
        canvas.className = "";
        if (state.tool === "walls") canvas.classList.add("wall-mode");
        if (state.tool === "rotate") canvas.classList.add("rotate-mode");
        if (state.tool === "light") canvas.classList.add("light-mode");
        renderPanel();
      };
    });
    const dw = c.querySelector("#delWall") as HTMLElement | null;
    if (dw) dw.onclick = () => { pushUndo(); state.walls.splice(state.selectedWall!, 1); state.selectedWall = null; renderPanel(); };
    const sn = c.querySelector("#snapT") as HTMLElement | null;
    if (sn) sn.onclick = e => { state.snap = !state.snap; (e.target as HTMLElement).classList.toggle("on", state.snap); };
  } else if (state.openTab === "lighting") {
    c.innerHTML = `
      <h2>Lighting</h2>
      <div class="row"><label><span>Darkness</span>${numBox("dNum", 0, 100, state.darkness)}</label><input type="range" id="darkness" min="0" max="100" value="${state.darkness}"></div>
      <div class="row"><label><span>Color</span><span></span></label><input type="color" id="color" value="${state.lightColor}"></div>
      <div class="toggle-row"><span>Absolute darkness</span><div class="switch ${state.absoluteDarkness ? "on" : ""}" id="dk"></div></div>
    `;
    syncRangeNum(c.querySelector("#darkness") as HTMLInputElement, c.querySelector("#dNum") as HTMLInputElement, v => { state.darkness = v; });
    (c.querySelector("#color") as HTMLInputElement).oninput = e => { state.lightColor = (e.target as HTMLInputElement).value; markSceneDirty(); };
    (c.querySelector("#dk") as HTMLElement).onclick = e => { state.absoluteDarkness = !state.absoluteDarkness; (e.target as HTMLElement).classList.toggle("on", state.absoluteDarkness); };
  } else if (state.openTab === "tokens") {
    const sub = state.tokensSub;
    c.innerHTML = `<div class="seg"><div data-s="tokens" class="${sub === "tokens" ? "active" : ""}">Tokens</div><div data-s="maps" class="${sub === "maps" ? "active" : ""}">Maps</div></div><div id="subBody"></div>`;
    c.querySelectorAll(".seg div").forEach(el => { (el as HTMLElement).onclick = () => { state.tokensSub = (el as HTMLElement).dataset.s!; renderPanel(); }; });
    const body = c.querySelector("#subBody") as HTMLElement;
    if (sub === "tokens") {
      body.appendChild(folderRow(state.tokenFolders, state.currentFolder,
        id => { state.currentFolder = id; renderPanel(); },
        () => { const id = uid(); state.tokenFolders.push({ id, color: PALETTE[state.tokenFolders.length % PALETTE.length] }); state.currentFolder = id; persistMeta(); renderPanel(); },
        (f, color) => { f.color = color; persistMeta(); renderPanel(); },
        f => {
          state.tokenFolders = state.tokenFolders.filter(x => x.id !== f.id);
          state.tokenAssets.forEach(a => { if (a.folderId === f.id) a.folderId = state.tokenFolders[0].id; });
          if (state.currentFolder === f.id) state.currentFolder = state.tokenFolders[0].id;
          persistMeta(); renderPanel();
        }));
      const grid = document.createElement("div"); grid.className = "asset-grid";
      state.tokenAssets.filter(a => a.folderId === state.currentFolder).forEach(a => {
        const el = document.createElement("div"); el.className = "asset-item";
        const im = document.createElement("img"); im.src = a.url; el.appendChild(im);
        el.onclick = () => addToken("img", (Math.random() - 0.5) * 160, (Math.random() - 0.5) * 160, a.id);
        grid.appendChild(el);
      });
      body.appendChild(grid);
      const btn = document.createElement("button"); btn.className = "btn"; btn.innerHTML = icon("plus") + " Import into folder"; btn.onclick = importTokenImage;
      body.appendChild(btn);
    } else {
      body.appendChild(folderRow(state.mapFolders, state.currentMapFolder,
        id => { state.currentMapFolder = id; renderPanel(); },
        () => { const id = uid(); state.mapFolders.push({ id, color: PALETTE[state.mapFolders.length % PALETTE.length] }); state.currentMapFolder = id; persistMeta(); renderPanel(); },
        (f, color) => { f.color = color; persistMeta(); renderPanel(); },
        f => {
          state.mapFolders = state.mapFolders.filter(x => x.id !== f.id);
          state.maps.forEach(a => { if (a.folderId === f.id) a.folderId = state.mapFolders[0].id; });
          if (state.currentMapFolder === f.id) state.currentMapFolder = state.mapFolders[0].id;
          persistMeta(); renderPanel();
        }));
      const grid = document.createElement("div"); grid.className = "asset-grid";
      state.maps.filter(m => m.folderId === state.currentMapFolder).forEach(m => {
        const el = document.createElement("div"); el.className = "asset-item";
        const im = document.createElement("img"); im.src = m.url; el.appendChild(im);
        el.onclick = () => { void addMapObject(m.id).then(() => renderPanel()); };
        grid.appendChild(el);
      });
      body.appendChild(grid);
      const btn = document.createElement("button"); btn.className = "btn"; btn.innerHTML = icon("plus") + " Import map"; btn.onclick = importMapImage;
      body.appendChild(btn);
    }
  } else if (state.openTab === "music") {
    const track = state.tracks[state.trackIndex];
    c.innerHTML = `
      <h2>Music</h2>
      <div class="music-art" id="art" style="${track && track.cover ? `background-image:url(${track.cover})` : ""}"></div>
      <div class="music-title">${track ? escapeHtml(track.name) : "No track loaded"}</div>
      <div class="row"><input type="range" id="seek" min="0" max="100" value="0"></div>
      <div class="music-controls">
        <div class="ctl" id="prevBtn">${icon("prev")}</div>
        <div class="ctl play" id="playBtn">${icon(state.audioEl.paused ? "play" : "pause")}</div>
        <div class="ctl" id="nextBtn">${icon("next")}</div>
      </div>
      <button class="btn" id="importAudioBtn">${icon("plus")} Import tracks</button>
      <div class="hairline"></div>
      <div id="trackList"></div>
    `;
    const tl = c.querySelector("#trackList") as HTMLElement;
    state.tracks.forEach((tr, i) => {
      const el = document.createElement("div"); el.className = "music-track" + (i === state.trackIndex ? " playing" : "");
      el.textContent = tr.name; el.onclick = () => playTrack(i); tl.appendChild(el);
    });
    (c.querySelector("#prevBtn") as HTMLElement).onclick = () => playTrack(Math.max(0, state.trackIndex - 1));
    (c.querySelector("#nextBtn") as HTMLElement).onclick = () => playTrack(Math.min(state.tracks.length - 1, state.trackIndex + 1));
    (c.querySelector("#playBtn") as HTMLElement).onclick = () => { if (!state.tracks.length) return; if (state.audioEl.paused) state.audioEl.play(); else state.audioEl.pause(); renderPanel(); };
    (c.querySelector("#importAudioBtn") as HTMLElement).onclick = importAudioTracks;
    const seek = c.querySelector("#seek") as HTMLInputElement;
    seek.oninput = e => { if (state.audioEl.duration) state.audioEl.currentTime = (+(e.target as HTMLInputElement).value / 100) * state.audioEl.duration; };
    state.audioEl.ontimeupdate = () => { if (state.audioEl.duration) seek.value = String((state.audioEl.currentTime / state.audioEl.duration) * 100); };
  } else if (state.openTab === "settings") {
    const onDefault = !state.currentCampaignId;
    c.innerHTML = `
      <h2>Settings</h2>
      ${onDefault ? `
        <div class="row"><label><span>Campaign</span><span></span></label><input type="text" value="DEFAULT" disabled style="opacity:.6;"></div>
      ` : `
        <div class="row"><label><span>Campaign name</span><span></span></label><input type="text" id="campName" value="${escapeHtml(currentCampaignName())}"></div>
      `}
      ${state.campaigns.length ? `<div class="row"><label><span>Switch campaign</span><span></span></label>
        <div id="campList" style="border:1px solid var(--border); border-radius:9px; overflow:hidden;">${state.campaigns.map(cp => `<div class="camp-item ${cp.id === state.currentCampaignId ? "active" : ""}" data-id="${cp.id}">${cp.id === state.currentCampaignId ? "● " : ""}${escapeHtml(cp.name)}</div>`).join("")}</div></div>` : ""}
      <button class="btn" id="newCamp">${icon("plus")} New campaign</button>
      <button class="btn" id="exportCamp">Export campaign</button>
      <button class="btn" id="importCamp">Import campaign</button>
      <div class="hairline"></div>
      <button class="btn" id="resetView">Reset camera</button>
      <button class="btn danger" id="wipeData">${icon("trash")} Clear local data</button>
    `;
    if (!onDefault) {
      (c.querySelector("#campName") as HTMLInputElement).oninput = e => {
        const cp = state.campaigns.find(c => c.id === state.currentCampaignId);
        if (cp) { cp.name = (e.target as HTMLInputElement).value; persistMeta(); renderPanel(); }
      };
    }
    const cl = c.querySelector("#campList");
    if (cl) cl.querySelectorAll(".camp-item").forEach(el => {
      (el as HTMLElement).onclick = async () => {
        const id = (el as HTMLElement).dataset.id!;
        if (id !== state.currentCampaignId) { await switchCampaign(id); renderPanel(); }
      };
    });
    (c.querySelector("#newCamp") as HTMLElement).onclick = () => {
      showNameModal("New campaign name", "e.g. The Sunken Keep", async name => {
        await createCampaign(name, state.campaigns.length === 0);
        renderPanel();
      });
    };
    (c.querySelector("#exportCamp") as HTMLElement).onclick = () => { void exportCurrentCampaign(); };
    (c.querySelector("#importCamp") as HTMLElement).onclick = () => { void importCampaignFile(); };
    (c.querySelector("#resetView") as HTMLElement).onclick = () => { state.camera = { x: 0, y: 0, zoom: 1 }; };
    (c.querySelector("#wipeData") as HTMLElement).onclick = async () => { await invoke("clear_all_data"); location.reload(); };
  }
}
function currentCampaignName(): string {
  if (!state.currentCampaignId) return "DEFAULT";
  const cp = state.campaigns.find(c => c.id === state.currentCampaignId);
  return cp ? cp.name : "DEFAULT";
}

const AUDIO_CROSSFADE_MS = 900;
let audioFadeFrame: number | null = null;
function stopAudioFade(): void {
  if (audioFadeFrame != null) cancelAnimationFrame(audioFadeFrame);
  audioFadeFrame = null;
}
function nextTrackIndex(): number {
  return state.tracks.length ? (state.trackIndex + 1 + state.tracks.length) % state.tracks.length : -1;
}
function wireAudioDeck(deck: HTMLAudioElement): void {
  deck.onended = () => {
    if (deck === state.audioEl && state.tracks.length) playTrack(nextTrackIndex());
  };
}
wireAudioDeck(state.audioEl);
wireAudioDeck(state.audioAltEl);
function playTrack(i: number): void {
  if (i < 0 || i >= state.tracks.length) return;
  const outgoing = state.audioEl;
  const incoming = state.audioAltEl;
  const changedTrack = outgoing.src !== state.tracks[i].url;
  const previousIndex = state.trackIndex;
  state.trackIndex = i;
  stopAudioFade();
  if (!changedTrack || outgoing.paused) {
    outgoing.src = state.tracks[i].url;
    outgoing.volume = 1;
    outgoing.play().catch(() => {});
    renderPanel();
    return;
  }
  incoming.pause();
  incoming.src = state.tracks[i].url;
  incoming.currentTime = 0;
  incoming.volume = 0;
  incoming.play().then(() => {
    const started = performance.now();
    const fade = (now: number) => {
      const progress = Math.min(1, (now - started) / AUDIO_CROSSFADE_MS);
      incoming.volume = progress;
      outgoing.volume = 1 - progress;
      if (progress < 1) {
        audioFadeFrame = requestAnimationFrame(fade);
        return;
      }
      outgoing.pause();
      outgoing.currentTime = 0;
      outgoing.volume = 1;
      state.audioEl = incoming;
      state.audioAltEl = outgoing;
      audioFadeFrame = null;
      renderPanel();
    };
    audioFadeFrame = requestAnimationFrame(fade);
  }).catch(() => {
    state.trackIndex = previousIndex;
    incoming.pause();
    incoming.currentTime = 0;
    incoming.volume = 1;
    outgoing.volume = 1;
    renderPanel();
  });
}

/* ================= file imports ================= */
interface ImportedAsset { id: string; ext: string; name: string; }
async function pickFiles(filters: { name: string; extensions: string[] }[], multiple: boolean): Promise<string[]> {
  const res = await openDialog({ multiple, filters });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}
async function importTokenImage(): Promise<void> {
  const paths = await pickFiles([{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }], false);
  for (const p of paths) {
    const asset = await invoke<ImportedAsset>("import_asset", { sourcePath: p, kind: "token", folderId: state.currentFolder });
    const src = convertFileSrc(await invoke<string>("asset_path", { id: asset.id, ext: asset.ext }));
    state.tokenAssets.push({ id: asset.id, name: asset.name, folderId: state.currentFolder, url: src });
  }
}
async function importMapImage(): Promise<void> {
  const paths = await pickFiles([{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }], false);
  for (const p of paths) {
    const asset = await invoke<ImportedAsset>("import_asset", { sourcePath: p, kind: "map", folderId: state.currentMapFolder });
    const src = convertFileSrc(await invoke<string>("asset_path", { id: asset.id, ext: asset.ext }));
    state.maps.push({ id: asset.id, name: asset.name, folderId: state.currentMapFolder, url: src });
  }
}
async function importAudioTracks(): Promise<void> {
  const paths = await pickFiles([{ name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a"] }], true);
  for (const p of paths) {
    const asset = await invoke<ImportedAsset>("import_asset", { sourcePath: p, kind: "audio", folderId: null });
    const url = convertFileSrc(await invoke<string>("asset_path", { id: asset.id, ext: asset.ext }));
    state.tracks.push({ id: asset.id, name: asset.name, url, cover: null });
  }
  if (state.trackIndex === -1 && state.tracks.length) playTrack(0); else renderPanel();
}

/* ================= campaigns (persisted natively by Rust, see commands.rs) ================= */
interface Library {
  campaigns: Campaign[];
  current_campaign: string | null;
  token_folders: AssetFolder[];
  map_folders: AssetFolder[];
  token_assets: Record<string, [string, string]>;
  map_assets: Record<string, [string, string]>;
  tracks: [string, string][];
}
function sceneSnapshot() {
  // snake_case keys to match the Rust Scene/Token/etc structs directly (serde).
  return {
    tokens: state.tokens.map(t => ({
      id: t.id, kind: t.kind, asset_id: t.assetId, x: t.x, y: t.y, r: t.r,
      facing: t.facing, light_facing: t.lightFacing, follow_token: t.followToken, cone: t.cone, light: t.light,
      light_offset: { x: t.lightOffset.dx, y: t.lightOffset.dy }, locked: t.locked, flip: t.flip, layer: t.layer,
    })),
    walls: state.walls.map(w => ({ a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } })),
    lights: state.lights.map(l => ({ id: l.id, x: l.x, y: l.y, on: l.on, color: l.color || state.lightColor, intensity: l.intensity ?? 100, radius: l.radius ?? 100 })),
    map_objects: state.mapObjects.map(m => ({ id: m.id, asset_id: m.assetId, x: m.x, y: m.y, w: m.w, h: m.h, rotation: m.rotation, locked: m.locked, layer: m.layer })),
  };
}
async function saveCurrentScene(): Promise<void> {
  if (!sceneDirty) return;
  const revision = sceneRevision;
  try {
    await invoke("save_scene", { scene: sceneSnapshot() });
    if (sceneRevision === revision) sceneDirty = false;
  } catch (e) { console.error("save_scene failed", e); }
}
async function persistMeta(): Promise<void> {
  try {
    for (const cp of state.campaigns) await invoke("rename_campaign", { id: cp.id, name: cp.name });
    await invoke("save_folders", { tokenFolders: state.tokenFolders, mapFolders: state.mapFolders });
  } catch (e) { console.error("persistMeta failed", e); }
}
function loadScene(scene: any): void {
  state.tokens = (scene.tokens || []).map((t: any): Token => ({
    id: t.id, kind: t.kind, assetId: t.asset_id, x: t.x, y: t.y, r: t.r,
    facing: t.facing, facingTarget: t.facing,
    lightFacing: t.light_facing ?? t.facing, lightFacingTarget: t.light_facing ?? t.facing,
    followToken: t.follow_token !== false, cone: t.cone, light: t.light,
    lightOffset: { dx: t.light_offset?.x ?? 0, dy: t.light_offset?.y ?? 0 },
    locked: !!t.locked, flip: !!t.flip, flipScale: t.flip ? -1 : 1,
    layer: t.layer === "back" || t.layer === "front" ? t.layer : "normal", sx: 0, sy: 0,
  }));
  state.walls = (scene.walls || []).map((w: any): Wall => ({ a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } }));
  state.lights = (scene.lights || []).map((l: any): LightPoint => ({ id: l.id, x: l.x, y: l.y, on: l.on, color: l.color, intensity: l.intensity, radius: l.radius, sx: 0, sy: 0 }));
  state.mapObjects = (scene.map_objects || []).map((m: any): MapObject => ({
    id: m.id, assetId: m.asset_id, x: m.x, y: m.y, w: m.w, h: m.h,
    rotation: m.rotation, rotationTarget: m.rotation, locked: m.locked,
    layer: m.layer === "front" || m.layer === "normal" ? m.layer : "back",
  }));
  state.selectedToken = state.tokens[0] ? state.tokens[0].id : null;
  state.selectedWall = null; state.selectedMap = null;
  undoStack = [];
  sceneDirty = false;
  requestRender();
}
async function createCampaign(name: string, keepScene: boolean): Promise<void> {
  await saveCurrentScene();
  const lib = await invoke<Library>("create_campaign", { name, keepScene: !!keepScene });
  state.campaigns = lib.campaigns; state.currentCampaignId = lib.current_campaign;
  const scene = await invoke("load_current_scene");
  loadScene(scene);
}
async function switchCampaign(id: string): Promise<void> {
  await saveCurrentScene();
  const scene = await invoke("switch_campaign", { id });
  state.currentCampaignId = id;
  loadScene(scene);
}

async function exportCurrentCampaign(): Promise<void> {
  await saveCurrentScene();
  const path = await saveDialog({
    defaultPath: `${currentCampaignName()}.vitreus`,
    filters: [{ name: "Vitreus campaign", extensions: ["vitreus"] }],
  });
  if (path) await invoke("export_campaign", { path });
}

async function importCampaignFile(): Promise<void> {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "Vitreus campaign", extensions: ["vitreus"] }],
  });
  if (typeof path !== "string") return;
  await saveCurrentScene();
  const library = await invoke<Library>("import_campaign", { path });
  state.campaigns = library.campaigns;
  state.currentCampaignId = library.current_campaign;
  await hydrateLibraryAssets(library);
  loadScene(await invoke("load_current_scene"));
  renderPanel();
}

async function hydrateLibraryAssets(library: Library): Promise<void> {
  for (const [id, [folderId, fname]] of Object.entries(library.token_assets || {})) {
    if (state.tokenAssets.some(asset => asset.id === id)) continue;
    const ext = fname.split(".").pop()!;
    const url = convertFileSrc(await invoke<string>("asset_path", { id, ext }));
    state.tokenAssets.push({ id, name: fname, folderId, url });
  }
  for (const [id, [folderId, fname]] of Object.entries(library.map_assets || {})) {
    if (state.maps.some(asset => asset.id === id)) continue;
    const ext = fname.split(".").pop()!;
    const url = convertFileSrc(await invoke<string>("asset_path", { id, ext }));
    state.maps.push({ id, name: fname, folderId, url });
  }
  for (const [id, fname] of library.tracks || []) {
    if (state.tracks.some(track => track.id === id)) continue;
    const ext = fname.split(".").pop()!;
    const url = convertFileSrc(await invoke<string>("asset_path", { id, ext }));
    state.tracks.push({ id, name: fname, url, cover: null });
  }
}

/* ================= load persisted data on launch ================= */
(async () => {
  try {
    const lib = await invoke<Library>("get_library");
    state.campaigns = lib.campaigns || []; state.currentCampaignId = lib.current_campaign || null;
    state.tokenFolders = lib.token_folders?.length ? lib.token_folders : state.tokenFolders;
    state.mapFolders = lib.map_folders?.length ? lib.map_folders : state.mapFolders;
    // Asset metadata becomes URLs here; image decoding stays lazy until an
    // asset is visible on the tabletop or library panel.
    await hydrateLibraryAssets(lib);
    const scene = await invoke("load_current_scene");
    loadScene(scene);
    if (state.openTab) renderPanel();
  } catch (e) {
    console.error("startup load failed", e);
  }
})();

addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void saveCurrentScene();
});
