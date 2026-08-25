// ABOUTME: VitePress site config for the @armada/sdk developer docs — nav, sidebar, the
// ABOUTME: TypeDoc-generated API reference sidebar, and Mermaid diagram rendering.
import { withMermaid } from 'vitepress-plugin-mermaid';

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

export default withMermaid({
  title: '@armada/sdk',
  description: 'Developer documentation for the Armada shielded-pool SDK.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  // This directory's README.md documents the docs workflow for contributors; it is not a site page.
  srcExclude: ['README.md'],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '/guide/' },
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

  vite: {
    // Mermaid pulls in CommonJS-only transitive deps (fastdom via cytoscape); force Vite to
    // pre-bundle them so the dev server resolves their default exports (production build is unaffected).
    optimizeDeps: {
      include: ['mermaid', 'fastdom', 'cytoscape', 'cytoscape-cose-bilkent'],
    },
  },
});
