export type AssetLoadErrorCode =
  | "ASSET_ABORTED"
  | "ASSET_TIMEOUT"
  | "ASSET_HTTP"
  | "ASSET_NETWORK"
  | "ASSET_RESPONSE";

export interface AssetRetryPolicy {
  /** Total attempts including the first request. */
  readonly maximumAttempts: number;
  readonly baseDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
  /** Symmetric proportional jitter in the inclusive range 0..1. */
  readonly jitterRatio: number;
}

export interface AssetLoadErrorOptions {
  readonly code: AssetLoadErrorCode;
  readonly url: string;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
}

export class AssetLoadError extends Error {
  readonly code: AssetLoadErrorCode;
  readonly url: string;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(message: string, options: AssetLoadErrorOptions) {
    super(message);
    this.name = "AssetLoadError";
    this.code = options.code;
    this.url = options.url;
    this.attempt = options.attempt;
    this.retryable = options.retryable;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export const DEFAULT_ASSET_RETRY_POLICY: AssetRetryPolicy = Object.freeze({
  maximumAttempts: 3,
  baseDelayMilliseconds: 350,
  maximumDelayMilliseconds: 4_000,
  jitterRatio: 0.2,
});

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

/**
 * Returns every non-data URI referenced by a binary glTF. Callers can prefetch
 * these dependencies through the same retry, timeout and abort policy as the
 * parent GLB before handing the bytes to Three.js.
 */
export function externalAssetUrisFromGlb(buffer: ArrayBuffer): readonly string[] {
  if (buffer.byteLength < 20) return [];
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) return [];
  const declaredLength = view.getUint32(8, true);
  const availableLength = Math.min(buffer.byteLength, declaredLength);
  let offset = 12;
  let document: {
    images?: Array<{ uri?: unknown }>;
    buffers?: Array<{ uri?: unknown }>;
  } | null = null;

  while (offset + 8 <= availableLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > availableLength) return [];
    if (chunkType === GLB_JSON_CHUNK) {
      try {
        const json = new TextDecoder()
          .decode(new Uint8Array(buffer, chunkStart, chunkLength))
          .replace(/\u0000+$/u, "")
          .trim();
        document = JSON.parse(json);
      } catch {
        return [];
      }
      break;
    }
    offset = chunkEnd;
  }
  if (!document) return [];

  const uris = [
    ...(document.buffers ?? []).map(({ uri }) => uri),
    ...(document.images ?? []).map(({ uri }) => uri),
  ];
  return Object.freeze([...new Set(
    uris.filter((uri): uri is string => (
      typeof uri === "string"
      && uri.length > 0
      && !uri.startsWith("data:")
      && !uri.startsWith("blob:")
    )),
  )]);
}

export interface AssetHttpClassification {
  readonly retryable: boolean;
  readonly category: "throttled" | "timeout" | "server" | "client" | "redirect" | "other";
}

/** Pure HTTP policy: retry only failures that can reasonably recover unchanged. */
export function classifyAssetHttpStatus(status: number): AssetHttpClassification {
  if (status === 408) return { retryable: true, category: "timeout" };
  if (status === 425 || status === 429) return { retryable: true, category: "throttled" };
  if (status >= 500 && status <= 599) return { retryable: true, category: "server" };
  if (status >= 400 && status <= 499) return { retryable: false, category: "client" };
  if (status >= 300 && status <= 399) return { retryable: false, category: "redirect" };
  return { retryable: false, category: "other" };
}

/**
 * One-based failed-attempt delay. Passing 0.5 as randomValue produces the
 * unjittered exponential delay, which keeps deterministic tests readable.
 */
export function assetRetryDelayMilliseconds(
  failedAttempt: number,
  policy: AssetRetryPolicy = DEFAULT_ASSET_RETRY_POLICY,
  randomValue = Math.random(),
): number {
  const attempt = Math.max(1, Math.floor(failedAttempt));
  const unitRandom = Math.min(1, Math.max(0, Number.isFinite(randomValue) ? randomValue : 0.5));
  const exponential = policy.baseDelayMilliseconds * (2 ** (attempt - 1));
  const capped = Math.min(policy.maximumDelayMilliseconds, exponential);
  const jitter = capped * policy.jitterRatio * ((unitRandom * 2) - 1);
  return Math.round(Math.min(policy.maximumDelayMilliseconds, Math.max(0, capped + jitter)));
}

type AssetFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AssetSleeper = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type TimeoutHandle = unknown;

export interface SceneAssetLoaderOptions {
  readonly signal?: AbortSignal;
  readonly maximumConcurrentRequests?: number;
  readonly timeoutMilliseconds?: number;
  readonly retry?: Partial<AssetRetryPolicy>;
  readonly fetcher?: AssetFetcher;
  readonly sleeper?: AssetSleeper;
  readonly random?: () => number;
  readonly scheduleTimeout?: (callback: () => void, milliseconds: number) => TimeoutHandle;
  readonly cancelTimeout?: (handle: TimeoutHandle) => void;
}

