---
description: "Kill the running Tauri dev server and restart it cleanly"
---

# Dev Server Restart

Restart the Tauri dev server. This handles stale processes, port conflicts, and log tailing.

## Steps

1. **Kill existing processes** — try these in order until one succeeds:
   ```bash
   taskkill //F //IM bilbli-copy.exe 2>$null
   ```
   Then also free the Vite dev port:
   ```bash
   npx kill-port 1420 2>$null; npx kill-port 3000 2>$null
   ```
   Wait 2 seconds for cleanup.

2. **Start dev server**:
   ```bash
   pnpm dev 2>&1
   ```

3. **Wait for startup** — sleep 25-30 seconds, then check if the process is running:
   ```bash
   netstat -ano | findstr ":1420.*LISTENING"
   ```
   If not listening, wait another 15 seconds and retry once.

4. **Check for errors** — if the app has an `app.log`, tail the last 10 lines:
   ```bash
   Get-Content src-tauri\target\debug\app.log -Tail 10 -ErrorAction SilentlyContinue
   ```

## Important

- Always kill the old process before starting a new one — two instances will conflict on the SQLite database.
- If `taskkill` fails because the process doesn't exist, that's fine — continue to the next step.
- If `pnpm dev` exits immediately with an error, check `cargo check` first for Rust compilation errors.
