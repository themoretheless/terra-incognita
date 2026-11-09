import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'vendor/**', 'dist/**', 'design/**', 'tests/e2e/screenshots/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.browser },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] }
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['src/**/*.ts', 'src/**/*.tsx'] })),
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // границы с императивными JS-модулями (app, события Forma) типизированы как any осознанно
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  { files: ['tests/**', 'bench/**', 'eslint.config.js', 'vite.config.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['public/sw.js'], languageOptions: { sourceType: 'script', globals: globals.serviceworker } }
];
