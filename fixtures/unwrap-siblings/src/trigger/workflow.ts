import { metadata, queue, task } from "@trigger.dev/sdk";

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

    // unwrap() rethrows the child's error, so the first failing section takes
    // down the whole Promise.all and discards every sibling result.
    const sections = await Promise.all(
      payload.sections.map((section) =>
        generateSection
          .triggerAndWait(
            { analysisId: payload.analysisId, slug: section.slug },
            { idempotencyKey: `${payload.analysisId}:${section.slug}` },
          )
          .unwrap(),
      ),
    );

    return { overview: sections.map((s) => s.slug).join("\n") };
  },
});
