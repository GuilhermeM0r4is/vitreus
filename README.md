# Vitreus — Tauri v2 desktop app

Rust backend (state, persistence, asset import, line-of-sight raycasting) +
a TypeScript/Canvas frontend built with Vite, wrapped by Tauri v2.

## Why TypeScript

The frontend and the Rust backend share a data model (tokens, walls, lights,
map objects, the campaign library) that crosses the JS↔Rust boundary via
serde JSON. That boundary is exactly where a typo in a field name becomes a
silent runtime bug instead of a compile error — TS interfaces for `Token`,
`Wall`, `Scene`, `Library`, etc. catch that class of mistake before you ever
run the app. It also matches what Tauri's own tooling expects by default
(Vite + TS), rather than fighting it with raw `<script>` tags.

## What's verified vs. what isn't

**Verified by actually running real tools in this environment:**
- `src-tauri/src/lighting.rs` — the visibility-polygon raycasting engine,
  including a regression test for the exact wall-blocking sign bug found
  and fixed in the HTML prototype. `cargo test`: 3/3 pass, zero warnings.
- `src-tauri/src/state.rs` — the scene/campaign/library data model compiles
  cleanly against those tests.
- `src/main.ts` — the entire frontend type-checks with `npx tsc --noEmit`
  under `strict: true` (plus `noUnusedLocals`/`noUnusedParameters`): zero
  errors. This doesn't prove the UI behaves correctly, but it does prove
  every function signature, DOM cast, and the Rust-facing payload shapes
  are internally consistent.

**Not verified by compiling here — needs your machine:**
- The actual Tauri binary (`main.rs`, `commands.rs`, `tauri.conf.json`,
  `capabilities/default.json`). This sandbox's package manager only has an
  old Rust (1.75) and no macOS SDK / WebKit, so `cargo tauri build` can't
  run here at all. The Tauri API usage (commands, managed state, the
  dialog plugin, the asset protocol) is written to the documented Tauri v2
  shape, but exact plugin permission strings and command signatures are
  the most likely spot to need a small fix once you actually build it.

Given that, **Claude Code running locally on your Mac** is the right tool
to take this the rest of the way — it can install the toolchain, run real
builds, read the actual compiler errors, and iterate. I'd treat this
scaffold as a strong, working starting point rather than a finished binary.

## Setup

```bash
# 1. Rust (use rustup, not an OS package manager — Tauri needs a recent toolchain)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Node deps (Vite, TypeScript, the Tauri CLI, @tauri-apps/api, the dialog plugin)
npm install

# 3. Tauri's macOS prerequisites
xcode-select --install

# 4. Run it — this starts the Vite dev server (hot reload) and opens the
#    native window automatically, per the beforeDevCommand in tauri.conf.json
npm run tauri dev
```

Useful on their own while iterating on just the UI:
```bash
npm run dev          # Vite dev server alone (browser, no native APIs)
npx tsc --noEmit      # type-check only, what I verified above
```

## Build a .app / .dmg

```bash
npx @tauri-apps/cli icon path/to/a-1024x1024-source-icon.png   # generates src-tauri/icons/*
npm run tauri build
```

## Project layout

```
src-tauri/
  src/
    main.rs        - app entry, registers commands + the dialog plugin
    commands.rs     - persistence, asset import, compute_visibility_batch bridge
    lighting.rs     - the raycasting engine (tested, see above)
    state.rs        - Scene/Token/Wall/Light/MapObject/Library structs
  capabilities/
    default.json    - Tauri v2 permission grants for the main window
  tauri.conf.json
  Cargo.toml
index.html          - the UI shell (ported from the HTML prototype)
src/
  main.ts           - all UI logic, typed; IndexedDB + in-JS raycasting
                      replaced by invoke() calls into Rust
  style.css         - the UI's styling, unchanged from the prototype
tsconfig.json       - strict mode, noUnusedLocals/Parameters on
vite.config.ts
package.json        - Vite, TypeScript, Tauri CLI, @tauri-apps/api, dialog plugin
```

## Second optimization pass

Two real issues found by actually reading the data flow, both fixed and
re-verified (`cargo test`, `npx tsc --noEmit`):

