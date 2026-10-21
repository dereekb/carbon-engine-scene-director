import nx from '@nx/eslint-plugin';
import unusedImports from 'eslint-plugin-unused-imports';
import importPlugin from 'eslint-plugin-import-x';
import * as jsoncParser from 'jsonc-eslint-parser';
import jsdocPlugin from 'eslint-plugin-jsdoc';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import unicornPlugin from 'eslint-plugin-unicorn';
import { UTIL_ESLINT_PLUGIN } from '@dereekb/util/eslint';

/**
 * `no-restricted-syntax` selectors that ban the em-dash (U+2014) from string / template literals. Tool descriptions
 * are read by models, which mirror the em-dash back into generated prose. Comments are untouched (only literals match).
 * Exported so per-package configs that define their own `no-restricted-syntax` block can splice these back in.
 */
export const NO_EM_DASH_SELECTORS = [
  { selector: 'Literal[value=/\\u2014/]', message: 'Em-dash (U+2014) in a string literal. Restructure the text (sentence split, colon, comma, or parenthetical). Do not substitute "--" or another lookalike separator.' },
  { selector: 'TemplateElement[value.raw=/\\u2014/]', message: 'Em-dash (U+2014) in a template literal. Restructure the text (sentence split, colon, comma, or parenthetical). Do not substitute "--" or another lookalike separator.' }
];

export default [
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/.stats', '**/vitest.config.*.timestamp*', '**/*.generated.*']
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_EM_DASH_SELECTORS]
    }
  },
  {
    plugins: {
      'unused-imports': unusedImports
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_|^[A-Z]$',
          args: 'after-used',
          argsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      'import-x/no-unresolved': 'off',
      'import-x/namespace': 'off',
      'import-x/default': 'off',
      'import-x/extensions': ['error', 'never', { json: 'always' }]
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      'import-x/no-duplicates': ['warn', { considerQueryString: true, 'prefer-inline': true }]
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?js$'],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*']
            }
          ]
        }
      ],
      'no-else-return': ['error', { allowElseIf: false }]
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      'no-useless-assignment': 'off'
    }
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      'unused-imports/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      'no-unused-vars': 'off'
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.spec.ts', '**/*.spec.tsx'],
    plugins: { sonarjs: sonarjsPlugin },
    rules: {
      'sonarjs/cognitive-complexity': ['warn', 30],
      'sonarjs/no-duplicate-string': ['warn', { threshold: 5 }],
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-collapsible-if': 'warn',
      'sonarjs/prefer-immediate-return': 'warn',
      'sonarjs/no-nested-template-literals': 'error',
      'sonarjs/no-redundant-jump': 'warn',
      'sonarjs/no-unused-collection': 'warn',
      'sonarjs/no-nested-conditional': 'warn',
      'sonarjs/no-duplicated-branches': 'warn'
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.spec.ts', '**/*.spec.tsx'],
    plugins: { jsdoc: jsdocPlugin },
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          require: { FunctionDeclaration: true, ArrowFunctionExpression: false, FunctionExpression: false },
          checkGetters: false,
          checkSetters: false,
          publicOnly: true,
          enableFixer: false
        }
      ],
      'jsdoc/require-param': ['warn', { enableFixer: false }],
      'jsdoc/require-returns': ['warn', { enableFixer: false }],
      'jsdoc/require-throws': 'warn',
      'jsdoc/multiline-blocks': ['warn', { noSingleLineBlocks: true }],
      'jsdoc/tag-lines': ['warn', 'any', { startLines: 1 }]
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { unicorn: unicornPlugin },
    rules: {
      'unicorn/prefer-array-find': 'warn',
      'unicorn/prefer-array-flat-map': 'warn',
      'unicorn/prefer-array-some': 'warn',
      'unicorn/prefer-string-starts-ends-with': 'warn',
      'unicorn/no-lonely-if': 'warn',
      'unicorn/no-useless-spread': 'warn',
      'unicorn/prefer-spread': 'off',
      'unicorn/no-for-loop': 'warn',
      'unicorn/prefer-includes': 'warn',
      'unicorn/prefer-optional-catch-binding': 'warn',
      'unicorn/throw-new-error': 'warn',
      'unicorn/no-negated-condition': 'warn',
      'unicorn/prefer-single-call': 'warn',
      'unicorn/prefer-string-replace-all': 'warn',
      'unicorn/consistent-function-scoping': ['warn', { checkArrowFunctions: false }],
      'unicorn/prefer-set-has': 'warn',
      'unicorn/prefer-string-raw': 'warn',
      'unicorn/prefer-type-error': 'warn',
      'unicorn/prefer-number-properties': 'warn',
      'unicorn/prefer-native-coercion-functions': 'warn',
      'unicorn/no-useless-fallback-in-spread': 'warn',
      'unicorn/no-useless-promise-resolve-reject': 'warn',
      'unicorn/prefer-structured-clone': 'warn',
      'unicorn/no-useless-length-check': 'warn',
      'unicorn/prefer-date-now': 'warn',
      'unicorn/prefer-code-point': 'warn',
      'unicorn/prefer-node-protocol': 'warn',
      'unicorn/no-abusive-eslint-disable': 'warn',
      'unicorn/prefer-dom-node-remove': 'warn',
      'unicorn/prefer-top-level-await': 'warn'
    }
  },
  {
    files: ['{package,project}.json'],
    languageOptions: {
      parser: jsoncParser
    },
    rules: {
      '@nx/dependency-checks': [
        'warn',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          ignoredDependencies: []
        }
      ]
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.spec.ts', '**/*.test.ts', '**/*.d.ts'],
    plugins: {
      'dereekb-util': UTIL_ESLINT_PLUGIN
    },
    rules: {
      'dereekb-util/require-no-side-effects': 'warn',
      'dereekb-util/prefer-no-side-effects-in-jsdoc': 'warn',
      'dereekb-util/require-single-return': 'warn',
      'dereekb-util/require-readonly-config-params': 'warn',
      'dereekb-util/prefer-config-object': 'off',
      'dereekb-util/prefer-config-object-hard': 'off',
      'dereekb-util/prefer-maybe-type': 'warn',
      'dereekb-util/no-inline-type-import': 'warn',
      'dereekb-util/require-deprecated-alias-placement': 'warn',
      'dereekb-util/prefer-canonical-jsdoc': 'warn',
      'dereekb-util/require-constant-naming': 'warn',
      'dereekb-util/require-default-prefix-naming': 'warn',
      'dereekb-util/require-exported-jsdoc-example': 'off',
      'dereekb-util/no-inline-string-empty-object-intersection': 'error',
      'dereekb-util/prefer-suggested-string': 'warn',
      'dereekb-util/no-enum-literal-cast': 'warn'
    }
  },
  {
    // The formatter (oxfmt) owns all formatting, so the two core ESLint rules that fight its output are off.
    files: ['**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}'],
    rules: {
      'no-unexpected-multiline': 'off',
      'no-extra-semi': 'off'
    }
  }
];
