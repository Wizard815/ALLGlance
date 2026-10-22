// ESLint 9 flat config for the gateway (Node, ES modules).
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // `_name` marks a parameter kept for the interface (e.g. BaseAdapter hooks).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
