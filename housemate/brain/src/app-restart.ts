/**
 * The page's Restart button: inside a Home Assistant app the brain asks the Supervisor
 * to restart this app (`/addons/self/restart` needs no extra permission). Never Home Assistant
 * itself. Elsewhere there is nothing to ask, and the page says to restart it by hand.
 */
export function canRestartApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SUPERVISOR_TOKEN?.trim());
}

/** Asks for the restart after the reply has gone out; the app stops shortly after. */
export function restartAppSoon(env: NodeJS.ProcessEnv = process.env, delayMs = 500): void {
  const token = env.SUPERVISOR_TOKEN?.trim();
  if (!token) return;
  setTimeout(() => {
    void fetch("http://supervisor/addons/self/restart", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch((error: unknown) => {
      console.error(`restart request failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, delayMs).unref();
}
