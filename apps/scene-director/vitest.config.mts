import { createVitestConfig } from '../../vitest.preset.config.mjs';

export default createVitestConfig({
  type: 'node',
  projectName: 'scene-director',
  pathFromRoot: import.meta.dirname
});
