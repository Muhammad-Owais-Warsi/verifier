import { metadata, queue, runs, task } from "@trigger.dev/sdk";

export const sectionQueue = queue({
  name: "section-generation",
  concurrencyLimit: 10,
});

export const generateSection = task({
  id: "generate-section",
  queue: sectionQueue,
  retry: { maxAttempts: 4 },
  run: async (payload: { analysisId: string; slug: string }) => {
    return { slug: payload.slug, body: `# ${payload.slug}` };
  },
  onCancel: async () => {},
});

export const analyseRepository = task({
  id: "analyse-repository",
  run: async (payload: { analysisId: string; sections: { slug: string }[] }) => {
    metadata.set("stage", "generating");

    const handles = await Promise.all(
      payload.sections.map((section) =>
        generateSection.trigger(
          { analysisId: payload.analysisId, slug: section.slug },
          { idempotencyKey: `${payload.analysisId}:${section.slug}` },
        ),
      ),
    );

    const completed: string[] = [];
    const failed: string[] = [];

    // Polls the API with an in-process sleep instead of waiting at a
    // waitpoint, so the run stays resident for the whole generation.
    const pending = new Set(handles.map((handle) => handle.id));
    while (pending.size > 0) {
      for (const runId of [...pending]) {
        const run = await runs.retrieve(runId);
        if (run.status === "COMPLETED") {
          completed.push(runId);
          pending.delete(runId);
        } else if (run.status === "FAILED" || run.status === "CANCELED") {
          failed.push(runId);
          pending.delete(runId);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    return { completed, failed };
  },
});
