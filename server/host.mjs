/**
 * The web host: serves the app and proxies the bridge WebSocket.
 *
 * The browser talks to `ws(s)://<page origin>/bridge` rather than straight to
 * the bridge's own port. That indirection is what makes the phone case work: a
 * phone loading http://192.168.1.20:3000 has no route to 127.0.0.1:8765 on the
 * computer running the bridge, but it can always reach the origin it just
 * loaded the page from. It also means one published port instead of two, and it
 * keeps the bridge itself bound to loopback inside the container.
 *
 * Running Next through its programmatic API rather than `next start` is what
 * lets a single process own both the page handler and the upgrade handler.
 */
import http from "node:http";
import process from "node:process";

import next from "next";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

/** Where the bridge process is listening, from this host's point of view. */
const bridgeHost = process.env.FLEXIDIM_BRIDGE_UPSTREAM_HOST ?? "127.0.0.1";
const bridgePort = Number(process.env.FLEXIDIM_BRIDGE_UPSTREAM_PORT ?? 8765);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

/**
 * Live proxy socket pairs. A pair must not outlive its partner: the Scene
 * Controller allows one control session, the bridge releases it when its client
 * socket closes, and a half-torn-down proxy would pin that session open with
 * nobody behind it — locking the user out of their own lighting.
 */
const proxyPairs = new Set();

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  handle(req, res);
});

server.on("upgrade", (incoming, clientSocket, clientHead) => {
  let pathname = "/";
  try {
    pathname = new URL(incoming.url ?? "/", "http://localhost").pathname;
  } catch {
    clientSocket.destroy();
    return;
  }

  // Next uses its own upgrades for HMR in development; leave those alone.
  if (pathname !== "/bridge") {
    if (dev) app.getUpgradeHandler()(incoming, clientSocket, clientHead);
    else clientSocket.destroy();
    return;
  }

  const upstream = http.request({
    host: bridgeHost,
    port: bridgePort,
    path: "/",
    headers: {
      ...incoming.headers,
      host: `${bridgeHost}:${bridgePort}`,
      connection: "Upgrade",
      upgrade: "websocket",
    },
  });

  upstream.on("upgrade", (response, bridgeSocket, bridgeHead) => {
    proxyPairs.add(clientSocket);
    proxyPairs.add(bridgeSocket);

    const teardown = () => {
      proxyPairs.delete(clientSocket);
      proxyPairs.delete(bridgeSocket);
      // end() rather than destroy(): the bridge should see a clean FIN so it
      // releases the controller session immediately.
      if (!clientSocket.destroyed) clientSocket.end();
      if (!bridgeSocket.destroyed) bridgeSocket.end();
    };

    clientSocket.once("close", teardown);
    bridgeSocket.once("close", teardown);
    // Raw upgrade sockets have no default error handling; an unhandled one
    // takes the whole process down.
    clientSocket.on("error", teardown);
    bridgeSocket.on("error", teardown);

    const headers = Object.entries(response.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");
    clientSocket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`,
    );

    if (clientHead.length) bridgeSocket.write(clientHead);
    if (bridgeHead.length) clientSocket.write(bridgeHead);
    clientSocket.pipe(bridgeSocket).pipe(clientSocket);
  });

  upstream.on("error", (error) => {
    console.error(`[flexidim-web] bridge proxy failed: ${error.message}`);
    // A plain destroy here shows the user a silent, unexplained failure; the
    // 502 makes the client's onclose fire promptly so it retries.
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    }
  });

  upstream.end();
});

server.listen(port, hostname, () => {
  console.log(`[flexidim-web] listening on http://${hostname}:${port}`);
  console.log(`[flexidim-web] proxying /bridge to ${bridgeHost}:${bridgePort}`);
});

function shutdown() {
  for (const socket of proxyPairs) socket.end();
  server.close(() => process.exit(0));
  setTimeout(() => {
    for (const socket of proxyPairs) socket.destroy();
    process.exit(0);
  }, 4000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
