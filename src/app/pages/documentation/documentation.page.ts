import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { ImageModule } from 'primeng/image';
import { CarouselModule } from 'primeng/carousel';

@Component({
  selector: 'app-documentation-page',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslocoModule, ImageModule, CarouselModule],
  templateUrl: './documentation.page.html',
})
export class DocumentationPageComponent {
  workflowCarouselImages01 = [
    '../../../assets/Workflow0101.png',
    '../../../assets/Workflow0102.png',
  ];

  workflowCarouselImages02 = [
    '../../../assets/Workflow0201.png',
    '../../../assets/Workflow0202.png',
  ];

  workflowCarouselImages03 = [
    '../../../assets/Workflow0301.png'
  ];

  workflowCarouselImages04 = [
    '../../../assets/Workflow0401.png'
  ];

  workflowCarouselImages05 = [
    '../../../assets/Workflow0501.png'
  ];

  responsiveOptions = [
    {
      breakpoint: '1199px',
      numVisible: 2,
      numScroll: 1,
    },
    {
      breakpoint: '991px',
      numVisible: 1,
      numScroll: 1,
    },
    {
      breakpoint: '767px',
      numVisible: 1,
      numScroll: 1,
    },
  ];
}
