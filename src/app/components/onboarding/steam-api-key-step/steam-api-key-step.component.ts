import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { AccordionModule } from 'primeng/accordion';
import { TranslocoModule } from '@jsverse/transloco';

@Component({
  selector: 'app-steam-api-key-step',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    InputTextModule,
    ButtonModule,
    CardModule,
    PanelModule,
    AccordionModule,
    TranslocoModule,
  ],
  templateUrl: './steam-api-key-step.component.html',
})
export class SteamApiKeyStepComponent {
  @Input({ required: true }) steamApiKey = '';
  @Output() steamApiKeyChange = new EventEmitter<string>();
  steamApiKeyHelpDialogVisible = false;
}
