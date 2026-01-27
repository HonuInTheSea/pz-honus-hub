import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimelineModule } from 'primeng/timeline';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { ScrollTopModule } from 'primeng/scrolltop';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';

type ChangelogEvent = Readonly<{
  statusKey: string;
  versionKey: string;
  dateKey: string;
  icon: string;
  color: string;
  descriptionKey: string;
}>;

@Component({
  selector: 'app-changelog-page',
  standalone: true,
  imports: [CommonModule, TimelineModule, CardModule, ButtonModule, ScrollTopModule, TranslocoModule],
  templateUrl: './changelog.page.html',
})
export class ChangelogPageComponent {
  readonly events: ChangelogEvent[] = [
    {
      statusKey: 'changelog.events.newFeature_0_5_0.title',
      versionKey: 'changelog.events.newFeature_0_5_0.version',
      dateKey: 'changelog.events.newFeature_0_5_0.date',
      icon: 'pi pi-star',
      color: 'var(--orange-500)',
      descriptionKey: 'changelog.events.newFeature_0_5_0.description',
    },
    {
      statusKey: 'changelog.events.minorFixes_0_4_3.title',
      versionKey: 'changelog.events.minorFixes_0_4_3.version',
      dateKey: 'changelog.events.minorFixes_0_4_3.date',
      icon: 'pi pi-wrench',
      color: 'var(--blue-500)',
      descriptionKey: 'changelog.events.minorFixes_0_4_3.description',
    },
    {
      statusKey: 'changelog.events.minorFixes_0_4_1.title',
      versionKey: 'changelog.events.minorFixes_0_4_1.version',
      dateKey: 'changelog.events.minorFixes_0_4_1.date',
      icon: 'pi pi-wrench',
      color: 'var(--blue-500)',
      descriptionKey: 'changelog.events.minorFixes_0_4_1.description',
    },
    {
      statusKey: 'changelog.events.initialRelease.title',
      versionKey: 'changelog.events.initialRelease.version',
      dateKey: 'changelog.events.initialRelease.date',
      icon: 'pi pi-flag',
      color: 'var(--green-500)',
      descriptionKey: 'changelog.events.initialRelease.description',
    },
  ];

  constructor(private readonly transloco: TranslocoService) {}

  formatChangelogDate(dateKey: string): string {
    const raw = (this.transloco.translate(dateKey) ?? '').trim();
    if (!raw) {
      return raw;
    }
    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = isoMatch
      ? new Date(
          Number(isoMatch[1]),
          Number(isoMatch[2]) - 1,
          Number(isoMatch[3]),
        )
      : new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return raw;
    }
    const locale = this.transloco.getActiveLang() || 'en-US';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(parsed);
  }
}
