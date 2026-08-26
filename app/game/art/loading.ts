export type AssetProgressEvent = {
  loaded: number;
  total?: number;
};

export type LoadProgressSnapshot = {
  done: number;
  total: number;
  loadedBytes: number;
  totalBytes: number | null;
  mode: "bytes" | "files";
  ratio: number;
};

type AssetProgressRecord = {
  loaded: number;
  total: number | null;
  complete: boolean;
};

export function createByteProgressAggregator(urls: readonly string[]) {
  const records = new Map<string, AssetProgressRecord>(
    urls.map((url) => [url, { loaded: 0, total: null, complete: false }]),
  );

  const ensure = (url: string) => {
    const record = records.get(url) ?? { loaded: 0, total: null, complete: false };
    records.set(url, record);
    return record;
  };

  const snapshot = (): LoadProgressSnapshot => {
    const values = [...records.values()];
    const done = values.filter((record) => record.complete).length;
    const allTotalsKnown = values.length > 0 && values.every(
      (record) => record.total !== null && record.total > 0,
    );
    const loadedBytes = values.reduce((sum, record) => (
      sum + Math.min(record.loaded, record.total ?? record.loaded)
    ), 0);
    const totalBytes = allTotalsKnown
      ? values.reduce((sum, record) => sum + (record.total ?? 0), 0)
      : null;
    const ratio = allTotalsKnown && totalBytes
      ? loadedBytes / totalBytes
      : done / Math.max(values.length, 1);
    return {
      done,
      total: values.length,
      loadedBytes,
      totalBytes,
      mode: allTotalsKnown ? "bytes" : "files",
      ratio: Math.min(1, Math.max(0, ratio)),
    };
  };

  return {
    update(url: string, event: AssetProgressEvent) {
      const record = ensure(url);
      record.loaded = Math.max(record.loaded, Math.max(0, event.loaded));
      if (Number.isFinite(event.total) && (event.total ?? 0) > 0) {
        record.total = Math.max(record.total ?? 0, event.total ?? 0);
      }
      return snapshot();
    },
    complete(url: string) {
      const record = ensure(url);
      record.complete = true;
      if (record.total !== null) record.loaded = record.total;
      return snapshot();
    },
    snapshot,
  };
}

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, delayMs);
});

export async function retryWithBackoff<T>(
  task: (attempt: number) => Promise<T>,
  delaysMs: readonly number[],
  sleep: (delayMs: number) => Promise<void> = defaultSleep,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await task(attempt + 1);
    } catch (error) {
      lastError = error;
      if (attempt === delaysMs.length) break;
      await sleep(delaysMs[attempt]);
    }
  }
  throw lastError;
}
