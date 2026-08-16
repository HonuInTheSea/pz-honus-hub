import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { MessageService } from 'primeng/api';
import { PanelModule } from 'primeng/panel';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TauriStoreService } from '../../services/tauri-store.service';
import { PzDefaultPathsService } from '../../services/pz-default-paths.service';
import { CharacterEditorService } from '../../services/character-editor.service';
import { CharacterPreviewComponent } from '../../components/character-preview/character-preview.component';
import { CharacterOptionPickerComponent } from '../../components/character-option-picker/character-option-picker.component';
import type {
  CharacterDetails,
  CharacterCustomizationOption,
  CharacterCustomizationOptions,
  CharacterSkill,
  CharacterVisualItem,
  CharacterSaveSlot,
  CharacterSaveSnapshot,
} from '../../models/character.models';

interface SkillGroup {
  category: string;
  skills: CharacterSkill[];
}

type CharacterPanelId =
  | 'save-directories'
  | 'preview'
  | 'customization'
  | 'identity'
  | 'info'
  | 'visual-features'
  | 'traits'
  | 'skills'
  | 'protection'
  | 'temperature'
  | 'needs-moodles'
  | 'loadout';

type PanelColumnId = 'left' | 'center' | 'right';

interface CharacterPanelLayout {
  left: CharacterPanelId[];
  center: CharacterPanelId[];
  right: CharacterPanelId[];
}

interface PanelColumnDefinition {
  id: PanelColumnId;
  label: string;
}

interface PanelPointerDragState {
  panel: CharacterPanelId;
  startX: number;
  startY: number;
  active: boolean;
}

@Component({
  selector: 'app-character-editor-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    DialogModule,
    InputTextModule,
    MessageModule,
    PanelModule,
    ProgressSpinnerModule,
    TagModule,
    ToastModule,
    CharacterPreviewComponent,
    CharacterOptionPickerComponent,
  ],
  providers: [MessageService],
  templateUrl: './character-editor.page.html',
  styleUrl: './character-editor.page.css',
})
export class CharacterEditorPageComponent implements OnInit {
  private readonly panelLayoutKey = 'character_editor_panel_layout';
  private readonly defaultPanelLayout: CharacterPanelLayout = {
    left: ['save-directories', 'identity', 'traits'],
    center: ['preview', 'customization', 'skills', 'needs-moodles'],
    right: ['info', 'visual-features', 'loadout', 'protection', 'temperature'],
  };

  readonly panelColumns: PanelColumnDefinition[] = [
    { id: 'left', label: 'Left column' },
    { id: 'center', label: 'Center column' },
    { id: 'right', label: 'Right column' },
  ];

  panelLayout: CharacterPanelLayout = this.clonePanelLayout(this.defaultPanelLayout);
  draggedPanel: CharacterPanelId | null = null;
  dropTarget: string | null = null;
  private pointerDrag: PanelPointerDragState | null = null;
  userDir = '';
  gameDir = '';
  customizationOptions: CharacterCustomizationOptions | null = null;
  visualRevision = 0;
  slots: CharacterSaveSlot[] = [];
  snapshot: CharacterSaveSnapshot | null = null;
  selectedCharacter: CharacterDetails | null = null;
  selectedSlotPath = '';
  loading = false;
  copyVisible = false;
  copyName = '';
  deleteVisible = false;
  deleteSlot: CharacterSaveSlot | null = null;
  statsDirty = false;

  constructor(
    private readonly store: TauriStoreService,
    private readonly defaults: PzDefaultPathsService,
    private readonly editor: CharacterEditorService,
    private readonly messages: MessageService,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.loadPanelLayout();
    this.userDir = (await this.store.getItem<string>('pz_user_dir')) ?? '';
    this.gameDir = (await this.store.getItem<string>('pz_game_dir')) ?? await this.defaults.getDefaultGameDir();
    if (!this.userDir) {
      this.userDir = await this.defaults.getDefaultUserDirExample();
    }
    await this.loadCustomizationOptions('Male');
    await this.refreshSlots();
  }

  columnPanels(column: PanelColumnId): CharacterPanelId[] {
    return this.panelLayout[column];
  }

  panelLabel(panel: CharacterPanelId): string {
    return {
      'save-directories': 'Save Directories',
      preview: 'Character Preview',
      customization: 'Customize Character',
      identity: 'Identity and Location',
      info: 'Info',
      'visual-features': 'Visual Features',
      traits: 'Traits',
      skills: 'Skills',
      protection: 'Protection',
      temperature: 'Temperature',
      'needs-moodles': 'Needs and Moodles',
      loadout: 'Loadout',
    }[panel];
  }

  beginPanelPointerDrag(event: PointerEvent, panel: CharacterPanelId): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.pointerDrag = {
      panel,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    this.dropTarget = null;
  }

