/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard reads live chain + news data; nothing here is cacheable.
  headers: async () => [
    { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
  ],
};
export default nextConfig;
