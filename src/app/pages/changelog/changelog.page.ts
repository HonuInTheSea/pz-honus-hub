import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimelineModule } from 'primeng/timeline';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { ScrollTopModule } from 'primeng/scrolltop';
import { TranslocoModule } from '@jsverse/transloco';

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
      statusKey: 'changelog.events.initialRelease.title',
      versionKey: 'changelog.events.initialRelease.version',
      dateKey: 'changelog.events.initialRelease.date',
      icon: 'pi pi-flag',
      color: 'var(--green-500)',
      descriptionKey: 'changelog.events.initialRelease.description',
    },
  ];
}
