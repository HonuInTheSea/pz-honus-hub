import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import packageJson from '../../../package.json';

type GithubLatestReleaseResponse = Readonly<{
  tag_name?: string;
}>;

@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  readonly currentVersion = packageJson.version;
  readonly latestTagName = signal<string | null>(null);
  readonly updateAvailable = signal(false);

  private checked = false;

  constructor(private readonly http: HttpClient) {}

  async checkForUpdate(): Promise<void> {
    if (this.checked) return;
    this.checked = true;

    try {
      const response = await firstValueFrom(
        this.http.get<GithubLatestReleaseResponse>(
          'https://api.github.com/repos/HonuInTheSea/pz-honus-hub/releases/latest',
          { headers: { Accept: 'application/vnd.github+json' } },
        ),
      );

      const tagName = (response?.tag_name ?? '').trim();
      if (!tagName) return;

      this.latestTagName.set(tagName);
      this.updateAvailable.set(
        compareVersions(tagName, this.currentVersion) > 0,
      );
    } catch {
      // Ignore update check failures (offline / rate-limited / etc).
    }
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

function compareVersions(a: string, b: string): number {
  const normalizedA = normalizeVersion(a);
  const normalizedB = normalizeVersion(b);

  const [coreA, preA] = normalizedA.split('-', 2);
  const [coreB, preB] = normalizedB.split('-', 2);

  const partsA = coreA.split('.').map((part) => Number.parseInt(part, 10));
  const partsB = coreB.split('.').map((part) => Number.parseInt(part, 10));

  const maxLen = Math.max(partsA.length, partsB.length, 3);
  for (let index = 0; index < maxLen; index += 1) {
    const valueA = Number.isFinite(partsA[index]) ? partsA[index] : 0;
    const valueB = Number.isFinite(partsB[index]) ? partsB[index] : 0;
    if (valueA > valueB) return 1;
    if (valueA < valueB) return -1;
  }

  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return 0;
}

