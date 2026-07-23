/** @type {import('next').NextConfig} */
// Static export: `next build` emits a fully static site to ./out, which the
// apps/api Fastify service serves from the same Railway deployment so one live
// URL covers the whole app (CDN/static-service hosting also works unchanged).
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true }
};

module.exports = nextConfig;
