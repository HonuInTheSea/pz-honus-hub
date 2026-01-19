import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class AppContentLoadingService {
  private readonly readySubject = new BehaviorSubject<boolean>(false);
  readonly ready$ = this.readySubject.asObservable();

  markReady(): void {
    if (!this.readySubject.value) {
      this.readySubject.next(true);
    }
  }
}

