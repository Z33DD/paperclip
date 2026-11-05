import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startNetworkAllowlistProxy } from "./local-process-sandbox.js";

/** An upstream that keeps sending, so the proxy is mid-write when the client disappears. */
async function startFloodingUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const chunk = Buffer.alloc(64 * 1024, "x");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    const flood = () => {
      while (!socket.destroyed && socket.write(chunk)) { /* until backpressure */ }
    };
    socket.on("drain", flood);
    socket.on("close", () => sockets.delete(socket));
    flood();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Opens a CONNECT tunnel and kills the client as soon as tunnelled bytes arrive, like a dying sandbox. */
function openTunnelAndVanish(socketPath: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    client.on("error", () => undefined);
    client.on("close", () => resolve());
    client.once("data", () => client.destroy());
    setTimeout(() => reject(new Error("tunnel never delivered data")), 5_000).unref();
  });
}

describe("network allowlist proxy", () => {
  it("survives a client that disappears in the middle of a CONNECT tunnel", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-proxy-"));
    const socketPath = path.join(dir, "proxy.sock");
    const upstream = await startFloodingUpstream();
    const proxy = await startNetworkAllowlistProxy(["127.0.0.1"], [], socketPath);
    // Without an error listener on the client socket this EPIPE is thrown out of the event loop,
    // which in production exits the whole Paperclip server.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      for (let i = 0; i < 40; i += 1) await openTunnelAndVanish(socketPath, upstream.port);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await proxy.close();
      await upstream.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
