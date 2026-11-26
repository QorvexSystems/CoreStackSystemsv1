/** Sitio público de reservas. Habla con el ERP solo desde el servidor (rutas /api/*), nunca desde el navegador. */
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'images.unsplash.com' }],
  },
  async headers() {
    const headers = [
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    ];
    if (process.env.NODE_ENV === 'production')
      headers.push({ key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' });
    return [{ source: '/:path*', headers }];
  },
};

export default nextConfig;
