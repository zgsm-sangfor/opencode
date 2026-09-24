import { defineConfig, loadEnv } from "vite"
import desktopPlugin from "./vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_")

  const cloudHost = env.VITE_CLOUD_SERVER_HOST ?? "localhost"
  const cloudPort = env.VITE_CLOUD_SERVER_PORT ?? "8080"
  const cloudTarget = cloudHost.startsWith("http") ? cloudHost : `http://${cloudHost}:${cloudPort}`
  const appPort = parseInt(env.VITE_APP_PORT ?? "3000")
  const prefix = env.VITE_API_PREFIX ?? ""
  const quotaPrefix = env.VITE_QUOTA_PREFIX ?? ""
  const basePath = env.VITE_BASE_PATH ?? "/"
  const apiPrefix = `${prefix}/api`
  const v2Prefix = `${prefix}/api/v2`
  const cookie = env.VITE_API_COOKIE

  // API prefix configuration for development/production environments
  const cloudApiPrefix = env.VITE_CLOUD_API_PREFIX ?? "/cloud-api"
  const cloudDashboardPrefix = env.VITE_CLOUD_DASHBOARD_PREFIX ?? "/cloud-dashboard"

  // Extract JWT from cookie string for Authorization header
  // Cookie format: zgsmAdminToken=<jwt>
  let authToken = ""
  if (cookie) {
    const match = cookie.match(/zgsmAdminToken=([^;]+)/)
    if (match) {
      authToken = `Bearer ${match[1]}`
    }
  }
  return {
    base: basePath,
    plugins: [desktopPlugin] as any,
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      port: appPort,
      cors: {
        origin: [`http://localhost:${appPort}`, `http://127.0.0.1:${appPort}`],
        credentials: true,
      },
      proxy: {
        [`${prefix}/cloud/device`]: {
          target: cloudTarget,
          changeOrigin: true,
          ws: true,
          ...(cookie && {
            headers: {
              Cookie: cookie,
            },
          }),
          rewrite: (path) => `${cloudApiPrefix}${path}`,
        },
        [`${prefix}/cloud`]: {
          target: cloudTarget,
          changeOrigin: true,
          ws: true,
          ...(cookie && {
            headers: {
              Cookie: cookie,
            },
          }),
          rewrite: (path) => `${cloudApiPrefix}${path}`,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (proxyReq.path.endsWith("/global/event")) {
                proxyReq.setHeader("Connection", "keep-alive")
              }
            })
          },
        },
        [apiPrefix]: {
          target: cloudTarget,
          changeOrigin: true,
          ...(cookie && {
            headers: {
              Cookie: cookie,
            },
          }),
          rewrite: (path) => {
            if (path.startsWith(v2Prefix)) {
              return `${cloudDashboardPrefix}${path}`
            }

            return `${cloudApiPrefix}${path}`
          },
        },
        [`${quotaPrefix}/quota-manager`]: {
          target: cloudTarget,
          changeOrigin: true,
          ...(cookie && {
            headers: {
              Cookie: cookie,
              Authorization: authToken,
            },
          }),
        },
      },
    },
    build: {
      target: "esnext",
      // sourcemap: true,
    },
  }
})
