import { CommonModule } from '@angular/common';
import { Component, ContentChild, EventEmitter, Input, Output, TemplateRef } from '@angular/core';
import { ButtonModule } from 'primeng/button';

export type MapEditorTool = 'point' | 'shape' | 'text' | 'line' | 'polygon';
export type MapEditorMode = MapEditorTool | 'edit';

/**
 * Controls which parts of the map editor affordance are exposed.
 *
 * The tool list is deliberately data-driven so new Doodle-style tools (for
 * example rectangle, circle, or arrow) can be added without changing the
 * component's public event contract.
 */
export interface MapEditorToolsetOptions {
  tools?: readonly MapEditorTool[];
  allowVertexEditing?: boolean;
  allowDelete?: boolean;
  readOnly?: boolean;
  showStatus?: boolean;
  showHelp?: boolean;
  showFinish?: boolean;
  showCancel?: boolean;
}

interface ToolDefinition {
  value: MapEditorTool;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-map-editor-toolset',
  standalone: true,
  imports: [CommonModule, ButtonModule],
  templateUrl: './map-editor-toolset.component.html',
  styleUrl: './map-editor-toolset.component.css',
})
export class MapEditorToolsetComponent {
  @Input() options: MapEditorToolsetOptions = {};
  @Input() mode: MapEditorMode | null = null;
  @Input() message = '';
  @Input() disabled = false;
  @Input() finishLabel = 'Save shape';
  @Input() finishDisabled = false;

  @ContentChild('mapEditorCustomization', { read: TemplateRef })
  customizationTemplate?: TemplateRef<unknown>;

  @Output() toolSelected = new EventEmitter<MapEditorTool>();
  @Output() finish = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  readonly toolDefinitions: readonly ToolDefinition[] = [
    { value: 'point', label: 'Add point', icon: 'pi pi-map-marker' },
    { value: 'shape', label: 'Add shape', icon: 'pi pi-pencil' },
    { value: 'text', label: 'Add text', icon: 'pi pi-align-left' },
    { value: 'line', label: 'Draw line', icon: 'pi pi-minus' },
    { value: 'polygon', label: 'Draw polygon', icon: 'pi pi-stop' },
  ];

  get configuredTools(): readonly ToolDefinition[] {
    const configured = this.options.tools;
    if (!configured) {
      return this.toolDefinitions;
    }
    return this.toolDefinitions.filter((tool) => configured.includes(tool.value));
  }

  get readOnly(): boolean {
    return this.options.readOnly === true;
  }

  get showStatus(): boolean {
    return this.options.showStatus !== false && this.mode !== null;
  }

  get showHelp(): boolean {
    return this.options.showHelp !== false;
  }

  get showFinish(): boolean {
    if (this.options.showFinish === false || !this.mode || this.mode === 'edit') {
      return false;
    }
    return this.options.allowVertexEditing !== false ||
      (this.mode !== 'line' && this.mode !== 'polygon');
  }

  get showCancel(): boolean {
    return this.options.showCancel !== false && this.mode !== null;
  }

  get modeLabel(): string {
    if (this.mode === 'edit') {
      return 'Editing shape vertices';
    }
    if (this.mode === 'point') {
      return 'Adding point';
    }
    if (this.mode === 'shape') {
      return 'Adding shape';
    }
    return this.mode ? `Drawing ${this.mode}` : '';
  }

  isToolDisabled(): boolean {
    return this.disabled || this.readOnly;
  }

  selectTool(tool: MapEditorTool): void {
    if (this.isToolDisabled()) {
      return;
    }
    this.toolSelected.emit(tool);
  }
}
