![Honu's Hub Logo](src/assets/honusHub.png?raw=true)

# Honu's Hub

Desktop hub app for Project Zomboid built with Angular (frontend) and Tauri (Rust backend). It focuses on quality-of-life tooling around Workshop mods (metadata, browsing, and local state) and uses the Steam Web API for enrichment.

## Features

- Mod metadata browsing, filtering, and Workshop enrichment
- Server management: create, copy, edit INI/Sandbox variables, manage spawn files, and export server configs
- Character Editor: inspect B42.20 save directories, switch between survivors, edit serialized stats, view decoded traits/gear/location, preview selected Build 42 `.X`/`.FBX` models with installed PNG textures, and create a sibling save copy with a custom folder name

## Tech Stack

- Frontend: Angular + PrimeNG + TailwindCSS
- Desktop shell: Tauri v2
- Data: local-first storage via Tauri Store plugin
- Integrations: Steam Web API, Steam Workshop metadata
- Project Zomboid compatibility: Build 42.20 (world version 249, sandbox version 6)

## Prerequisites

- Node.js (LTS recommended) and npm
- Rust toolchain (stable) and Cargo
- Tauri prerequisites for your OS:
  - Windows: Visual Studio Build Tools (C++), WebView2 runtime
  - macOS: Xcode Command Line Tools
  - Linux: webkit2gtk + build essentials

Reference: https://tauri.app/start/prerequisites/

Angular 21 requires Node.js 20.19+, 22.12+, or 24.0+ and TypeScript 5.9.x. Keep
the game-specific compatibility values in `src/app/models/pz.models.ts` and
`src-tauri/src/pz_compat.rs` synchronized when Project Zomboid changes its
server or save formats.

### Character save inspection

The Character Editor reads `Saves/**/players.db` in the configured Project Zomboid
user directory. It uses the B42.20 `localPlayers`/`networkPlayers` SQLite schema
and the serialized `IsoPlayer` data documented by the decompiled game sources.
The original save is read-only; the copy action creates a new sibling directory
and refuses to overwrite an existing directory.

The 3D preview keeps asset resolution in Rust and only sends the selected
character's media files to the Angular WebView. It uses the game's
`media/models_X/Skinned` meshes, clothing XML model mappings, and PNG textures;
the inspected Build 42.20 installation does not contain `.pak` files, so no PAK
loader is required for the installed character assets. The preview uses the
current Three.js X-loader compatibility adapter for the game's skinned meshes,
composites clothing textures from the save's worn-item identifiers, and exposes
the installed Idle, Walk, Run, and Sit animation clips.

## Local Development

### Install dependencies

```bash
npm install
```

### Run as a desktop app (Tauri dev)

This runs the Angular dev server on `http://localhost:1420` and launches the Tauri shell pointing at it.

```bash
npm run tauri dev
```

### Run as a web app (Angular dev server only)

```bash
npm start
```

## Configuration (Local Instance)

### Steam Web API Key

The app prompts for a Steam Web API key during onboarding and stores it locally on your machine. You can generate a key at:

- https://steamcommunity.com/dev/apikey

If you see `401 Unauthorized` when loading Workshop data, verify the key and try again.

## Modifying the App

### Frontend (Angular)

- App code lives in `src/app`
- Shared styles live in `src/assets/styles.css`
- UI components are built with PrimeNG; app-wide styling uses TailwindCSS

Common workflows:

- Add a page: `src/app/pages/...`
- Add a reusable component: `src/app/components/...`
- Add a service (API/state): `src/app/services/...`

### Desktop Shell / Backend (Tauri)

- Tauri app lives in `src-tauri`
- Main configuration: `src-tauri/tauri.conf.json`
- Rust code: `src-tauri/src`

Useful knobs:

- Window title / sizing: `src-tauri/tauri.conf.json`
- App bundle metadata (name, identifier, icons): `src-tauri/tauri.conf.json`

## Production Builds

### Build the frontend (static dist)

Creates an optimized web build under `dist/`.

```bash
npm run build
```

Tauri is configured to use the Angular output at `dist/pz-honus-hub/browser` (see `src-tauri/tauri.conf.json`).

### Build desktop installers/bundles (Tauri)

Builds a production-ready Tauri app and produces OS-specific artifacts (installer/bundle) under `src-tauri/target/release/bundle/`.

```bash
npm run tauri build
```

Notes:

- Make sure the Tauri prerequisites are installed for your OS (see link above), otherwise the bundle step will fail.
- Code signing is recommended for distribution (platform-specific) but not required for local builds.
- If you distribute unsigned binaries, users may need to take extra install steps depending on OS:
  - Windows: SmartScreen may block the installer/app; use "More info" -> "Run anyway" for trusted builds.
  - macOS: Gatekeeper may block the app; use Finder "Open" on the app, or go to System Settings -> Privacy & Security -> "Open Anyway".
  - Linux: ensure the file is executable (e.g., `chmod +x <app>` or `chmod +x <app>.AppImage`) and allow running it from your file manager.

## Recommended IDE Setup

- VS Code + Tauri extension + rust-analyzer + Angular Language Service
