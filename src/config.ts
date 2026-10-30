import 'dotenv/config';

// Secrets come from the environment only. A missing one stops the app at startup
// with a clear message, instead of failing later in the middle of a phone call.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
