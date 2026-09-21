import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_sarathi_dl_portal",
  dirs: ["./src/trigger"],
  runtime: "node",
  logLevel: "info",
  // Nothing in this system should legitimately occupy a worker for more than 15
  // minutes; anything longer is a stuck external call and should be killed so the
  // slot returns to the pool.
  maxDuration: 900,
  machine: "small-1x",
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 5,
      factor: 2,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
  },
});
