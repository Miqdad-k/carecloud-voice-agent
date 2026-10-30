// Render's free tier stops a web service after 15 minutes with no inbound request, and the
// next request waits while it wakes. For a voice agent that means a caller waiting in
// silence, so the app requests its own public URL, which arrives as inbound traffic.
//
// This can only stop the app falling asleep, not wake it, so the GitHub Actions workflow in
// .github/workflows/keep-awake.yml is the backup. Render sets RENDER_EXTERNAL_URL itself, so
// this does nothing when running locally or in tests.
const INTERVAL_MS = 10 * 60 * 1000;

type Log = { error: (obj: object, msg: string) => void };

export function startKeepAwake(externalUrl: string | undefined, log: Log, request: typeof fetch = fetch): NodeJS.Timeout | null {
  if (!externalUrl) return null;

  const timer = setInterval(() => {
    request(`${externalUrl}/health`).catch((err: Error) => {
      log.error({ error: { message: err.message } }, 'Keep-awake request failed');
    });
  }, INTERVAL_MS);

  // Must not hold the process open during a shutdown.
  timer.unref();
  return timer;
}
