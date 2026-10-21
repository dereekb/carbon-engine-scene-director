import baseConfig, { NO_EM_DASH_SELECTORS } from './eslint.config.mjs';
import typescriptParser from '@typescript-eslint/parser';
import typescriptPlugin from '@typescript-eslint/eslint-plugin';
import { UTIL_ESLINT_PLUGIN } from '@dereekb/util/eslint';

// Re-exported so per-package configs (which extend THIS library config) can splice the em-dash selectors into
// their own `no-restricted-syntax` blocks — flat config replaces the rule entry per file, so a package block
// that omits them silently drops the em-dash guard for its files.
export { NO_EM_DASH_SELECTORS };

export default [
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        projectService: {}
      }
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin,
      // Same imported singleton as the base config's `dereekb-util` block, so registering it again here does not trigger a flat-config "Cannot redefine plugin" error (that only fires when the two references differ).
      'dereekb-util': UTIL_ESLINT_PLUGIN
    },
    rules: {
      // Type-aware rule lives in this block (not the base `eslint.config.mjs` `dereekb-util` block) because: (1) it needs the TS checker, which only this block wires up via `projectService`; and (2) unlike the base block — which ignores `*.spec.ts` — this block covers spec files, where the `N as PromptLayer` offenders live.
      'dereekb-util/no-enum-literal-cast': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/max-params': ['warn', { max: 3, countVoidThis: false }],
      '@typescript-eslint/no-deprecated': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // disabled: autofix repeatedly strips load-bearing casts (ComponentStore widening, generic-narrowing inside fn bodies, errorResult() widening, Promise<O> flattening) and breaks the build
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/return-await': ['warn', 'in-try-catch'],
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      '@typescript-eslint/require-array-sort-compare': ['warn', { ignoreStringArrays: true }], // Sonar typescript:S2871 (reliability BUG) — .sort()/.toSorted() on non-string arrays must pass a compare fn; lexicographic default mis-sorts numbers. ignoreStringArrays mirrors Sonar's string-sort tolerance.
      '@typescript-eslint/switch-exhaustiveness-check': ['warn', { considerDefaultExhaustiveForUnions: true }],
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          modifiers: ['exported', 'const'],
          types: ['boolean', 'string', 'number', 'array'],
          format: ['UPPER_CASE'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'allow'
        }
      ]
    }
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx', '!{projectRoot}/test/**'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
      'sonarjs/no-duplicate-string': 'off'
    }
  }
];
