import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', '.pixi/**', '.logs/**', '.playwright-cli/**', '.playwright-mcp/**', 'coverage/**', 'output/**'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-control-regex': 'off',
    },
  },
);
