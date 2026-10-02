import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-only build badge defaults to a corner the app's own controls use
  // (the account menu, the sidebar's status chip); bottom-right is clear.
  devIndicators: { position: "bottom-right" }
};

export default nextConfig;
