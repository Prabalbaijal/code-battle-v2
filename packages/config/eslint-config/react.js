import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import base from './index.js';

/** Base rules + React hooks and browser globals, for packages/ui and apps/web. */
export default [
  { ignores: ['.next/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'] },
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];