export interface AssetArrayBufferRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly retry?: Partial<AssetRetryPolicy>;
  readonly requestInit?: Omit<RequestInit, "signal">;
}

export interface SceneAssetLoaderSnapshot {
  readonly activeRequests: number;
  readonly queuedRequests: number;
  readonly aborted: boolean;
}

export interface SceneAssetLoader {
  readonly signal: AbortSignal;
  fetchArrayBuffer(
    input: RequestInfo | URL,
    options?: AssetArrayBufferRequestOptions,
  ): Promise<ArrayBuffer>;
  abort(reason?: unknown): void;
  getSnapshot(): SceneAssetLoaderSnapshot;
}

type QueueEntry = {
  readonly operation: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
};

class FetchConcurrencyLimiter {
  private activeRequests = 0;
  private readonly queue: QueueEntry[] = [];
  private readonly maximumConcurrentRequests: number;

  constructor(maximumConcurrentRequests: number) {
    this.maximumConcurrentRequests = maximumConcurrentRequests;
  }

  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", entry.onAbort);
          reject(abortReason(signal));
        },
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  snapshot(): Pick<SceneAssetLoaderSnapshot, "activeRequests" | "queuedRequests"> {
    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.queue.length,
    };
  }

  private pump() {
    while (
      this.activeRequests < this.maximumConcurrentRequests
      && this.queue.length > 0
    ) {
      const entry = this.queue.shift()!;
      entry.signal.removeEventListener("abort", entry.onAbort);
      if (entry.signal.aborted) {
        entry.reject(abortReason(entry.signal));
        continue;
      }
      this.activeRequests += 1;
      void entry.operation()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.activeRequests -= 1;
          this.pump();
        });
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Asset request was aborted");
  error.name = "AbortError";
  return error;
}

function relayAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(abortReason(source));
    return () => {};
  }
  const onAbort = () => target.abort(abortReason(source));
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function defaultSleeper(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const handle = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(handle);
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizedPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function normalizedNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number`);
  return value;
}

function normalizedRetryPolicy(overrides: Partial<AssetRetryPolicy> = {}): AssetRetryPolicy {
  const policy = {
    ...DEFAULT_ASSET_RETRY_POLICY,
    ...overrides,
  };
  const normalized = {
    maximumAttempts: normalizedPositiveInteger(policy.maximumAttempts, "maximumAttempts"),
    baseDelayMilliseconds: normalizedNonNegative(
      policy.baseDelayMilliseconds,
      "baseDelayMilliseconds",
    ),
    maximumDelayMilliseconds: normalizedNonNegative(
      policy.maximumDelayMilliseconds,
      "maximumDelayMilliseconds",
    ),
    jitterRatio: normalizedNonNegative(policy.jitterRatio, "jitterRatio"),
  };
  if (normalized.jitterRatio > 1) throw new RangeError("jitterRatio must not exceed 1");
  if (normalized.maximumDelayMilliseconds < normalized.baseDelayMilliseconds) {
    throw new RangeError("maximumDelayMilliseconds must be at least baseDelayMilliseconds");
  }
  return normalized;
}

function abortedLoadError(url: string, attempt: number, cause?: unknown): AssetLoadError {
  return new AssetLoadError(`Asset request aborted: ${url}`, {
    code: "ASSET_ABORTED",
    url,
    attempt,
    retryable: false,
    cause,
  });
}

function normalizeUnknownFailure(
  error: unknown,
  url: string,
  attempt: number,
  requestSignal: AbortSignal,
): AssetLoadError {
  if (error instanceof AssetLoadError) return error;
  if (requestSignal.aborted) return abortedLoadError(url, attempt, error);
  return new AssetLoadError(`Asset network request failed: ${url}`, {
    code: "ASSET_NETWORK",
    url,
    attempt,
    retryable: true,
    cause: error,
  });
}

export function createSceneAssetLoader(
  options: SceneAssetLoaderOptions = {},
): SceneAssetLoader {
  const sceneController = new AbortController();
  let detachParentAbort = options.signal
    ? relayAbort(options.signal, sceneController)
    : () => {};
  const maximumConcurrentRequests = normalizedPositiveInteger(
    options.maximumConcurrentRequests ?? 3,
    "maximumConcurrentRequests",
  );
  const defaultTimeoutMilliseconds = normalizedNonNegative(
    options.timeoutMilliseconds ?? 20_000,
    "timeoutMilliseconds",
  );
  const defaultRetry = normalizedRetryPolicy(options.retry);
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const sleeper = options.sleeper ?? defaultSleeper;
  const random = options.random ?? Math.random;
  const scheduleTimeout = options.scheduleTimeout
    ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
  const cancelTimeout = options.cancelTimeout
    ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const limiter = new FetchConcurrencyLimiter(maximumConcurrentRequests);

  const abort = (reason?: unknown) => {
    if (!sceneController.signal.aborted) sceneController.abort(reason);
    detachParentAbort();
    detachParentAbort = () => {};
  };

  const fetchAttempt = async (
    input: RequestInfo | URL,
    url: string,
    attempt: number,
    requestSignal: AbortSignal,
    timeoutMilliseconds: number,
    requestInit: Omit<RequestInit, "signal"> | undefined,
  ): Promise<ArrayBuffer> => {
    const attemptController = new AbortController();
    const detachRequestAbort = relayAbort(requestSignal, attemptController);
    let timedOut = false;
    const timeoutHandle = timeoutMilliseconds > 0
      ? scheduleTimeout(() => {
          timedOut = true;
          attemptController.abort(new Error(`Asset request exceeded ${timeoutMilliseconds}ms`));
        }, timeoutMilliseconds)
      : null;
    try {
      let response: Response;
      try {
        response = await raceWithSignal(
          fetcher(input, { ...requestInit, signal: attemptController.signal }),
          attemptController.signal,
        );
      } catch (error) {
        if (requestSignal.aborted) throw abortedLoadError(url, attempt, error);
        if (timedOut) {
          throw new AssetLoadError(`Asset request timed out after ${timeoutMilliseconds}ms: ${url}`, {
            code: "ASSET_TIMEOUT",
            url,
            attempt,
            retryable: true,
            cause: error,
          });
        }
        throw new AssetLoadError(`Asset network request failed: ${url}`, {
          code: "ASSET_NETWORK",
          url,
          attempt,
          retryable: true,
          cause: error,
        });
      }
      if (!response.ok) {
        const classification = classifyAssetHttpStatus(response.status);
        throw new AssetLoadError(`Asset request returned HTTP ${response.status}: ${url}`, {
          code: "ASSET_HTTP",
          url,
          attempt,
          status: response.status,
          retryable: classification.retryable,
        });
      }
      try {
        return await raceWithSignal(response.arrayBuffer(), attemptController.signal);
      } catch (error) {
        if (requestSignal.aborted) throw abortedLoadError(url, attempt, error);
        if (timedOut) {
          throw new AssetLoadError(`Asset response timed out after ${timeoutMilliseconds}ms: ${url}`, {
            code: "ASSET_TIMEOUT",
            url,
            attempt,
            retryable: true,
            cause: error,
          });
        }
        throw new AssetLoadError(`Asset response body could not be read: ${url}`, {
          code: "ASSET_RESPONSE",
          url,
          attempt,
          retryable: true,
          cause: error,
        });
      }
    } finally {
      detachRequestAbort();
      if (timeoutHandle !== null) cancelTimeout(timeoutHandle);
    }
  };

  const fetchArrayBuffer = async (
    input: RequestInfo | URL,
    requestOptions: AssetArrayBufferRequestOptions = {},
  ): Promise<ArrayBuffer> => {
    const url = String(input);
    const requestController = new AbortController();
    const detachSceneAbort = relayAbort(sceneController.signal, requestController);
    const detachRequestAbort = requestOptions.signal
      ? relayAbort(requestOptions.signal, requestController)
      : () => {};
    const retry = normalizedRetryPolicy({
      ...defaultRetry,
      ...requestOptions.retry,
    });
    const timeoutMilliseconds = normalizedNonNegative(
      requestOptions.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
      "timeoutMilliseconds",
    );
    let attempt = 0;
    try {
      while (attempt < retry.maximumAttempts) {
        attempt += 1;
        let failure: AssetLoadError;
        try {
          return await limiter.run(
            () => fetchAttempt(
              input,
              url,
              attempt,
              requestController.signal,
              timeoutMilliseconds,
              requestOptions.requestInit,
            ),
            requestController.signal,
          );
        } catch (error) {
          failure = normalizeUnknownFailure(error, url, attempt, requestController.signal);
        }
        if (!failure.retryable || attempt >= retry.maximumAttempts) throw failure;
        const delay = assetRetryDelayMilliseconds(attempt, retry, random());
        try {
          await raceWithSignal(sleeper(delay, requestController.signal), requestController.signal);
        } catch (error) {
          throw abortedLoadError(url, attempt, error);
        }
      }
      throw new Error("Unreachable asset retry state");
    } finally {
      detachRequestAbort();
      detachSceneAbort();
    }
  };

  return {
    signal: sceneController.signal,
    fetchArrayBuffer,
    abort,
    getSnapshot: () => ({
      ...limiter.snapshot(),
      aborted: sceneController.signal.aborted,
    }),
  };
}
