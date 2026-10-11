import {
  mkdir as fsMkdir,
  open as fsOpen,
  rename as fsRename,
} from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Shared "write-temp-then-atomically-rename" persistence helper.
 *
 * Windows does not allow renaming a file over a destination that another
 * process currently has open (readers included, however briefly), and
 * returns EPERM/EBUSY/EACCES instead of the atomic replace succeeding. A
 * status reader polling the state file while the pool replaces it is a real,
 * recurring race rather than a hypothetical one. POSIX rename() does not have
 * this failure mode under normal contention, so the retry loop below is a
 * no-op there in practice (it only fires for the same transient error codes).
 */

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** ~20,50,100,200,400,800ms bounded exponential-ish backoff (plus jitter). */
export const DEFAULT_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * Thrown when every atomic-replace attempt for a canonical file failed. The
 * caller can distinguish this from other failures by name or
 * `instanceof`, and the old canonical file is guaranteed untouched: nothing
 * is ever deleted or truncated to make the rename succeed.
 */
export class AtomicWriteError extends Error {
  override readonly name = "AtomicWriteError";
  readonly targetPath: string;
  readonly tempPath: string;
  readonly attempts: number;
  readonly lastErrorCode: string | undefined;

  constructor(
    message: string,
    info: {
      targetPath: string;
      tempPath: string;
      attempts: number;
      cause: unknown;
    },
  ) {
    super(message, { cause: info.cause });
    this.targetPath = info.targetPath;
    this.tempPath = info.tempPath;
    this.attempts = info.attempts;
    this.lastErrorCode = (
      info.cause as NodeJS.ErrnoException | undefined
    )?.code;
  }
}

export interface AtomicWriteFsOps {
  mkdir: typeof fsMkdir;
  open: typeof fsOpen;
  rename: typeof fsRename;
}

const defaultFsOps: AtomicWriteFsOps = {
  mkdir: fsMkdir,
  open: fsOpen,
  rename: fsRename,
};

export interface AtomicWriteOptions {
  mode?: number;
  /** Delay before each retry, in order. Defaults to DEFAULT_RETRY_DELAYS_MS. */
  retryDelaysMs?: number[];
  /** Decides whether a rename error is worth retrying. Defaults to EPERM/EBUSY/EACCES. */
  isTransient?: (error: unknown) => boolean;
  /** Extra randomized delay added on top of each retry delay, as a fraction of it (default 0.25). */
  jitterRatio?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fsOps?: Partial<AtomicWriteFsOps>;
}

// Serializes concurrent writers to the same canonical path within this
// process. Cross-process contention is out of scope: a single process owns
// the state file and others only read it.
const writeQueues = new Map<string, Promise<unknown>>();

function withWriteQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const settled = previous.catch(() => undefined);
  const next = settled.then(task);
  writeQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Writes `data` to `targetPath` atomically: a unique temp file in the same
 * directory is written and flushed, then renamed over the target. Rename
 * failures with a transient Windows contention code are retried with
 * bounded backoff + jitter. The existing canonical file is never deleted or
 * truncated as part of this — on total failure it is left exactly as it
 * was, and the temp file is left on disk as diagnostic evidence rather than
 * silently discarded.
 */
export async function atomicWriteFile(
  targetPath: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  return withWriteQueue(targetPath, async () => {
    const fsOps: AtomicWriteFsOps = { ...defaultFsOps, ...options.fsOps };
    const directory = dirname(targetPath);
    await fsOps.mkdir(directory, { recursive: true });

    const mode = options.mode ?? 0o600;
    let nowMs = options.now ? options.now() : Date.now();
    let temporary = `${targetPath}.${process.pid}.${nowMs}.tmp`;
    // Exclusive create: a same-millisecond collision with another temp file
    // this process left behind (e.g. evidence from an earlier exhausted
    // write to the same target) must never be silently overwritten — bump
    // the timestamp component and try again instead.
    let handle: Awaited<ReturnType<AtomicWriteFsOps["open"]>>;
    for (;;) {
      try {
        handle = await fsOps.open(temporary, "wx", mode);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        nowMs += 1;
        temporary = `${targetPath}.${process.pid}.${nowMs}.tmp`;
      }
    }
    try {
      await handle.writeFile(data, "utf8");
      // Best-effort durability: flush to disk before the rename makes the
      // new content visible. Some filesystems/sandboxes don't support
      // fsync; that's not a reason to fail the write, since the rename
      // itself (the actual correctness guarantee here) still happens.
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }

    const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const isTransient = options.isTransient ?? isTransientRenameError;
    const sleep = options.sleep ?? defaultSleep;
    const jitterRatio = options.jitterRatio ?? 0.25;
    const random = options.random ?? Math.random;
    const totalAttempts = delays.length + 1;

    let lastError: unknown;
    let attemptsMade = 0;
    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      attemptsMade = attempt + 1;
      try {
        await fsOps.rename(temporary, targetPath);
        return;
      } catch (error) {
        lastError = error;
        const hasMoreAttempts = attempt < delays.length;
        if (!hasMoreAttempts || !isTransient(error)) break;
        const base = delays[attempt] ?? 0;
        await sleep(base + base * jitterRatio * random());
      }
    }

    throw new AtomicWriteError(
      `Failed to atomically replace ${targetPath} after ${attemptsMade} attempt(s): ${
        (lastError as Error)?.message ?? String(lastError)
      }`,
      {
        targetPath,
        tempPath: temporary,
        attempts: attemptsMade,
        cause: lastError,
      },
    );
  });
}
