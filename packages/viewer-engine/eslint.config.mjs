import baseConfig from '../../eslint.config.library.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      // `runtime-dist/<file>` names a real file in the runtime's dist (see esbuild.config.mjs), so its `.js` stays.
      'import-x/extensions': ['error', 'never', { pattern: { json: 'always' }, pathGroupOverrides: [{ pattern: 'runtime-dist/**', action: 'ignore' }] }]
    }
  }
];
