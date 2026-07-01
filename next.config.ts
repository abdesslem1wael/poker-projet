import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js dev mode blocks cross-origin requests to _next assets/HMR by
  // default. Testing on a phone means hitting this machine's LAN IP instead
  // of localhost, so without this the JS bundle gets 403'd — the page still
  // server-renders fine but nothing is clickable (native forms like the
  // Sign out button still work since they don't need the blocked bundle).
  allowedDevOrigins: ["192.168.1.*"],
};

export default nextConfig;
