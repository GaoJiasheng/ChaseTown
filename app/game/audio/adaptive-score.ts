export const EXPLORE_SCORE_URL = "/audio/slow-drift-explore.m4a";
export const THREAT_SCORE_URL = "/audio/slow-drift-threat.m4a";

export interface AdaptiveScorePrewarmResult {
  loaded: string[];
  failed: string[];
}

type AudioAssetFetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Materialize both mastered stems in the HTTP cache while the 3D scene loads.
 * Audio elements are still created only inside a user gesture, preserving
 * mobile autoplay guarantees without making the first chase wait on a fetch.
 */
export async function prewarmAdaptiveScoreAssets(
  fetcher: AudioAssetFetcher = (input, init) => globalThis.fetch(input, init),
  signal?: AbortSignal,
): Promise<AdaptiveScorePrewarmResult> {
  const urls = [EXPLORE_SCORE_URL, THREAT_SCORE_URL];
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetcher(url, { cache: "force-cache", credentials: "same-origin", signal });
      if (!response.ok) throw new Error(`Score prewarm failed with HTTP ${response.status}`);
      await response.arrayBuffer();
      return { url, loaded: true };
    } catch {
      return { url, loaded: false };
    }
  }));
  return {
    loaded: results.filter((result) => result.loaded).map((result) => result.url),
    failed: results.filter((result) => !result.loaded).map((result) => result.url),
  };
}

const EXPLORE_GAIN_FLOOR = 0.4;
const THREAT_GAIN_MAX = 0.94;
const ATTACK_SECONDS = 0.22;
const RELEASE_SECONDS = 1.2;
const MUTE_RAMP_SECONDS = 0.03;
const SYNC_INTERVAL_MS = 250;
const SYNC_TOLERANCE_SECONDS = 0.025;

export type AdaptiveScoreStatus = "idle" | "unlocking" | "playing" | "suspended" | "error" | "disposed";

export type AdaptiveScoreStatusEvent = "begin-unlock" | "play" | "suspend" | "fail" | "dispose";

export type AdaptiveScoreErrorCode =
  | "unsupported-environment"
  | "context-create-failed"
  | "media-source-failed"
  | "context-resume-failed"
  | "media-play-failed"
  | "media-runtime-error"
  | "visibility-resume-failed"
  | "synchronization-failed"
  | "gain-automation-failed"
  | "mute-automation-failed"
  | "invalid-threat"
  | "disposed"
  | "dispose-failed"
  | "context-close-failed";

export interface AdaptiveScoreDiagnostic {
  code: AdaptiveScoreErrorCode;
  message: string;
  cause: string | null;
  track: "explore" | "threat" | null;
  timestampMs: number;
}

export interface AdaptiveGains {
  explore: number;
  threat: number;
}

export interface AdaptiveScoreTrackSnapshot {
  url: string;
  currentTimeSeconds: number | null;
  durationSeconds: number | null;
  paused: boolean | null;
  readyState: number | null;
  mediaErrorCode: number | null;
}

export interface AdaptiveScoreSnapshot {
  status: AdaptiveScoreStatus;
  unlocked: boolean;
  muted: boolean;
  threat: number;
  targetGains: AdaptiveGains;
  contextState: string | null;
  driftSeconds: number | null;
  explore: AdaptiveScoreTrackSnapshot;
  threatTrack: AdaptiveScoreTrackSnapshot;
  lastError: AdaptiveScoreDiagnostic | null;
}

export type AdaptiveScoreResult =
  | { ok: true; snapshot: AdaptiveScoreSnapshot }
  | { ok: false; error: AdaptiveScoreDiagnostic; snapshot: AdaptiveScoreSnapshot };

interface RuntimeTrack {
  kind: "explore" | "threat";
  url: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  onError: () => void;
  onPlaying: () => void;
  onLoadedMetadata: () => void;
}

export interface AdaptiveScoreEnvironment {
  createAudioContext(): AudioContext;
  createAudioElement(url: string): HTMLAudioElement;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof globalThis.setInterval>;
  clearInterval(handle: ReturnType<typeof globalThis.setInterval>): void;
  nowMs(): number;
  visibilityDocument: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> | null;
}

