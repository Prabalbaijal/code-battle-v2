import nextPlugin from '@next/eslint-plugin-next';
import react from '@cb/eslint-config/react';

export default [
  ...react,
  {
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
  },
];
