import { createVitestConfig } from '../../vitest.preset.config.mjs';

export default createVitestConfig({
  type: 'angular',
  projectName: 'battle-console',
  pathFromRoot: import.meta.dirname,
  projectSpecificSetupFiles: ['src/test-setup.ts']
});
