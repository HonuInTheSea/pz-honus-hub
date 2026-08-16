import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import type { MapEditorTool } from '../map-editor-toolset/map-editor-toolset.component';

export type MapEditorPoiShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'star' | 'pin' | 'arrow';
export type MapEditorPoiSize = 'small' | 'medium' | 'large';
export type MapEditorLinePattern = 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export interface MapEditorSelectOption<T> {
  label: string;
  value: T;
}

export interface MapEditorStyleDraft {
  label: string;
  description: string;
  icon: string;
  shape: MapEditorPoiShape;
  color: string;
  size: MapEditorPoiSize;
  strokeWidth: number;
  linePattern: MapEditorLinePattern;
}

interface MapEditorCoordinate {
  squareX: number;
  squareY: number;
}

@Component({
  selector: 'app-map-editor-inline-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule],
  templateUrl: './map-editor-inline-settings.component.html',
  styleUrl: './map-editor-inline-settings.component.css',
})
export class MapEditorInlineSettingsComponent {
  @Input({ required: true }) mode!: MapEditorTool;
  @Input({ required: true }) draft!: MapEditorStyleDraft;
  @Input() editing = false;
  @Input() pendingCoordinate: MapEditorCoordinate | null = null;
  @Input() iconOptions: readonly MapEditorSelectOption<string>[] = [];
  @Input() shapeOptions: readonly MapEditorSelectOption<MapEditorPoiShape>[] = [];
  @Input() sizeOptions: readonly MapEditorSelectOption<MapEditorPoiSize>[] = [];
  @Input() strokeWidthOptions: readonly MapEditorSelectOption<number>[] = [];
  @Input() linePatternOptions: readonly MapEditorSelectOption<MapEditorLinePattern>[] = [];

  @Output() styleChange = new EventEmitter<void>();

  get isPointTool(): boolean {
    return this.mode === 'point' || this.mode === 'shape';
  }

  get isPathTool(): boolean {
    return this.mode === 'line' || this.mode === 'polygon';
  }

  notifyStyleChange(): void {
    this.styleChange.emit();
  }
}
