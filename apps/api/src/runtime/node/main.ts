import "./strict-public-fetch-preload";
import { startServer } from "./server";

startServer().catch((cause: unknown) => {
  console.error("The doxa-api origin did not start.", cause);
  process.exit(1);
});
