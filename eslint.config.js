// Flat ESLint configuration for the TypeScript sources and Node scripts.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      '.test-build/**',
      'node_modules/**',
      'docs/**',
      'packages/**',
      // Upstream built bundles kept for comparison; never edited by hand.
      'lib/**',
      // Legacy JavaScript retained only until the migration commits finish.
      'src/**/*.mjs',
      'src/**/*.jsx',
      'test/**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      // Browser sources and Node sources share one tsconfig, so both global sets
      // are available; TypeScript still catches real typos through `no-undef` off.
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // TypeScript already reports unknown identifiers; no-undef only creates
      // false positives for DOM and Node globals.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'smart'],
      'no-eval': 'error',
      // Control characters are rejected on purpose in path and name validation.
      'no-control-regex': 'off',
      'no-implied-eval': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'fs', property: 'rm', message: 'Recursive deletion is forbidden in this plugin.' },
        { object: 'fs/promises', property: 'rm', message: 'Recursive deletion is forbidden in this plugin.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.property.name='rm'][callee.property.name='rm']",
          message: 'Recursive deletion must not be used; unlink known files individually.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs', '*.js'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
