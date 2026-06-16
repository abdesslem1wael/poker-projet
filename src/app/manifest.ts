import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Poker',
    short_name: 'Poker',
    description: "Private Texas Hold'em",
    start_url: '/lobby',
    scope: '/',
    display: 'standalone',
    orientation: 'landscape',
    background_color: '#060b15',
    theme_color: '#060b15',
    icons: [
      {
        src: '/icon',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/apple-icon',
        sizes: '180x180',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
