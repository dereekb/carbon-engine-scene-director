import { createVitestConfig } from '../../vitest.preset.config.mjs';

export default createVitestConfig({
  type: 'node',
  projectName: 'scene',
  pathFromRoot: import.meta.dirname
});
