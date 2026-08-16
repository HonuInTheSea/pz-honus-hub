import { Component } from '@angular/core';
import { ProjectZomboidMapComponent } from '../../components/project-zomboid-map/project-zomboid-map.component';

@Component({
  selector: 'app-maps-page',
  standalone: true,
  imports: [ProjectZomboidMapComponent],
  templateUrl: './maps.page.html',
  styleUrl: './maps.page.css',
})
export class MapsPageComponent {}
