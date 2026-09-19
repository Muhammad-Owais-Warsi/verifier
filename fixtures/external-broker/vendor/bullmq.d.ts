/**
 * Minimal stand-in for the real `bullmq` types.
 *
 * A submission that bolts on a second queue would have the package installed,
 * but fixtures cannot rely on node_modules being present, so this fixture maps
 * the specifier to this stub through its own tsconfig. The check matches the
 * import specifier, which is identical either way.
 */
declare module "bullmq" {
  export interface QueueOptions {
    connection?: { host: string; port: number };
  }

  export interface JobsOptions {
    attempts?: number;
    backoff?: { type: string; delay: number };
  }

  export class Queue<T = unknown> {
    constructor(name: string, options?: QueueOptions);
    add(name: string, data: T, options?: JobsOptions): Promise<{ id: string }>;
    close(): Promise<void>;
  }

  export class Worker<T = unknown> {
    constructor(
      name: string,
      processor: (job: { id: string; data: T }) => Promise<unknown>,
      options?: QueueOptions & { concurrency?: number },
    );
    close(): Promise<void>;
  }
}
