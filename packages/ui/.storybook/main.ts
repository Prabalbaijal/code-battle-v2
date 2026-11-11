import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

/** The UI kit's catalogue (plan §21.5). `pnpm --filter @cb/ui storybook` · static: `build-storybook`. */
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/**/*.stories.tsx'],
  core: { disableTelemetry: true },
  viteFinal: async (cfg) => ({ ...cfg, plugins: [...(cfg.plugins ?? []), tailwindcss()] }),
};

export default config;
