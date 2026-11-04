// Loaded before every script via `tsx --import ./src/env.ts` (see package.json).
// Reads .env if it exists. Variables already set in the environment (e.g. by a secrets
// manager) take precedence, so .env is just a convenience for running the project locally.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: use the environment as-is.
}
