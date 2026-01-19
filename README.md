# Honu's Hub

Desktop hub app for Project Zomboid built with Angular (frontend) and Tauri (Rust backend). It focuses on quality-of-life tooling around Workshop mods (metadata, browsing, and local state) and uses the Steam Web API for enrichment.

## Tech Stack

- Frontend: Angular + PrimeNG + TailwindCSS
- Desktop shell: Tauri v2
- Data: local-first storage via Tauri Store plugin
- Integrations: Steam Web API, Steam Workshop metadata

## Prerequisites

- Node.js (LTS recommended) and npm
- Rust toolchain (stable) and Cargo
- Tauri prerequisites for your OS:
  - Windows: Visual Studio Build Tools (C++), WebView2 runtime
  - macOS: Xcode Command Line Tools
  - Linux: webkit2gtk + build essentials

Reference: https://tauri.app/start/prerequisites/

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
- Shared styles live in `src/assets/styles.scss`
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

## Recommended IDE Setup

- VS Code + Tauri extension + rust-analyzer + Angular Language Service
