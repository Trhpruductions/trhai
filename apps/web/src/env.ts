const env = import.meta.env;

export const webEnv = {
  apiBaseUrl: env.VITE_API_BASE_URL ?? "http://localhost:4000",
  appName: env.VITE_APP_NAME ?? "JARVIS AI"
};