export function clampThreat(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Floor-preserving equal-power curve. It matches the mastered full-threat mix
 * (explore 0.40, threat 0.94) while keeping summed power almost constant.
 */
export function calculateAdaptiveGains(threat: number): AdaptiveGains {
  const normalized = clampThreat(Number.isFinite(threat) ? threat : 0);
  return {
    explore: Math.sqrt(1 - (1 - EXPLORE_GAIN_FLOOR ** 2) * normalized),
    threat: THREAT_GAIN_MAX * Math.sqrt(normalized),
  };
}

/** Interprets attack/release values as time-to-roughly-95%-settled. */
export function smoothingTimeConstant(previousThreat: number, nextThreat: number): number {
  return (nextThreat >= previousThreat ? ATTACK_SECONDS : RELEASE_SECONDS) / 3;
}

/** Signed target-minus-reference drift, corrected across a shared loop seam. */
export function calculateWrappedDrift(
  referenceSeconds: number,
  targetSeconds: number,
  durationSeconds: number | null,
): number {
  let drift = targetSeconds - referenceSeconds;
  if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0 && Math.abs(drift) > durationSeconds / 2) {
    drift -= Math.sign(drift) * durationSeconds;
  }
  return drift;
}

export function reduceAdaptiveScoreStatus(
  status: AdaptiveScoreStatus,
  event: AdaptiveScoreStatusEvent,
): AdaptiveScoreStatus {
  if (status === "disposed") return "disposed";
  if (event === "dispose") return "disposed";
  if (status === "error" && event !== "begin-unlock") return "error";
  if (event === "fail") return "error";
  if (event === "begin-unlock") return "unlocking";
  if (event === "play") return "playing";
  if (event === "suspend") return status === "idle" ? "idle" : "suspended";
  return status;
}

