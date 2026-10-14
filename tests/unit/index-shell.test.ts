import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { start, type ServerStartDeps } from "../../src/server.ts";

test("root HTML uses only local assets and cannot trigger a remote request", async () => {
  const createLoopbackServer = ((listener: RequestListener) => {
    const server = createHttpServer(listener);
    const listen = server.listen.bind(server);
    server.listen = ((port: number, callback?: () => void) =>
      listen(port, "127.0.0.1", callback)) as Server["listen"];
    return server;
  }) as NonNullable<ServerStartDeps["createServer"]>;

  const server = await start(0, {
    env: { DATABASE_URL: "postgres://unused" },
    ensureDevDb: async () => "ready",
    connectDb: (() => ({})) as never,
    build: async () => ({}) as never,
    createServer: createLoopbackServer,
  });

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /href="\/web\/styles\.css"/);
    assert.match(html, /src="\/web\/app\.js"/);
    assert.doesNotMatch(html, /(?:href|src)=["']https?:\/\//i);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
