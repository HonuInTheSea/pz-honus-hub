import {
  Component,
  ElementRef,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SliderModule } from 'primeng/slider';
import { ListboxModule } from 'primeng/listbox';
import { CardModule } from 'primeng/card';
import { convertFileSrc } from '@tauri-apps/api/core';
import { PzMusicService, OggTrackInfo } from '../../services/pz-music.service';

@Component({
  selector: 'app-sidebar-music-player',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    ButtonModule,
    SliderModule,
    ListboxModule,
  ],
  templateUrl: './sidebar-music-player.component.html',
  styleUrl: './sidebar-music-player.component.css',
})
export class SidebarMusicPlayerComponent implements OnInit {
  @ViewChild('audio', { static: true })
  private readonly audioRef!: ElementRef<HTMLAudioElement>;

  tracks: OggTrackInfo[] = [];
  selectedTrack: OggTrackInfo | null = null;
  audioSrc: string | null = null;
  loadError: string | null = null;
  debugDetails: string | null = null;

  isPlaying = false;
  durationSeconds = 0;
  currentSeconds = 0;
  seekingSeconds = 0;
  isSeeking = false;
  volume = 85;
  isMuted = false;
  private lastNonZeroVolume = 85;

  constructor(private readonly music: PzMusicService) {}

  async ngOnInit(): Promise<void> {
    await this.reload();
    this.applyVolume();
  }

  get hasTracks(): boolean {
    return this.tracks.length > 0;
  }

  get nowPlayingTitle(): string {
    const t = this.selectedTrack;
    if (!t) {
      return 'Music';
    }
    const title = (t.metadata?.title || '').trim();
    return title || this.fileNameFromRelative(t.relative_path);
  }

  get nowPlayingSubtitle(): string {
    const t = this.selectedTrack;
    if (!t) {
      return this.hasTracks ? `${this.tracks.length} tracks` : 'No tracks found';
    }
    const artist = (t.metadata?.artist || '').trim();
    const album = (t.metadata?.album || '').trim();
    const parts = [artist, album].filter((p) => !!p);
    return parts.length ? parts.join(' • ') : t.relative_path;
  }

  async reload(): Promise<void> {
    this.loadError = null;
    this.debugDetails = null;

    if (!this.music.isTauriRuntime()) {
      this.tracks = [];
      this.stopAndReset();
      this.loadError = 'Music library requires the Tauri app runtime (not ng serve).';
      return;
    }

    try {
      this.tracks = await this.music.listProjectZomboidOggTracks();
    } catch (err) {
      this.tracks = [];
      const message = this.stringifyError(err);
      this.loadError = 'Failed to load Project Zomboid music.';
      this.debugDetails = `${await this.buildDebugDetails()}${message ? `\nError: ${message}` : ''}`;
    }

    if (this.tracks.length) {
      this.selectTrack(this.tracks[0], false);
    } else {
      this.stopAndReset();
    }
  }

  private async buildDebugDetails(): Promise<string> {
    const gameDir = await this.music.getGameDir();
    return `Debug: tauriRuntime=true, gameDir="${gameDir}", invoke="list_project_zomboid_music_ogg", argKey="gameDir"`;
  }

