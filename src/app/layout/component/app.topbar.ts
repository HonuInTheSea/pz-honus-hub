import { Component } from '@angular/core';
import { MenuItem } from 'primeng/api';
import { RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { StyleClassModule } from 'primeng/styleclass';
import { LayoutService } from '../service/layout.service';
import packageJson from '../../../../package.json';
import { TagModule } from 'primeng/tag';
import { AppUpdateService } from '../../services/app-update.service';
import { TranslocoModule } from '@jsverse/transloco';

@Component({
    selector: 'app-topbar',
    standalone: true,
  imports: [RouterModule, CommonModule, StyleClassModule, TagModule, TranslocoModule],
    templateUrl: './app.topbar.html'})
export class AppTopbar {
    items!: MenuItem[];
    readonly version = packageJson.version;

    constructor(
        public layoutService: LayoutService,
        public readonly appUpdate: AppUpdateService,
    ) {}
}
