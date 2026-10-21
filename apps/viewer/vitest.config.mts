import { createVitestConfig } from '../../vitest.preset.config.mjs';

export default createVitestConfig({
  type: 'node',
  projectName: 'viewer',
  pathFromRoot: import.meta.dirname
});
