import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "driving-license-portal",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 5,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 60_000,
      factor: 2,
      randomize: true,
    },
  },
});