1. **Rust was redoing O(walls²) work per light, per frame-update.** Every
   active light's visibility call independently recomputed where every pair
   of walls crosses — that computation doesn't depend on the light at all,
   only on the wall set. With N lights that's N× the necessary work, plus
   N separate IPC round-trips. `compute_visibility` → `compute_visibility_batch`:
   one call per update covering every light, wall-wall intersections
   computed once and shared. Added a test
   (`shared_wall_intersections_match_per_light_recompute`) proving the
   shared-computation path gives bit-identical results to recomputing per
   light, not just faster-but-maybe-different results.

2. **Panning the camera was triggering a full Rust re-raycast.** The old
   per-frame "did anything change" signature included `camera.x`/`camera.y`,
   so every drag-to-pan frame looked like new geometry and kicked off an
   async backend call + full fog rebuild — even though panning doesn't move
   anything in world space, only the screen projection. Split this into two
   signatures: `worldSignature()` (tokens/lights/walls + zoom, since zoom
   does change a light's world-space reach) triggers the expensive Rust
   call; a separate cheap check (camera position + darkness only) triggers
   a local, synchronous fog reprojection using whatever world polygons are
   already cached. Panning now never touches Rust.

   Smaller, same vein: `worldSignature()` itself used to build a string via
   repeated concatenation every single frame just to compare "did anything
   change" — replaced with a numeric rolling hash (no allocation at all).

One thing worth flagging honestly: while re-resolving dependencies here,
`cargo test` pulled in a transitive package called `zmij` (via a recent
`serde_json`) that I didn't recognize by name. I checked rather than assumed
— it's a legitimate, maintainer-published dependency (confirmed via
docs.rs), just released after my training cutoff. Worth being the kind of
thing you glance at in `Cargo.lock` after a fresh `cargo build` on your end
too, as a general habit rather than because anything here is actually wrong.

## Cleanup / performance pass done on this version

- Deleted the JS-side raycasting (`segIntersect`, `segSegIntersect`,
  `castRay`, `visibilityPoly360`) entirely — it was dead code once
  `compute_visibility_batch` moved to Rust, kept around in an earlier version
  as a fallback reference. Gone now, nothing calls it.
- The render loop used to make 3-4 separate `forEach` passes over
  `state.tokens` per frame (one to animate rotation/flip, one to compute
  screen position, one to collect active lights) plus 2 over
  `state.mapObjects`. Merged into one pass per array — same work, fewer
  loop/closure setups per frame.
- `activeLights` was a fresh array literal allocated every frame; it's now
  a module-level array cleared with `.length = 0` and reused, cutting one
  GC allocation per frame (small on its own, free to do alongside the loop
  merge above).
- The heavy part — ray-casting against walls — already only runs when the
  camera/tokens/lights/walls actually changed since the previous frame
  (see `geomSignature` in `main.ts`); that caching carried over unchanged
  from the HTML version, it was already the main lever.

I did *not* add spatial indexing (quadtree/grid) for hit-testing or for the
wall list, even though the original brief mentions it. At the token/wall
counts a VTT session actually has (tens, not thousands), a linear scan is
not measurably slower than a spatial structure, and adding one here without
being able to profile against a real scene risks solving a problem that
doesn't exist while adding real complexity. If a session ends up with
hundreds of walls, that's the first place I'd revisit.

## What moved from the browser prototype into Rust, and why

- **Persistence**: was IndexedDB, now JSON files under the OS app-data
  directory, written by `commands.rs`. Survives reinstalls of the webview
  cache; inspectable/debuggable as plain files.
- **Asset import**: was reading files into memory as base64 in JS, now a
  native file dialog + `std::fs::copy` into a managed assets folder, served
  back to the webview via Tauri's `asset://` protocol. The image/audio
  bytes never cross the JS↔Rust IPC boundary.
- **Line-of-sight raycasting**: was the per-frame JS `visibilityPoly360`,
  now `compute_visibility_batch` in Rust (one call covering every active light, not one per light), called asynchronously from the render
  loop and cached (same "only recompute when something moved" strategy as
  the prototype's last version) so the 60fps canvas loop never blocks on
  the IPC round-trip.
- **Everything else** (panning/zooming, the panel UI, token/wall/light
  editing, the render loop itself) stayed in the webview — it's UI work,
  not something that benefits from being native.
