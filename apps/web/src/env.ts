// Build-time configuration.
//
// `import.meta.env` is Vite's, and it only exists when Vite is what loaded the
// module. Under the test runner, or anywhere else this code is imported
// directly by Node, it is undefined — so this reads through a guard and falls
// back to the same defaults a development build would use. Without the guard,
// importing any module that touches config throws before a single test runs.

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const webEnv = {
  apiBaseUrl: env.VITE_API_BASE_URL ?? "http://localhost:4000",
  appName: env.VITE_APP_NAME ?? "Vexora AI"
};
