import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'design/**', 'tests/e2e/screenshots/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.browser
    },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] }
  },
  { files: ['tests/**', 'bench/**', 'eslint.config.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['sw.js'], languageOptions: { sourceType: 'script', globals: globals.serviceworker } }
];
