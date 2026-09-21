/**
 * CORRECT: each run's ok flag is checked, just not in the task body.
 *
 * One `unwrap(result, label)` helper beside the task, called once per run, is
 * a routine way to write this. Collecting `.ok` reads only from descendants
 * of the task saw none of them, so a submission that handled every per-item
 * outcome was reported as ignoring them all -- and the failure-isolation
 * check, which reads the same fact, failed with it.
 *
 * Expected to pass: per_item_outcome, failure_isolated.
 */
import { metadata, queue, task } from "@trigger.dev/sdk";

const renderQueue = queue({
  name: "render",
  concurrencyLimit: 4,
});

const retry = {
  maxAttempts: 5,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 30_000,
  randomize: true,
};

interface Rendition {
  format: string;
  bytes: number;
}

/** The only place `.ok` is read, and it is outside every task. */
function unwrap<TOutput>(
  result: { ok: true; output: TOutput } | { ok: false },
  label: string,
): TOutput {
  if (result.ok) return result.output;
  throw new Error(`${label} did not render`);
}

export const renderFormat = task({
  id: "render-format",
  queue: renderQueue,
  retry,
  run: async (payload: { imageId: string; format: string }, { signal }): Promise<Rendition> => {
    await fetch(`https://cdn.test/${payload.imageId}.${payload.format}`, { signal });
    return { format: payload.format, bytes: 1_024 };
  },
  onCancel: async () => {},
});

export const renderImage = task({
  id: "render-image",
  retry,
  run: async (payload: { imageId: string; formats: string[] }) => {
    metadata.set("total", payload.formats.length);

    const batch = await renderFormat.batchTriggerAndWait(
      payload.formats.map((format) => ({
        payload: { imageId: payload.imageId, format },
      })),
    );

    const rendered = batch.runs.map((run, index) => unwrap(run, payload.formats[index]));

    metadata.set("rendered", rendered.length);
    return { imageId: payload.imageId, rendered: rendered.length };
  },
});
