import { queue, task } from "@trigger.dev/sdk";

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
});

export const analyseRepository = task({
  id: "analyse-repository",
  run: async (payload: { analysisId: string; sections: { slug: string }[] }) => {
    // Correctly orchestrated, but nothing is published for the frontend, no
    // cancellation is handled, and a parent retry re-dispatches every section.
    const batch = await generateSection.batchTriggerAndWait(
      payload.sections.map((section) => ({
        payload: { analysisId: payload.analysisId, slug: section.slug },
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
