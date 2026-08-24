// ABOUTME: VitePress site config for the @armada/sdk developer docs — nav, sidebar, and the
// ABOUTME: TypeDoc-generated API reference sidebar (built by `npm run docs:api` before build).
import { defineConfig } from 'vitepress';

// The API reference sidebar is emitted by typedoc-vitepress-theme into docs/api/ during `docs:api`.
// It won't exist on a fresh `docs:dev` before that runs, so fall back to an empty section.
let typedocSidebar: unknown[] = [];
try {
  typedocSidebar = (
    await import('../api/typedoc-sidebar.json', { with: { type: 'json' } })
  ).default as unknown[];
} catch {
  // API reference not generated yet — run `npm run docs:api`.
}

export default defineConfig({
  title: '@armada/sdk',
  description: 'Developer documentation for the Armada shielded-pool SDK.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Overview', link: '/guide/' },
            { text: 'Getting started', link: '/guide/getting-started' },
          ],
        },
        {
          text: 'Core concepts',
          items: [
            { text: 'Wallets', link: '/guide/wallets' },
            { text: 'Syncing', link: '/guide/syncing' },
            { text: 'Transactions', link: '/guide/transactions' },
            { text: 'Adapters', link: '/guide/adapters' },
            { text: 'Security', link: '/guide/security' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API reference',
          items: typedocSidebar,
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/ship-armada/armada-sdk' },
    ],

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/ship-armada/armada-sdk/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
