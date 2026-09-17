/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fully static site (all data is fetched client-side from Supabase). Produces an
  // `out/` folder of plain HTML/JS — ideal for Cloudflare Pages, no server runtime.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true }, // no server image optimizer in a static export
};
export default nextConfig;
