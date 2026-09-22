#!/bin/sh
set -e

# List of environment variables to substitute
ENV_VARS='\${VITE_CLOUD_SERVER_HOST} \
\${VITE_CLOUD_SERVER_PORT} \
\${VITE_APP_PORT} \
\${VITE_API_PREFIX} \
\${VITE_QUOTA_PREFIX} \
\${VITE_QUOTA_URL} \
\${VITE_DASHBOARD_PREFIX} \
\${VITE_BASE_PATH} \
\${VITE_APP_URL} \
\${VITE_CASDOOR_ENDPOINT} \
\${VITE_CASDOOR_CLIENT_ID} \
\${VITE_CASDOOR_APP_NAME} \
\${VITE_CASDOOR_ORG_NAME} \
\${VITE_STORE_URL} \
\${VITE_OPENCODE_CLOUD_DEVICE_ID} \
\${VITE_OPENCODE_SERVER_HOST} \
\${VITE_OPENCODE_SERVER_PORT} \
\${VITE_MULTICA_WEB_URL}'

# Substitute environment variables in index.html for runtime configuration
if [ -f "/app/packages/app-ai-native/dist/index.html" ]; then
  content=$(envsubst "$ENV_VARS" < /app/packages/app-ai-native/dist/index.html)
  printf '%s\n' "$content" > /app/packages/app-ai-native/dist/index.html
  echo "Runtime environment variables injected into index.html"
fi

# Execute the CMD
exec "$@"
