import { metadata, queue, task } from "@trigger.dev/sdk";

export const sectionQueue = queue({
  name: "section-generation",
  concurrencyLimit: 10,
});

// Shared by every run in this process and wiped on restart.
const progressByAnalysis = new Map<string, number>();
let sectionsGenerated = 0;

export const generateSection = task({
  id: "generate-section",
  queue: sectionQueue,
  retry: { maxAttempts: 4 },
  run: async (payload: { analysisId: string; slug: string }) => {
    sectionsGenerated += 1;
    progressByAnalysis.set(payload.analysisId, sectionsGenerated);
    return { slug: payload.slug, body: `# ${payload.slug}` };
  },
  onCancel: async () => {},
});

export const analyseRepository = task({
  id: "analyse-repository",
  run: async (payload: { analysisId: string; sections: { slug: string }[] }) => {
    metadata.set("stage", "generating");

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

    return { completed, failed, seen: progressByAnalysis.get(payload.analysisId) };
  },
});
