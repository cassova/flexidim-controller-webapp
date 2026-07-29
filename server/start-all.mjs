/**
 * Supervises the web host and the controller bridge as one pair, so the image
 * works as a complete single-container deployment under a plain `docker run`.
 * Compose overrides the command per service to run them separately instead.
 *
 * The bridge keeps its loopback default here on purpose: inside the container
 * the web host reaches it at 127.0.0.1:8765 with no configuration, and the
 * bridge port is never exposed outside the container.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (children.size === 0) process.exit(exitCode);
  for (const child of children.values()) child.kill("SIGTERM");
  // Escalate if a child ignores SIGTERM; the runtime would otherwise wait out
  // its stop grace period and SIGKILL the whole tree anyway.
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
  }, 4000).unref();
}

function launch(name, script) {
  const child = spawn(process.execPath, [script], {
    stdio: "inherit",
    env: process.env,
  });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    // One process dying leaves a half-working container: the page would load
    // but never reach a controller. Take the container down so a restart
    // policy brings back a working pair.
    console.error(
      `[flexidim] ${name} exited unexpectedly (code=${code}, signal=${signal}); stopping`,
    );
    exitCode = code ?? 1;
    shutdown();
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

launch("bridge", "bridge/server.mjs");
launch("web", "server/host.mjs");
