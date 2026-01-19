declare module '@tauri-apps/plugin-dialog' {
  export interface OpenDialogOptions {
    directory?: boolean;
    multiple?: boolean;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }

  export function open(
    options?: OpenDialogOptions,
  ): Promise<string | string[] | null>;
}

declare module '@tauri-apps/plugin-opener' {
  export function openUrl(url: string | URL, openWith?: 'inAppBrowser' | string): Promise<void>;
  export function openPath(path: string, openWith?: string): Promise<void>;
  export function revealItemInDir(path: string | string[]): Promise<void>;
}

declare module '@tauri-apps/api/dialog' {
  export interface OpenDialogOptions {
    directory?: boolean;
    multiple?: boolean;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }

  export function open(
    options?: OpenDialogOptions,
  ): Promise<string | string[] | null>;
}
