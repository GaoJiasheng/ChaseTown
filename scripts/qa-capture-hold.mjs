// Full-resolution WebGL readback can briefly serialize Runtime.evaluate behind
// Page.captureScreenshot on loaded hardware and software renderers. Keep the
// browser-owned lease finite, but leave enough headroom for one slow readback
// so a healthy controller is not mistaken for a disconnected one.
export const CAPTURE_HOLD_LEASE_MILLISECONDS = 10_000;
export const CAPTURE_HOLD_RENEW_INTERVAL_MILLISECONDS = 2_000;
export const CAPTURE_HOLD_COMMAND_TIMEOUT_MILLISECONDS = 8_000;

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Keeps a short browser-owned capture lease alive while a controller is
 * healthy. The browser remains the authority: if this process exits, its next
 * renewal never arrives and the runtime releases the hold at the deadline.
 */
export function createRenewableCaptureHoldController({
  renew,
  release,
  leaseMilliseconds = CAPTURE_HOLD_LEASE_MILLISECONDS,
  renewIntervalMilliseconds = CAPTURE_HOLD_RENEW_INTERVAL_MILLISECONDS,
  scheduleInterval = setInterval,
  cancelInterval = clearInterval,
}) {
  if (typeof renew !== "function") throw new TypeError("renew must be a function");
  if (typeof release !== "function") throw new TypeError("release must be a function");
  if (
    !Number.isFinite(leaseMilliseconds)
    || !Number.isFinite(renewIntervalMilliseconds)
    || leaseMilliseconds <= 0
    || renewIntervalMilliseconds <= 0
    || renewIntervalMilliseconds * 2 >= leaseMilliseconds
  ) {
    throw new RangeError(
      "capture hold renewal interval must leave at least two renewal opportunities per lease",
    );
  }

  let started = false;
  let stopped = false;
  let released = false;
  let intervalHandle = null;
  let renewalInFlight = null;
  let renewalFailure = null;
  let renewalCount = 0;

  const renewNow = () => {
    if (stopped) return Promise.resolve(undefined);
    if (renewalInFlight) return renewalInFlight;
    const request = Promise.resolve().then(() => renew(leaseMilliseconds));
    renewalInFlight = request.then(
      (value) => {
        renewalCount += 1;
        return value;
      },
      (error) => {
        renewalFailure ??= asError(error);
        throw error;
      },
    ).finally(() => {
      renewalInFlight = null;
    });
    return renewalInFlight;
  };

  const scheduleRenewal = () => {
    if (stopped || renewalInFlight) return;
    void renewNow().catch(() => {
      // The first error is retained and reported by assertHealthy()/stop().
      // Keep scheduling so a transient CDP miss does not abandon the lease.
    });
  };

  const assertHealthy = () => {
    if (!renewalFailure) return;
    throw new Error(
      `capture hold lease renewal failed: ${renewalFailure.message}`,
      { cause: renewalFailure },
    );
  };

  return {
    async start() {
      if (started) throw new Error("capture hold controller already started");
      started = true;
      let initialValue;
      try {
        initialValue = await renewNow();
      } catch (error) {
        stopped = true;
        throw error;
      }
      intervalHandle = scheduleInterval(
        scheduleRenewal,
        renewIntervalMilliseconds,
      );
      intervalHandle?.unref?.();
      return initialValue;
    },

    assertHealthy,

    async waitForIdle() {
      try {
        await renewalInFlight;
      } catch {
        // assertHealthy() reports the retained failure with context.
      }
    },

    async stop() {
      if (!started || released) return;
      stopped = true;
      if (intervalHandle !== null) {
        cancelInterval(intervalHandle);
        intervalHandle = null;
      }
      try {
        await renewalInFlight;
      } catch {
        // Release must run even when the last renewal failed.
      }
      let releaseFailure = null;
      try {
        await release();
      } catch (error) {
        releaseFailure = asError(error);
      } finally {
        released = true;
      }
      if (releaseFailure) throw releaseFailure;
      assertHealthy();
    },

    get status() {
      return Object.freeze({
        started,
        stopped,
        released,
        renewalCount,
        renewalFailed: renewalFailure !== null,
      });
    },
  };
}
