import { createVitestConfig } from '../../vitest.preset.config.mjs';

export default createVitestConfig({
  type: 'node',
  projectName: 'battle',
  pathFromRoot: import.meta.dirname
});
