import type { NextConfig } from "next";
const isDev = process.env.NODE_ENV !== "production";
const config: NextConfig = {
  ...(!isDev && { output: "export" }),
  distDir: "out",
  async rewrites() {
    if (!isDev) return [];
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:7778/api/:path*",
      },
    ];
  },
};
export default config;
