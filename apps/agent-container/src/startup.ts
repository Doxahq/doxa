import type { Server } from "node:http";

export interface StartContainerServerOptions {
  port: number;
  preflight(): Promise<void>;
  createServer(): Server;
  onListening?(): void;
}

export async function startContainerServer(
  options: StartContainerServerOptions,
): Promise<Server> {
  await options.preflight();
  const server = options.createServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, () => {
      server.off("error", onError);
      options.onListening?.();
      resolve();
    });
  });

  return server;
}
