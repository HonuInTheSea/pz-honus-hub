import { Injectable } from '@angular/core';

export interface SaveModsParsed {
  modIds: string[];
  mapIds: string[];
}

@Injectable({ providedIn: 'root' })
export class SaveModsImportService {
  parseModsTxt(text: string): SaveModsParsed {
    const normalized = (text ?? '').replace(/\r\n/g, '\n');
    return {
      modIds: this.parseBlock(normalized, 'mods', 'mod'),
      mapIds: this.parseBlock(normalized, 'maps', 'map'),
    };
  }

  private parseBlock(text: string, blockName: string, key: string): string[] {
    const lines = text.split('\n');
    const startIdx = lines.findIndex((l) => l.trim() === blockName);
    if (startIdx < 0) {
      return [];
    }

    const openIdx = lines
      .slice(startIdx + 1)
      .findIndex((l) => l.trim().startsWith('{'));
    if (openIdx < 0) {
      return [];
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = startIdx + 1 + openIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }
      if (line.startsWith('}')) {
        break;
      }

      const match = new RegExp(
        `^${key}\\s*=\\s*\\\\([^,}]+)`,
        'i',
      ).exec(line);
      if (!match) {
        continue;
      }

      const id = (match[1] ?? '').trim();
      if (!id) {
        continue;
      }
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }
}

