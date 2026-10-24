import { bootstrapApplication } from '@angular/platform-browser';
import { ConsoleComponent } from './app/console.component';
import { CONSOLE_APP_CONFIG } from './app/console.config';

bootstrapApplication(ConsoleComponent, CONSOLE_APP_CONFIG).catch((error: unknown) => console.error(error));