function describeCause(cause: unknown): string | null {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (cause === undefined || cause === null) return null;
  try {
    return typeof cause === "string" ? cause : JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function defaultEnvironment(): AdaptiveScoreEnvironment | null {
  const scope = globalThis as typeof globalThis & {
    Audio?: new (src?: string) => HTMLAudioElement;
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
    document?: Document;
  };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  const AudioElement = scope.Audio;
  if (!Context || !AudioElement) return null;
  return {
    createAudioContext: () => new Context(),
    createAudioElement: () => new AudioElement(),
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle) => globalThis.clearInterval(handle),
    nowMs: () => Date.now(),
    visibilityDocument: scope.document ?? null,
  };
}

function holdAndSchedule(param: AudioParam, value: number, now: number, timeConstant: number) {
  if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
  else {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
  }
  param.setTargetAtTime(value, now, Math.max(timeConstant, 0.001));
}

export class AdaptiveScoreController {
  private readonly environment: AdaptiveScoreEnvironment | null;
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private explore: RuntimeTrack | null = null;
  private threatTrack: RuntimeTrack | null = null;
  private status: AdaptiveScoreStatus = "idle";
  private threat = 0;
  private muted = false;
  private lastError: AdaptiveScoreDiagnostic | null = null;
  private unlockPromise: Promise<AdaptiveScoreResult> | null = null;
  private syncTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private visibilityAttached = false;

  constructor(environment: AdaptiveScoreEnvironment | null = defaultEnvironment()) {
    // Construction is DOM-free. AudioContext and media elements are created
    // only by unlock(), which must be called from the first user gesture.
    this.environment = environment;
  }

  unlock(): Promise<AdaptiveScoreResult> {
    if (this.status === "disposed") return Promise.resolve(this.failure("disposed", "Adaptive score was already disposed"));
    if (
      this.status === "playing"
      && this.context?.state === "running"
      && this.explore
      && this.threatTrack
      && !this.explore.element.paused
      && !this.threatTrack.element.paused
    ) {
      // Interaction buttons also count as valid audio gestures. Once the two
      // mastered stems are running, those gestures must be idempotent: seeking
      // back to zero here would create an audible restart on every locker use.
      return Promise.resolve(this.success());
    }
    if (this.unlockPromise) return this.unlockPromise;
    this.unlockPromise = this.unlockInternal().finally(() => {
      this.unlockPromise = null;
    });
    return this.unlockPromise;
  }

  setThreat(value: number): AdaptiveScoreResult {
    if (this.status === "disposed") return this.failure("disposed", "Cannot set threat after disposal");
    if (!Number.isFinite(value)) return this.failure("invalid-threat", "Threat must be a finite number in the range 0..1", value);
    const previous = this.threat;
    this.threat = clampThreat(value);
    try {
      this.applyThreatGains(previous);
    } catch (cause) {
      return this.failure("gain-automation-failed", "Unable to schedule the adaptive score crossfade", cause);
    }
    return this.success();
  }

  setMuted(muted: boolean): AdaptiveScoreResult {
    if (this.status === "disposed") return this.failure("disposed", "Cannot change mute after disposal");
    this.muted = Boolean(muted);
    try {
      if (this.context && this.masterGain) {
        const now = this.context.currentTime;
        const gain = this.masterGain.gain;
        if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(now);
        else {
          gain.cancelScheduledValues(now);
          gain.setValueAtTime(gain.value, now);
        }
        gain.linearRampToValueAtTime(this.muted ? 0 : 1, now + MUTE_RAMP_SECONDS);
      }
    } catch (cause) {
      return this.failure("mute-automation-failed", "Unable to schedule the master mute transition", cause);
    }
    return this.success();
  }

  getSnapshot(): AdaptiveScoreSnapshot {
    let visibleStatus = this.status;
    if (visibleStatus === "playing" && this.context && this.context.state !== "running") visibleStatus = "suspended";
    const duration = this.sharedDuration();
    const drift = this.explore && this.threatTrack
      ? calculateWrappedDrift(this.explore.element.currentTime, this.threatTrack.element.currentTime, duration)
      : null;
    return {
      status: visibleStatus,
      unlocked: Boolean(this.context && this.explore && this.threatTrack),
      muted: this.muted,
      threat: this.threat,
      targetGains: calculateAdaptiveGains(this.threat),
      contextState: this.context?.state ?? null,
      driftSeconds: drift,
      explore: this.trackSnapshot(this.explore, EXPLORE_SCORE_URL),
      threatTrack: this.trackSnapshot(this.threatTrack, THREAT_SCORE_URL),
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }

  async dispose(): Promise<AdaptiveScoreResult> {
    if (this.status === "disposed") return this.success();
    this.status = reduceAdaptiveScoreStatus(this.status, "dispose");
    let cleanupFailure: unknown = null;
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (cause) {
        cleanupFailure ??= cause;
      }
    };
    if (this.syncTimer !== null && this.environment) attempt(() => this.environment?.clearInterval(this.syncTimer!));
    this.syncTimer = null;
    attempt(() => this.detachVisibilityListener());
    for (const track of [this.explore, this.threatTrack]) {
      if (!track) continue;
      attempt(() => track.element.removeEventListener("error", track.onError));
      attempt(() => track.element.removeEventListener("playing", track.onPlaying));
      attempt(() => track.element.removeEventListener("loadedmetadata", track.onLoadedMetadata));
      attempt(() => track.element.pause());
      attempt(() => track.source.disconnect());
      attempt(() => track.gain.disconnect());
      attempt(() => track.element.removeAttribute("src"));
      attempt(() => track.element.load());
    }
    attempt(() => this.masterGain?.disconnect());
    const context = this.context;
    if (context) context.onstatechange = null;
    this.context = null;
    this.masterGain = null;
    this.explore = null;
    this.threatTrack = null;
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch (cause) {
        return this.failure("context-close-failed", "AudioContext failed to close cleanly", cause);
      }
    }
    if (cleanupFailure) return this.failure("dispose-failed", "Adaptive score cleanup completed with an error", cleanupFailure);
    return this.success();
  }

  private async unlockInternal(): Promise<AdaptiveScoreResult> {
    if (!this.environment) {
      this.status = reduceAdaptiveScoreStatus(this.status, "fail");
      return this.failure("unsupported-environment", "Web Audio and HTMLAudioElement are unavailable");
    }
    this.status = reduceAdaptiveScoreStatus(this.status, "begin-unlock");
    try {
      if (!this.context) this.initializeGraph();
    } catch (cause) {
      const graphCreationStarted = this.context !== null;
      await this.resetGraphAfterInitializationFailure();
      this.status = reduceAdaptiveScoreStatus(this.status, "fail");
      return this.failure(
        graphCreationStarted ? "media-source-failed" : "context-create-failed",
        "Unable to create the adaptive score audio graph",
        cause,
      );
    }

    const context = this.context;
    const explore = this.explore;
    const threat = this.threatTrack;
    if (!context || !explore || !threat) {
      this.status = reduceAdaptiveScoreStatus(this.status, "fail");
      return this.failure("media-source-failed", "Adaptive score graph is incomplete after initialization");
    }

    // Call resume() and both play() methods before the first await. Mobile
    // Safari can expire transient user activation across an awaited resume,
    // even though unlock() itself was invoked directly by the gesture.
    const resumeAttempt = (context.state === "running" ? Promise.resolve() : context.resume()).then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    let playbackAttempt: Promise<{ ok: true } | { ok: false; cause: unknown }>;
    try {
      playbackAttempt = Promise.all([
        Promise.resolve(explore.element.play()),
        Promise.resolve(threat.element.play()),
      ]).then(
        () => ({ ok: true as const }),
        (cause: unknown) => ({ ok: false as const, cause }),
      );
    } catch (cause) {
      playbackAttempt = Promise.resolve({ ok: false as const, cause });
    }
    const [resumeResult, playbackResult] = await Promise.all([resumeAttempt, playbackAttempt]);
    if (!resumeResult.ok) {
      explore.element.pause();
      threat.element.pause();
      this.status = reduceAdaptiveScoreStatus(this.status, "fail");
      return this.failure(
        "context-resume-failed",
        "AudioContext resume was rejected; call unlock() directly from a user gesture",
        resumeResult.cause,
      );
    }
    if (this.isDisposed()) return this.failure("disposed", "Adaptive score was disposed while unlocking");
    if (!playbackResult.ok) {
      explore.element.pause();
      threat.element.pause();
      this.status = reduceAdaptiveScoreStatus(this.status, "fail");
      return this.failure("media-play-failed", "One or both mastered score stems failed to play", playbackResult.cause);
    }
    this.synchronizeTracks(true);

    if (this.isDisposed()) {
      explore.element.pause();
      threat.element.pause();
      return this.failure("disposed", "Adaptive score was disposed while playback was starting");
    }

    this.status = reduceAdaptiveScoreStatus(this.status, "play");
    try {
      this.startSynchronization();
      this.attachVisibilityListener();
    } catch (cause) {
      this.stopSynchronizationMonitoring();
      explore.element.pause();
      threat.element.pause();
      this.status = reduceAdaptiveScoreStatus(this.status, "fail");
      return this.failure("synchronization-failed", "Score playback started but synchronization monitoring could not start", cause);
    }
    return this.success();
  }

  private initializeGraph() {
    if (!this.environment) throw new Error("Audio environment unavailable");
    const context = this.environment.createAudioContext();
    this.context = context;
    const masterGain = context.createGain();
    masterGain.gain.setValueAtTime(this.muted ? 0 : 1, context.currentTime);
    masterGain.connect(context.destination);
    this.masterGain = masterGain;
    this.explore = this.createTrack("explore", EXPLORE_SCORE_URL, masterGain);
    this.threatTrack = this.createTrack("threat", THREAT_SCORE_URL, masterGain);
    const gains = calculateAdaptiveGains(this.threat);
    this.explore.gain.gain.setValueAtTime(gains.explore, context.currentTime);
    this.threatTrack.gain.gain.setValueAtTime(gains.threat, context.currentTime);
    context.onstatechange = () => {
      if (this.status === "disposed" || !this.context) return;
      this.status = reduceAdaptiveScoreStatus(
        this.status,
        this.context.state === "running" && !this.explore?.element.paused && !this.threatTrack?.element.paused ? "play" : "suspend",
      );
    };
  }

  private createTrack(kind: "explore" | "threat", url: string, masterGain: GainNode): RuntimeTrack {
    if (!this.environment || !this.context) throw new Error("Audio graph is not initialized");
    let element: HTMLAudioElement | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    const onError = () => this.handleMediaError(kind);
    const onPlaying = () => this.synchronizeTracks(false);
    const onLoadedMetadata = () => this.synchronizeTracks(false);
    try {
      element = this.environment.createAudioElement(url);
      element.preload = "auto";
      element.loop = true;
      // Both stems are same-origin production assets. Leaving crossOrigin unset
      // avoids Chromium ORB rejecting local-preview servers that conservatively
      // label .m4a as octet-stream; deployed Sites still serves audio/mp4.
      element.setAttribute("playsinline", "");
      element.playbackRate = 1;
      element.src = url;
      source = this.context.createMediaElementSource(element);
      gain = this.context.createGain();
      source.connect(gain);
      gain.connect(masterGain);
      element.addEventListener("error", onError);
      element.addEventListener("playing", onPlaying);
      element.addEventListener("loadedmetadata", onLoadedMetadata);
      return { kind, url, element, source, gain, onError, onPlaying, onLoadedMetadata };
    } catch (cause) {
      const attempt = (operation: () => void) => {
        try { operation(); } catch { /* Preserve the graph-creation error. */ }
      };
      if (element) {
        attempt(() => element?.removeEventListener("error", onError));
        attempt(() => element?.removeEventListener("playing", onPlaying));
        attempt(() => element?.removeEventListener("loadedmetadata", onLoadedMetadata));
        attempt(() => element?.pause());
        attempt(() => element?.removeAttribute("src"));
        attempt(() => element?.load());
      }
      attempt(() => source?.disconnect());
      attempt(() => gain?.disconnect());
      throw cause;
    }
  }

  private applyThreatGains(previousThreat: number) {
    if (!this.context || !this.explore || !this.threatTrack) return;
    const gains = calculateAdaptiveGains(this.threat);
    const timeConstant = smoothingTimeConstant(previousThreat, this.threat);
    const now = this.context.currentTime;
    holdAndSchedule(this.explore.gain.gain, gains.explore, now, timeConstant);
    holdAndSchedule(this.threatTrack.gain.gain, gains.threat, now, timeConstant);
  }

  private startSynchronization() {
    if (!this.environment || this.status === "disposed" || this.syncTimer !== null) return;
    this.syncTimer = this.environment.setInterval(() => this.synchronizeTracks(false), SYNC_INTERVAL_MS);
  }

  private stopSynchronizationMonitoring() {
    if (this.syncTimer !== null && this.environment) {
      try { this.environment.clearInterval(this.syncTimer); } catch { /* Best-effort failure cleanup. */ }
    }
    this.syncTimer = null;
    try { this.detachVisibilityListener(); } catch { /* Best-effort failure cleanup. */ }
  }

  private async resetGraphAfterInitializationFailure() {
    this.stopSynchronizationMonitoring();
    const attempt = (operation: () => void) => {
      try { operation(); } catch { /* Preserve the original initialization error. */ }
    };
    for (const track of [this.explore, this.threatTrack]) {
      if (!track) continue;
      attempt(() => track.element.removeEventListener("error", track.onError));
      attempt(() => track.element.removeEventListener("playing", track.onPlaying));
      attempt(() => track.element.removeEventListener("loadedmetadata", track.onLoadedMetadata));
      attempt(() => track.element.pause());
      attempt(() => track.source.disconnect());
      attempt(() => track.gain.disconnect());
      attempt(() => track.element.removeAttribute("src"));
      attempt(() => track.element.load());
    }
    attempt(() => this.masterGain?.disconnect());
    const context = this.context;
    if (context) context.onstatechange = null;
    this.context = null;
    this.masterGain = null;
    this.explore = null;
    this.threatTrack = null;
    if (context && context.state !== "closed") {
      try { await context.close(); } catch { /* A new gesture can still build a fresh graph. */ }
    }
  }

  private synchronizeTracks(force: boolean) {
    if (!this.explore || !this.threatTrack || this.status === "disposed") return;
    try {
      const reference = this.explore.element.currentTime;
      const duration = this.sharedDuration();
      const drift = calculateWrappedDrift(reference, this.threatTrack.element.currentTime, duration);
      if (force || Math.abs(drift) > SYNC_TOLERANCE_SECONDS) {
        const targetDuration = Number.isFinite(this.threatTrack.element.duration) ? this.threatTrack.element.duration : duration;
        this.threatTrack.element.currentTime = targetDuration && targetDuration > 0
          ? ((reference % targetDuration) + targetDuration) % targetDuration
          : reference;
      }
    } catch (cause) {
      this.lastError = this.diagnostic("synchronization-failed", "Unable to realign the mastered score stems", cause);
    }
  }

  private handleMediaError(trackKind: "explore" | "threat") {
    const track = trackKind === "explore" ? this.explore : this.threatTrack;
    const mediaError = track?.element.error;
    const cause = mediaError
      ? { code: mediaError.code, message: mediaError.message || "HTMLMediaElement error" }
      : null;
    this.lastError = this.diagnostic("media-runtime-error", `The ${trackKind} score stem encountered a media error`, cause, trackKind);
    this.status = reduceAdaptiveScoreStatus(this.status, "fail");
    this.explore?.element.pause();
    this.threatTrack?.element.pause();
  }

  private readonly onVisibilityChange = () => {
    if (!this.environment?.visibilityDocument || this.status === "disposed") return;
    // Never pause on blur/hidden. Both HTML media timelines continue together;
    // when the page becomes visible, resume the graph if the browser suspended
    // it and immediately repair any accumulated sub-frame drift.
    if (this.environment.visibilityDocument.visibilityState !== "visible") {
      this.synchronizeTracks(false);
      return;
    }
    void this.resumeAfterVisibility();
  };

  private async resumeAfterVisibility() {
    if (this.status === "error" || !this.context || !this.explore || !this.threatTrack) return;
    try {
      if (this.context.state !== "running") await this.context.resume();
      if (this.explore.element.paused || this.threatTrack.element.paused) {
        await Promise.all([this.explore.element.play(), this.threatTrack.element.play()]);
      }
      this.synchronizeTracks(true);
      this.status = reduceAdaptiveScoreStatus(this.status, "play");
    } catch (cause) {
      this.lastError = this.diagnostic(
        "visibility-resume-failed",
        "The browser did not resume both score stems after visibility returned",
        cause,
      );
      this.status = reduceAdaptiveScoreStatus(this.status, "suspend");
    }
  }

  private attachVisibilityListener() {
    if (!this.environment?.visibilityDocument || this.visibilityAttached) return;
    this.environment.visibilityDocument.addEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityAttached = true;
  }

  private detachVisibilityListener() {
    if (!this.environment?.visibilityDocument || !this.visibilityAttached) return;
    this.environment.visibilityDocument.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityAttached = false;
  }

  private sharedDuration(): number | null {
    const durations = [this.explore?.element.duration, this.threatTrack?.element.duration]
      .filter((duration): duration is number => Number.isFinite(duration) && Boolean(duration && duration > 0));
    return durations.length ? Math.min(...durations) : null;
  }

  private trackSnapshot(track: RuntimeTrack | null, fallbackUrl: string): AdaptiveScoreTrackSnapshot {
    return {
      url: track?.url ?? fallbackUrl,
      currentTimeSeconds: track && Number.isFinite(track.element.currentTime) ? track.element.currentTime : null,
      durationSeconds: track && Number.isFinite(track.element.duration) ? track.element.duration : null,
      paused: track?.element.paused ?? null,
      readyState: track?.element.readyState ?? null,
      mediaErrorCode: track?.element.error?.code ?? null,
    };
  }

  private diagnostic(
    code: AdaptiveScoreErrorCode,
    message: string,
    cause?: unknown,
    track: "explore" | "threat" | null = null,
  ): AdaptiveScoreDiagnostic {
    return {
      code,
      message,
      cause: describeCause(cause),
      track,
      timestampMs: this.environment?.nowMs() ?? Date.now(),
    };
  }

  private success(): AdaptiveScoreResult {
    return { ok: true, snapshot: this.getSnapshot() };
  }

  private failure(code: AdaptiveScoreErrorCode, message: string, cause?: unknown): AdaptiveScoreResult {
    const error = this.diagnostic(code, message, cause);
    this.lastError = error;
    return { ok: false, error, snapshot: this.getSnapshot() };
  }

  private isDisposed() {
    return this.status === "disposed";
  }
}
