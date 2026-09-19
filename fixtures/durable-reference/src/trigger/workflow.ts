import { metadata, queue, task } from "@trigger.dev/sdk";

export const sectionQueue = queue({
  name: "section-generation",
  concurrencyLimit: 10,
});

interface SectionPayload {
  analysisId: string;
  slug: string;
  title: string;
}

export const generateSection = task({
  id: "generate-section",
  queue: sectionQueue,
  retry: {
    maxAttempts: 4,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: SectionPayload) => {
    const body = `# ${payload.title}\n\ngenerated for ${payload.analysisId}`;
    return { slug: payload.slug, body };
  },
  onCancel: async ({ payload }) => {
    await metadata.parent.append("cancelledSections", payload.slug);
  },
});

interface AnalysisPayload {
  analysisId: string;
  sections: { slug: string; title: string }[];
}

export const analyseRepository = task({
  id: "analyse-repository",
  run: async (payload: AnalysisPayload) => {
    metadata.set("stage", "generating");
    metadata.set("total", payload.sections.length);

    const batch = await generateSection.batchTriggerAndWait(
      payload.sections.map((section) => ({
        payload: { ...section, analysisId: payload.analysisId },
        options: {
          idempotencyKey: `${payload.analysisId}:${section.slug}`,
          concurrencyKey: payload.analysisId,
          tags: [`analysis:${payload.analysisId}`],
        },
      })),
    );

    const completed: { slug: string; body: string }[] = [];
    const failed: string[] = [];

    batch.runs.forEach((run, index) => {
      const section = payload.sections[index];
      if (run.ok) {
        completed.push(run.output);
      } else {
        failed.push(section.slug);
      }
      metadata.increment("finished", 1);
    });

    metadata.set("stage", "overview");

    return {
      analysisId: payload.analysisId,
      overview: completed.map((section) => `- ${section.slug}`).join("\n"),
      completed: completed.map((section) => section.slug),
      failed,
    };
  },
});
