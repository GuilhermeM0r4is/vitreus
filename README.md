# Vitreus
> A fast, ultra-lightweight, gridless Virtual Tabletop (VTT) simulator designed for Game Masters who demand performance, atmosphere, and simplicity.

**Vitreus** combines the quick, portable workflow of modern VTTs with dark, immersive dynamic lighting—wrapped in a native macOS liquid-glass aesthetic. Built from the ground up to run silently on fanless hardware (like the MacBook Air) with near-zero CPU and memory overhead.

---

## Key Features

- **Liquid Glass Interface:** macOS-native aesthetic featuring sleek, translucent floating toolbars over an active rendering canvas.
- **Ultra-Low Overhead:** Built on **Rust** and **Tauri v2** to idle under 50MB RAM with zero fan spin.
- **Dynamic Lighting & Shadow Cones:** Dynamic shadow-casting walls, flashlights, directional light cones, and absolute pitch-black darkness zones.
- **Native Gridless Engine:** Smooth 2D continuous floating-point movement—no rigid grids or unnatural snapping unless you want them.
- **100% Client-Side & Local:** No servers, hosting fees, or account logins. Runs entirely offline directly from your local files.
- **Local Audio Player:** Built-in ambient soundscape and music player for local `.mp3`, `.wav`, and `.ogg` files with track looping.
- **Instant Drag-and-Drop:** Seamlessly import local maps (`.png`, `.jpg`, `.webp`) and tokens in seconds.

---

## Tech Stack
- **Backend / Engine:** [Rust](https://www.rust-lang.org/) (Spatial calculations, dynamic raycasting, local file I/O)
- **Desktop Container:** [Tauri v2](https://v2.tauri.app/) (macOS native WKWebView wrapper)
- **Renderer:** WebGL / HTML5 Canvas (60 FPS hardware-accelerated rendering)

---

## Getting Started
### Prerequisites
- [Rust toolchain](https://www.rust-lang.org/tools/install)
- [Node.js](https://nodejs.org/) (for frontend dependencies)

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/GuilhermeM0r4is/Vitreus
cd vitreus

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev
