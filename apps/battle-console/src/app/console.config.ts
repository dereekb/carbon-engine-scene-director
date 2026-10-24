import { type ApplicationConfig, importProvidersFrom, inject, provideAppInitializer, provideZonelessChangeDetection } from '@angular/core';
import { MatIconRegistry } from '@angular/material/icon';
import { provideRouter } from '@angular/router';
import { DbxCoreAngularRouterSegueModule } from '@dereekb/dbx-core';
import { provideDbxRouterWebAngularRouterProviderConfig, provideDbxScreenMediaService, provideDbxStyleService } from '@dereekb/dbx-web';
import { provideDbxForgeFormFieldDeclarations, provideDbxFormConfiguration } from '@dereekb/dbx-form';
import { ConsoleDialogs } from './console-dialogs';
import { ConsoleMatDialogs } from './console-dialogs.component';
import { CONSOLE_ENGINE_STARTER, type ConsoleEngineStarter } from './console-viewer.service';

/**
 * Starts the engine module the import map names (index.html): Angular leaves the import alone (externalDependencies).
 *
 * @param options - StartViewer's options.
 * @returns The running engine.
 */
const START_CONSOLE_ENGINE: ConsoleEngineStarter = async (options) => (await import('@scene-director/viewer-engine')).StartViewer(options);

/**
 * The console's providers: zoneless, the Angular router with dbx's segue (the router-transition service dbx dialogs
 * and popups need; the console has no routes), dbx-web's router config and styles, and dbx-form's forge fields.
 */
export const CONSOLE_APP_CONFIG: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    { provide: CONSOLE_ENGINE_STARTER, useValue: START_CONSOLE_ENGINE },
    { provide: ConsoleDialogs, useClass: ConsoleMatDialogs },
    provideRouter([]),
    importProvidersFrom(DbxCoreAngularRouterSegueModule.forRoot()),
    provideDbxRouterWebAngularRouterProviderConfig(),
    provideDbxScreenMediaService(),
    provideDbxStyleService({ dbxStyleConfig: { style: 'console-app' } }),
    provideDbxFormConfiguration(),
    provideDbxForgeFormFieldDeclarations(),
    // index.html loads the Material Symbols font
    provideAppInitializer(() => {
      inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-outlined');
    })
  ]
};
