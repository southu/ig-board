/** @type {import('next').NextConfig} */
// Static export: `next build` emits a fully static site to ./out, which the
// apps/api Fastify service serves from the same Railway deployment so one live
// URL covers the whole app (CDN/static-service hosting also works unchanged).
//
// A fixed generateBuildId makes the export byte-reproducible: the committed
// apps/api/public copy only changes when the app actually changes, so rebuilds
// produce clean, reviewable diffs instead of churning random build-id folders.
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  generateBuildId: () => 'ig-board'
};

module.exports = nextConfig;