  @HostListener('document:pointermove', ['$event'])
  movePanelPointer(event: PointerEvent): void {
    const drag = this.pointerDrag;
    if (!drag) return;

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance < 5) return;
    drag.active = true;
    this.draggedPanel = drag.panel;
    event.preventDefault();

    const target = this.pointerDropTarget(event);
    this.dropTarget = target ? `${target.column}:${target.index}` : null;
  }

  @HostListener('document:pointerup', ['$event'])
  endPanelPointerDrag(event: PointerEvent): void {
    const drag = this.pointerDrag;
    if (!drag) return;
    event.preventDefault();
    this.pointerDrag = null;

    if (!drag.active) {
      this.draggedPanel = null;
      this.dropTarget = null;
      return;
    }

    const target = this.pointerDropTarget(event);
    if (target) this.movePanel(drag.panel, target.column, target.index);
    else this.cancelPanelPointerDrag();
  }

  @HostListener('document:pointercancel')
  cancelPanelPointerDrag(): void {
    this.pointerDrag = null;
    this.draggedPanel = null;
    this.dropTarget = null;
  }

  private pointerDropTarget(event: PointerEvent): { column: PanelColumnId; index: number } | null {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!(element instanceof HTMLElement)) return null;

    const shell = element.closest<HTMLElement>('[data-panel-shell]');
    if (shell) {
      const column = this.panelColumnId(shell.dataset['panelColumn']);
      const index = Number(shell.dataset['panelIndex']);
      if (column && Number.isInteger(index)) {
        const bounds = shell.getBoundingClientRect();
        return { column, index: event.clientY >= bounds.top + bounds.height / 2 ? index + 1 : index };
      }
    }

    const columnElement = element.closest<HTMLElement>('[data-panel-column]');
    const column = this.panelColumnId(columnElement?.dataset['panelColumn']);
    return column ? { column, index: this.columnPanels(column).length } : null;
  }

  private movePanel(panel: CharacterPanelId, targetColumn: PanelColumnId, targetIndex: number): void {
    const next = this.clonePanelLayout(this.panelLayout);
    const sourceColumn = this.panelColumns.find(({ id }) => next[id].includes(panel))?.id;
    if (!sourceColumn) return;
    const sourceIndex = next[sourceColumn].indexOf(panel);
    next[sourceColumn].splice(sourceIndex, 1);
    if (sourceColumn === targetColumn && sourceIndex < targetIndex) targetIndex--;
    next[targetColumn].splice(Math.max(0, Math.min(targetIndex, next[targetColumn].length)), 0, panel);

    this.panelLayout = next;
    this.draggedPanel = null;
    this.dropTarget = null;
    void this.store.setItem(this.panelLayoutKey, next);
  }

  resetPanelLayout(): void {
    this.panelLayout = this.clonePanelLayout(this.defaultPanelLayout);
    void this.store.setItem(this.panelLayoutKey, this.panelLayout);
  }

  loadoutLabel(item: CharacterVisualItem): string {
    return this.label(item.clothingName || item.fullType);
  }

  loadoutSlot(item: CharacterVisualItem): string {
    return this.itemSlot(item) ?? 'Gear';
  }

  async refreshSlots(): Promise<void> {
    this.loading = true;
    try {
      this.slots = await this.editor.listSaveSlots(this.userDir);
      if (this.selectedSlotPath && this.slots.some((slot) => slot.relativePath === this.selectedSlotPath)) {
        await this.selectSlot(this.selectedSlotPath);
      } else if (this.slots[0]) {
        await this.selectSlot(this.slots[0].relativePath);
      } else {
        this.snapshot = null;
        this.selectedCharacter = null;
      }
    } catch (error) {
      this.notifyError('Unable to read save directories', error);
    } finally {
      this.loading = false;
    }
  }

  async selectSlot(relativePath: string): Promise<void> {
    this.selectedSlotPath = relativePath;
    this.loading = true;
    try {
      this.snapshot = await this.editor.readSave(this.userDir, relativePath, this.gameDir);
      this.selectedCharacter = this.snapshot.characters[0] ?? null;
      if (this.selectedCharacter) {
        await this.loadCustomizationOptions(this.selectedCharacter.visuals.gender);
      }
      this.statsDirty = false;
    } catch (error) {
      this.notifyError('Unable to read character data', error);
    } finally {
      this.loading = false;
    }
  }

  selectCharacter(character: CharacterDetails): void {
    this.selectedCharacter = character;
    this.statsDirty = false;
    void this.loadCustomizationOptions(character.visuals.gender);
  }

  selectCharacterById(id: number): void {
    const character = this.snapshot?.characters.find((candidate) => candidate.summary.id === id);
    if (character) this.selectCharacter(character);
  }

  async loadCustomizationOptions(gender: string): Promise<void> {
    if (!this.gameDir) return;
    try {
      this.customizationOptions = await this.editor.loadCustomizationOptions(this.gameDir, gender);
    } catch (error) {
      this.notifyError('Unable to load character customization options', error);
    }
  }

  updateVisuals(character: CharacterDetails, changes: Partial<CharacterDetails['visuals']>): void {
    this.selectedCharacter = {
      ...character,
      visuals: { ...character.visuals, ...changes },
    };
    this.visualRevision++;
    this.statsDirty = true;
  }

  updateName(character: CharacterDetails, field: 'forename' | 'surname', value: string): void {
    const next = { ...character, [field]: value || null };
    const name = [next.forename, next.surname].filter(Boolean).join(' ').trim() || character.summary.name;
    this.selectedCharacter = { ...next, summary: { ...character.summary, name } };
    this.statsDirty = true;
  }

  clothingSlots(): string[] {
    return ['Belt', 'Hat', 'Glasses', 'Vest', 'Shirt', 'T-shirt', 'Pants', 'Skirt', 'Dress', 'Socks', 'Shoes', 'Necklace', 'Mask'];
  }

  clothingOptions(slot: string): CharacterCustomizationOption[] {
    return this.customizationOptions?.clothing.filter((option) => option.slot === slot) ?? [];
  }


  clothingId(character: CharacterDetails, slot: string): string {
    return character.visuals.items.find((item) => this.itemSlot(item) === slot)?.clothingName ?? '';
  }

  updateClothing(character: CharacterDetails, slot: string, clothingName: string): void {
    const items = character.visuals.items.filter((item) => this.itemSlot(item) !== slot);
    if (clothingName) {
      items.push({
        fullType: `Base.${clothingName}`,
        clothingName,
        alternateModel: null,
        baseTexture: null,
        textureChoice: null,
      });
    }
    this.updateVisuals(character, { items, clothing: items.map((item) => item.fullType) });
  }

  private itemSlot(item: CharacterVisualItem): string | null {
    const key = (item.clothingName ?? item.fullType).toLowerCase();
    if (key.includes('mask') || key.includes('respirator')) return 'Mask';
    if (key.includes('belt')) return 'Belt';
    if (key.includes('hat') || key.includes('bandana') || key.includes('beanie')) return 'Hat';
    if (key.includes('glass') || key.includes('eyewear')) return 'Glasses';
    if (key.includes('vest')) return 'Vest';
    if (key.includes('tshirt') || key.includes('tanktop')) return 'T-shirt';
    if (key.includes('shirt') || key.includes('jumper') || key.includes('sweater')) return 'Shirt';
    if (key.includes('trouser') || key.includes('jean') || key.includes('pants')) return 'Pants';
    if (key.includes('skirt')) return 'Skirt';
    if (key.includes('dress')) return 'Dress';
    if (key.includes('sock') || key.includes('stocking')) return 'Socks';
    if (key.includes('shoe') || key.includes('boot') || key.includes('sneaker')) return 'Shoes';
    if (key.includes('necklace') || key.includes('scarf')) return 'Necklace';
    return null;
  }

  private async loadPanelLayout(): Promise<void> {
    const stored = await this.store.getItem<Partial<CharacterPanelLayout>>(this.panelLayoutKey);
    this.panelLayout = this.normalizePanelLayout(stored);
  }

  private normalizePanelLayout(stored: Partial<CharacterPanelLayout> | null): CharacterPanelLayout {
    const next: CharacterPanelLayout = { left: [], center: [], right: [] };
    const seen = new Set<CharacterPanelId>();
    const panelIds = new Set<CharacterPanelId>(this.allPanelIds());

    for (const column of this.panelColumns) {
      const candidate = stored?.[column.id];
      if (!Array.isArray(candidate)) continue;
      for (const panel of candidate) {
        if (panelIds.has(panel as CharacterPanelId) && !seen.has(panel as CharacterPanelId)) {
          next[column.id].push(panel as CharacterPanelId);
          seen.add(panel as CharacterPanelId);
        }
      }
    }

    for (const column of this.panelColumns) {
      for (const panel of this.defaultPanelLayout[column.id]) {
        if (!seen.has(panel)) {
          next[column.id].push(panel);
          seen.add(panel);
        }
      }
    }
    return next;
  }

  private allPanelIds(): CharacterPanelId[] {
    return Object.values(this.defaultPanelLayout).flat();
  }

  private clonePanelLayout(layout: CharacterPanelLayout): CharacterPanelLayout {
    return {
      left: [...layout.left],
      center: [...layout.center],
      right: [...layout.right],
    };
  }

  private panelColumnId(value: string | undefined): PanelColumnId | null {
    return this.panelColumns.some(({ id }) => id === value) ? (value as PanelColumnId) : null;
  }

  openCopyDialog(): void {
    if (!this.snapshot) return;
    this.copyName = `${this.snapshot.saveName}-copy`;
    this.copyVisible = true;
  }

  async copySave(): Promise<void> {
    if (!this.snapshot || !this.copyName.trim()) return;
    this.loading = true;
    try {
      const copiedPath = await this.editor.copySave(this.userDir, this.snapshot.relativePath, this.copyName.trim());
      this.copyVisible = false;
      this.messages.add({ severity: 'success', summary: 'Save copied', detail: copiedPath, life: 6000 });
      await this.refreshSlots();
      await this.selectSlot(copiedPath);
    } catch (error) {
      this.notifyError('Unable to copy save directory', error);
    } finally {
      this.loading = false;
    }
  }

  openDeleteDialog(event: MouseEvent, slot: CharacterSaveSlot): void {
    event.stopPropagation();
    this.deleteSlot = slot;
    this.deleteVisible = true;
  }

  async deleteSave(): Promise<void> {
    const slot = this.deleteSlot;
    if (!slot) return;
    this.loading = true;
    try {
      await this.editor.deleteSave(this.userDir, slot.relativePath);
      const wasSelected = this.selectedSlotPath === slot.relativePath;
      if (wasSelected) {
        this.selectedSlotPath = '';
        this.snapshot = null;
        this.selectedCharacter = null;
        this.statsDirty = false;
      }
      this.deleteVisible = false;
      this.deleteSlot = null;
      this.messages.add({ severity: 'success', summary: 'Save deleted', detail: slot.relativePath, life: 6000 });
      await this.refreshSlots();
    } catch (error) {
      this.notifyError('Unable to delete save directory', error);
    } finally {
      this.loading = false;
    }
  }

  async saveStats(): Promise<void> {
    if (!this.snapshot || !this.selectedCharacter || !this.statsDirty) return;
    const characterId = this.selectedCharacter.summary.id;
    const source = this.selectedCharacter.summary.source;
    this.loading = true;
    try {
      this.snapshot = await this.editor.saveStats(
        this.userDir,
        this.snapshot.relativePath,
        source,
        characterId,
        {
          stats: this.selectedCharacter.stats,
          bodyParts: this.selectedCharacter.health.map((part) => ({ id: part.id, health: part.health })),
          skills: this.selectedCharacter.skills,
        },
        this.gameDir,
      );
      this.selectedCharacter = this.snapshot.characters.find(
        (character) => character.summary.id === characterId && character.summary.source === source,
      ) ?? null;
      this.statsDirty = false;
      this.messages.add({ severity: 'success', summary: 'Character stats saved', detail: 'The selected players.db was updated.', life: 5000 });
    } catch (error) {
      this.notifyError('Unable to save character stats', error);
    } finally {
      this.loading = false;
    }
  }

  formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  label(value: string | null | undefined): string {
    if (!value) return 'Unknown';
    return value.replace(/^(base:|Base\.)/i, '').replace(/[_-]+/g, ' ');
  }

  bodyPartLabel(value: string): string {
    return this.label(value)
      .replace(/\bL\b/g, 'Left')
      .replace(/\bR\b/g, 'Right')
      .replace('ForeArm', 'Forearm')
      .replace('UpperArm', 'Upper Arm')
      .replace('UpperLeg', 'Thigh')
      .replace('LowerLeg', 'Shin')
      .replace('Torso Upper', 'Upper Torso')
      .replace('Torso Lower', 'Lower Torso');
  }

  skillGroups(character: CharacterDetails): SkillGroup[] {
    const groups = new Map<string, CharacterSkill[]>();
    for (const skill of character.skills) {
      const group = groups.get(skill.category) ?? [];
      group.push(skill);
      groups.set(skill.category, group);
    }
    return Array.from(groups, ([category, skills]) => ({ category, skills }));
  }

  levelBoxes(): number[] {
    return Array.from({ length: 10 }, (_value, index) => index);
  }

  temperatureFahrenheit(value: number | null): string {
    return value === null ? 'Unknown' : `${((value * 9) / 5 + 32).toFixed(2)} °F`;
  }

  conditionLabels(part: CharacterDetails['health'][number]): string[] {
    const labels: string[] = [];
    if (part.bitten) labels.push('Bite');
    if (part.scratched) labels.push('Scratch');
    if (part.cut) labels.push('Cut');
    if (part.bandaged) labels.push('Bandaged');
    if (part.bleeding) labels.push('Bleeding');
    if (part.deepWounded) labels.push('Deep wound');
    if (part.infected || part.infectedWound) labels.push('Infected');
    return labels;
  }

  private notifyError(summary: string, error: unknown): void {
    this.messages.add({ severity: 'error', summary, detail: this.errorMessage(error), life: 8000 });
  }

  private errorMessage(error: unknown): string {
    return typeof error === 'string' ? error : error instanceof Error ? error.message : 'Unknown error';
  }
}
