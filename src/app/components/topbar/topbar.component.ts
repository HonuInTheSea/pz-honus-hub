import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { LayoutService } from '../../layout/service/layout.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [ButtonModule, CommonModule],
  templateUrl: './topbar.component.html',
})
export class TopbarComponent {
  constructor(
    public readonly layout: LayoutService,
  ) {}

  toggleTheme(): void {
    this.layout.layoutConfig.update((state) => ({
      ...state,
      darkTheme: !state.darkTheme,
    }));
  }
}