  private stringifyError(err: unknown): string {
    if (!err) {
      return '';
    }
    if (typeof err === 'string') {
      return err;
    }
    if (err instanceof Error) {
      return err.message || String(err);
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  togglePlay(): void {
    if (!this.selectedTrack) {
      return;
    }
    if (this.isPlaying) {
      this.pause();
    } else {
      void this.play();
    }
  }

  async play(): Promise<void> {
    const audio = this.audioRef.nativeElement;
    if (!this.audioSrc && this.selectedTrack) {
      this.loadSelectedTrack();
    }
    try {
      await audio.play();
      this.isPlaying = true;
    } catch {
      this.isPlaying = false;
    }
  }

  pause(): void {
    const audio = this.audioRef.nativeElement;
    audio.pause();
    this.isPlaying = false;
  }

  prev(): void {
    if (!this.tracks.length) {
      return;
    }
    const currentIndex = this.selectedTrack
      ? this.tracks.findIndex((t) => t.path === this.selectedTrack?.path)
      : -1;

    const nextIndex =
      currentIndex <= 0 ? this.tracks.length - 1 : currentIndex - 1;

    this.selectTrack(this.tracks[nextIndex], true);
  }

  next(): void {
    if (!this.tracks.length) {
      return;
    }
    const currentIndex = this.selectedTrack
      ? this.tracks.findIndex((t) => t.path === this.selectedTrack?.path)
      : -1;

    const nextIndex =
      currentIndex < 0 || currentIndex >= this.tracks.length - 1
        ? 0
        : currentIndex + 1;

    this.selectTrack(this.tracks[nextIndex], true);
  }

  onTrackClicked(track: OggTrackInfo): void {
    if (!track) {
      return;
    }
    this.selectTrack(track, true);
  }

  selectTrack(track: OggTrackInfo, autoplay: boolean): void {
    this.selectedTrack = track;
    this.loadSelectedTrack();
    if (autoplay) {
      void this.play();
    }
  }

  private loadSelectedTrack(): void {
    if (!this.selectedTrack) {
      return;
    }
    const audio = this.audioRef.nativeElement;
    this.audioSrc = convertFileSrc(this.selectedTrack.path);
    audio.src = this.audioSrc;
    audio.load();
    this.isPlaying = false;
    this.durationSeconds = 0;
    this.currentSeconds = 0;
    this.seekingSeconds = 0;
    this.isSeeking = false;
    this.applyVolume();
  }

  onLoadedMetadata(): void {
    const audio = this.audioRef.nativeElement;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    this.durationSeconds = duration > 0 ? duration : 0;
  }

  setVolume(value: number): void {
    const next = Number.isFinite(value) ? value : this.volume;
    this.volume = Math.max(0, Math.min(100, Math.round(next)));
    if (this.volume > 0) {
      this.lastNonZeroVolume = this.volume;
      this.isMuted = false;
    } else {
      this.isMuted = true;
    }
    this.applyVolume();
  }

  toggleMute(): void {
    if (this.isMuted || this.volume <= 0) {
      this.isMuted = false;
      this.volume = Math.max(1, Math.min(100, this.lastNonZeroVolume || 85));
    } else {
      this.lastNonZeroVolume = Math.max(1, Math.min(100, this.volume || 85));
      this.isMuted = true;
      this.volume = 0;
    }
    this.applyVolume();
  }

  get volumeIcon(): string {
    if (this.isMuted || this.volume <= 0) {
      return 'pi pi-volume-off';
    }
    if (this.volume <= 50) {
      return 'pi pi-volume-down';
    }
    return 'pi pi-volume-up';
  }

  private applyVolume(): void {
    const audio = this.audioRef.nativeElement;
    audio.muted = this.isMuted;
    audio.volume = Math.max(0, Math.min(1, this.volume / 100));
  }

  onTimeUpdate(): void {
    const audio = this.audioRef.nativeElement;
    const t = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    this.currentSeconds = t >= 0 ? t : 0;
    if (!this.isSeeking) {
      this.seekingSeconds = this.currentSeconds;
    }
  }

  onEnded(): void {
    this.isPlaying = false;
    this.next();
  }

  onSeekStart(): void {
    this.isSeeking = true;
  }

  onSeekEnd(): void {
    const audio = this.audioRef.nativeElement;
    const nextTime = Math.max(0, Math.min(this.seekingSeconds, this.durationSeconds || 0));
    audio.currentTime = nextTime;
    this.currentSeconds = nextTime;
    this.isSeeking = false;
  }

  formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return '0:00';
    }
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  trackDisplayName(track: OggTrackInfo): string {
    const title = (track.metadata?.title || '').trim();
    return title || this.fileNameFromRelative(track.relative_path);
  }

  trackDisplayMeta(track: OggTrackInfo): string {
    const artist = (track.metadata?.artist || '').trim();
    const album = (track.metadata?.album || '').trim();
    const parts = [artist, album].filter((p) => !!p);
    return parts.length ? parts.join(' • ') : track.relative_path;
  }

  private fileNameFromRelative(relativePath: string): string {
    const parts = (relativePath || '').split(/[\\/]/g).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : relativePath;
  }

  private stopAndReset(): void {
    const audio = this.audioRef.nativeElement;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.audioSrc = null;
    this.selectedTrack = null;
    this.isPlaying = false;
    this.durationSeconds = 0;
    this.currentSeconds = 0;
    this.seekingSeconds = 0;
    this.isSeeking = false;
    this.applyVolume();
  }
}
