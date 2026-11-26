/** @type {import('next').NextConfig} */
const nextConfig = {
  // Mantiene aislados los artefactos de `next dev` y `next build`.
  // Sin esta separación, una compilación de producción puede reemplazar los
  // chunks que un servidor de desarrollo ya tiene abiertos.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  typedRoutes: false,
  poweredByHeader: false,
  async rewrites() {
    const apiInternalUrl = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(
      /\/$/,
      '',
    );

    return [
      {
        source: '/api/:path*',
        destination: `${apiInternalUrl}/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: buildSecurityHeaders(),
      },
      {
        // Service worker de notificaciones push: siempre la versión más reciente.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  webpack(config, { isServer }) {
    if (isServer) {
      config.output = config.output || {};
      // Ensure server chunks are emitted under the `chunks/` folder
      config.output.chunkFilename = 'chunks/[id].js';
    } else {
      // OpenCV.js contains guarded Node branches for its standalone runtime.
      // OCR is imported dynamically only in the browser, so those built-ins
      // must resolve to empty client fallbacks instead of pulling polyfills.
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        fs: false,
        path: false,
      };
    }
    return config;
  },
};

function buildSecurityHeaders() {
  const isProduction = process.env.NODE_ENV === 'production';

  const headers = [
    {
      key: 'Referrer-Policy',
      value: 'strict-origin-when-cross-origin',
    },
    {
      key: 'X-Content-Type-Options',
      value: 'nosniff',
    },
    {
      key: 'X-Frame-Options',
      value: 'DENY',
    },
    {
      key: 'X-DNS-Prefetch-Control',
      value: 'off',
    },
    {
      key: 'X-Robots-Tag',
      value: 'noindex, nofollow',
    },
    {
      key: 'Permissions-Policy',
      value: 'camera=(self), microphone=(), geolocation=(), payment=()',
    },
  ];

  if (isProduction) {
    headers.push({
      key: 'Strict-Transport-Security',
      value: 'max-age=15552000; includeSubDomains',
    });
  }

  return headers;
}

export default nextConfig;
