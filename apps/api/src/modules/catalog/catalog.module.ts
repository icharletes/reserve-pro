import { Module } from '@nestjs/common';
import { CategoriesController, CategoriesService } from './categories.js';
import { LocationsController, LocationsService } from './locations.js';
import { ResourcesController, ResourcesService } from './resources.js';
import { ServicesController, ServicesService } from './services.js';

/** Catálogo de la empresa: sucursales, categorías, servicios y profesionales/recursos. */
@Module({
  controllers: [LocationsController, CategoriesController, ServicesController, ResourcesController],
  providers: [LocationsService, CategoriesService, ServicesService, ResourcesService],
  exports: [LocationsService, ResourcesService],
})
export class CatalogModule {}
