/**
 * Everything correct, but every SDK import is aliased and a local variable is
 * called `metadata`. Recognising primitives by identifier text misses all of it.
 */
import {
  metadata as runMeta,
  queue as defineQueue,
  task as defineTask,
  wait as durableWait,
} from "@trigger.dev/sdk";

export const sectionQueue = defineQueue({
  name: "section-generation",
  concurrencyLimit: 10,
});

export const generateSection = defineTask({
  id: "generate-section",
  queue: sectionQueue,
  retry: { maxAttempts: 4, minTimeoutInMs: 1000 },
  run: async (payload: { analysisId: string; slug: string }) => {
    // A plain object that happens to be named `metadata`.
    const metadata = { slug: payload.slug, words: 120 };
    await durableWait.for({ seconds: 1 });
    return metadata;
  },
  onCancel: async () => {},
});

export const analyseRepository = defineTask({
  id: "analyse-repository",
  run: async (payload: { analysisId: string; sections: { slug: string }[] }) => {
    runMeta.set("stage", "generating");

    const batch = await generateSection.batchTriggerAndWait(
      payload.sections.map((section) => ({
        payload: { analysisId: payload.analysisId, slug: section.slug },
        options: { idempotencyKey: `${payload.analysisId}:${section.slug}` },
      })),
    );

    const completed: string[] = [];
    const failed: string[] = [];

    batch.runs.forEach((run, index) => {
      if (run.ok) completed.push(run.output.slug);
      else failed.push(payload.sections[index].slug);
    });

    return { completed, failed };
  },
});
