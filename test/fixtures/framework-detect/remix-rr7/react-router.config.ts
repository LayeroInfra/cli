import type { Config } from "@react-router/dev/config";

// SPA mode — React Router v7 emits the browser bundle to build/client,
// which Layero hosts as static.
export default {
  ssr: false,
} satisfies Config;
