import { logger, task } from "@trigger.dev/sdk/v3";
import sharp from "sharp";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

type ImageFormat =
  | "avif"
  | "gif"
  | "heif"
  | "jpeg"
  | "jp2"
  | "jxl"
  | "png"
  | "tiff"
  | "webp";

export interface StoredImage {
  /** A presigned PUT URL (or another endpoint accepting the image body). */
  uploadUrl: string;
  /** A URL from which later workflow stages can read the uploaded image. */
  downloadUrl: string;
  /** Additional headers required by the upload provider. */
  uploadHeaders?: Record<string, string>;
}

export interface Transform {
  format: ImageFormat;
  quality?: number;
  width?: number;
  height?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
}

export interface TransformRequest {
  sourceUrl: string;
  destination: StoredImage;
  transform: Transform;
}

export interface TransformResult {
  url: string;
  format: ImageFormat;
  width: number | null;
  height: number | null;
  bytes: number;
}

async function downloadImage(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Image URLs must use HTTP or HTTPS");
  }

  const response = await fetch(parsed, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download image: HTTP ${response.status}`);
  }

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_SOURCE_BYTES) {
    throw new Error(`Image exceeds the ${MAX_SOURCE_BYTES} byte limit`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error(`Image exceeds the ${MAX_SOURCE_BYTES} byte limit`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks, size);
}

export const transformImage = task({
  id: "transform-image",
  maxDuration: 300,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 10_000,
  },
  run: async (payload: TransformRequest): Promise<TransformResult> => {
    const input = await downloadImage(payload.sourceUrl);
    const { width, height, fit = "inside", format, quality = 82 } =
      payload.transform;

    let pipeline = sharp(input, {
      failOn: "warning",
      limitInputPixels: 100_000_000,
    }).rotate();

    if (width !== undefined || height !== undefined) {
      pipeline = pipeline.resize({ width, height, fit, withoutEnlargement: true });
    }

    const output = await pipeline
      .toFormat(format, { quality })
      .withMetadata({ orientation: undefined })
      .toBuffer();

    const metadata = await sharp(output).metadata();
    const contentType = `image/${format}`;
    const upload = await fetch(payload.destination.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        ...payload.destination.uploadHeaders,
      },
      body: output.buffer.slice(
        output.byteOffset,
        output.byteOffset + output.byteLength,
      ) as ArrayBuffer,
      signal: AbortSignal.timeout(60_000),
    });

    if (!upload.ok) {
      throw new Error(`Could not upload transformed image: HTTP ${upload.status}`);
    }

    logger.info("Image transformation complete", {
      format,
      width: metadata.width,
      height: metadata.height,
      bytes: output.byteLength,
    });

    return {
      url: payload.destination.downloadUrl,
      format,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      bytes: output.byteLength,
    };
  },
});

export interface DerivedImage {
  name: string;
  source: "optimized" | "thumbnail";
  destination: StoredImage;
  transform: Transform;
}

export interface ProcessImagePayload {
  imageId: string;
  sourceUrl: string;
  optimized: {
    destination: StoredImage;
    transform: Transform;
  };
  thumbnail: {
    destination: StoredImage;
    transform: Transform;
  };
  /** Formats derived from either first-stage output. */
  derived?: DerivedImage[];
}

function unwrap(
  result:
    | { ok: true; output: TransformResult }
    | { ok: false; error: unknown },
  label: string,
): TransformResult {
  if (result.ok) return result.output;
  throw new Error(`${label} failed: ${String(result.error)}`);
}

/**
 * One invocation processes exactly one image. Keep the returned run ID in the
 * application so cancelling that run cancels only this image and its children.
 */
export const processImage = task({
  id: "process-image",
  maxDuration: 900,
  run: async (payload: ProcessImagePayload) => {
    logger.info("Starting image workflow", { imageId: payload.imageId });

    // Both transformations use the original upload, so Trigger can run them
    // concurrently as one batch.
    const firstStage = await transformImage.batchTriggerAndWait([
      {
        payload: {
          sourceUrl: payload.sourceUrl,
          destination: payload.optimized.destination,
          transform: payload.optimized.transform,
        },
      },
      {
        payload: {
          sourceUrl: payload.sourceUrl,
          destination: payload.thumbnail.destination,
          transform: payload.thumbnail.transform,
        },
      },
    ]);

    const optimized = unwrap(firstStage.runs[0], "optimized image");
    const thumbnail = unwrap(firstStage.runs[1], "thumbnail");
    const derivedDefinitions = payload.derived ?? [];

    // These depend on stage one, but are independent of each other.
    const derivedBatch =
      derivedDefinitions.length === 0
        ? undefined
        : await transformImage.batchTriggerAndWait(
            derivedDefinitions.map((item) => ({
              payload: {
                sourceUrl:
                  item.source === "optimized" ? optimized.url : thumbnail.url,
                destination: item.destination,
                transform: item.transform,
              },
            })),
          );

    const derived = Object.fromEntries(
      derivedDefinitions.map((item, index) => [
        item.name,
        unwrap(derivedBatch!.runs[index], `derived image "${item.name}"`),
      ]),
    );

    return {
      imageId: payload.imageId,
      optimized,
      thumbnail,
      derived,
    };
  },
});
