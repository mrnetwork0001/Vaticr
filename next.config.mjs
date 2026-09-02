/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // wagmi's connector barrel (wagmi/connectors) pulls in Coinbase's Base Account
  // connector, which reaches @coinbase/cdp-sdk -> @x402/*. Those are OPTIONAL
  // peers of the SDK and are not installed, so webpack fails the whole build on
  // five unresolvable imports even though Vaticr only uses the injected and
  // WalletConnect connectors and never touches that code path.
  //
  // Stub exactly those five specifiers rather than installing an x402 payments
  // stack we do not use, or hand-importing connectors from wagmi's dist paths
  // (which would break on any wagmi patch release).
  webpack: (config) => {
    for (const missing of [
      "@x402/core/client",
      "@x402/evm",
      "@x402/evm/exact/client",
      "@x402/evm/upto/client",
      "@x402/svm/exact/client",
    ]) {
      config.resolve.alias[missing] = false;
    }
    return config;
  },
  // The dashboard reads live chain + news data; nothing here is cacheable.
  headers: async () => [
    { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
  ],
};
export default nextConfig;
