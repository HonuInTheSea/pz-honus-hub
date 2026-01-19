// Local stub for @primeuix/themes until the real package is available.

export type ThemePreset = any;

export const Aura: ThemePreset = {};
export const Lara: ThemePreset = {};
export const Nora: ThemePreset = {};

export function $t() {
    return {
        preset(_preset: any) {
            return this;
        },
        surfacePalette(_palette: any) {
            return this;
        },
        use(_options: any) {
            return this;
        }
    };
}

export function updatePreset(_preset: any): void {
    // no-op stub
}

export function updateSurfacePalette(_palette: any): void {
    // no-op stub
}

