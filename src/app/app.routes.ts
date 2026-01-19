import { Routes } from '@angular/router';
import { ModsPageComponent } from './pages/mods/mods.page';
import { AppLayout } from './layout/component/app.layout';
import { DocumentationPageComponent } from './pages/documentation/documentation.page';
import { DashboardPageComponent } from './pages/dashboard/dashboard.page';
import { LoadoutsPageComponent } from './pages/loadouts/loadouts.page';
import { LogInspectorPageComponent } from './pages/log-inspector/log-inspector.page';
import { ChangelogPageComponent } from './pages/changelog/changelog.page';
import { PlayersPageComponent } from './pages/players/players.page';
import { ModCollectionsPageComponent } from './pages/mod-collections/mod-collections.page';
import { ServerPageComponent } from './pages/server/server.page';

export const routes: Routes = [
  {
    path: '',
    component: AppLayout,
    children: [
      {
        path: '',
        component: ModsPageComponent,
      },
      {
        path: 'dashboard',
        component: DashboardPageComponent,
      },
      {
        path: 'documentation',
        component: DocumentationPageComponent,
      },
      {
        path: 'loadouts',
        component: LoadoutsPageComponent,
      },
      {
        path: 'collections',
        component: ModCollectionsPageComponent,
      },
      {
        path: 'server',
        component: ServerPageComponent,
      },
      // {
      //   path: 'characters',
      //   component: PlayersPageComponent,
      // },
      {
        path: 'log-inspector',
        component: LogInspectorPageComponent,
      },
      {
        path: 'changelog',
        component: ChangelogPageComponent,
      },
    ],
  },
];
