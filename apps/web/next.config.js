/** @type {import('next').NextConfig} */
// Static-export capable: `next build` emits a fully static site to ./out,
// suitable for hosting on a CDN or Railway static service in a later mission.
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true }
};

module.exports = nextConfig;
