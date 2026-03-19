import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type http from "node:http";

export type RequestContextStore = {
  requestHeaders?: http.IncomingHttpHeaders;
};

export type ServerFactoryOptions = {
  requestContext?: RequestContextStore;
};

export class ServerList {
  private _servers: Server[] = [];
  private _serverFactory: (options?: ServerFactoryOptions) => Promise<Server>;

  constructor(
    serverFactory: (options?: ServerFactoryOptions) => Promise<Server>,
  ) {
    this._serverFactory = serverFactory;
  }

  async create(options?: ServerFactoryOptions) {
    const server = await this._serverFactory(options);
    this._servers.push(server);
    return server;
  }

  async close(server: Server) {
    await server.close();
    const index = this._servers.indexOf(server);
    if (index !== -1) this._servers.splice(index, 1);
  }

  async closeAll() {
    await Promise.all(this._servers.map((server) => server.close()));
  }
}
