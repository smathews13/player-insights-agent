import { Plugin, toPlugin, type PluginManifest } from '@databricks/appkit';
import type { RequestLatencyRecorder } from './request-latency';

export const REQUEST_LATENCY_SHUTDOWN_TIMEOUT_MS = 2_000;

type Signal = 'SIGTERM' | 'SIGINT';
interface SignalSource {
  once(signal: Signal, listener: () => void): unknown;
  off(signal: Signal, listener: () => void): unknown;
}

/**
 * One bounded drain shared by signals and AppKit's server-close lifecycle.
 *
 * AppKit invokes plugin shutdown hooks while closing its HTTP server. We also
 * start the same drain immediately on either termination signal; the memoized
 * promise makes simultaneous SIGTERM, SIGINT, and plugin shutdown one write.
 */
export class RequestLatencyShutdown {
  private recorder: Pick<RequestLatencyRecorder, 'flush'> | null = null;
  private draining: Promise<void> | null = null;
  private signalSource: SignalSource | null = null;

  constructor(readonly timeoutMs = REQUEST_LATENCY_SHUTDOWN_TIMEOUT_MS) {}

  bind(recorder: Pick<RequestLatencyRecorder, 'flush'>): void {
    this.recorder = recorder;
  }

  listen(source: SignalSource = process): void {
    if (this.signalSource) return;
    this.signalSource = source;
    source.once('SIGTERM', this.onSignal);
    source.once('SIGINT', this.onSignal);
  }

  flushOnce(): Promise<void> {
    if (this.draining) return this.draining;
    this.stopListening();
    const flush = this.recorder?.flush();
    if (!flush) {
      this.draining = Promise.resolve();
      return this.draining;
    }
    this.draining = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(
          `[ops] Request latency shutdown flush exceeded ${this.timeoutMs}ms; shutdown will continue without waiting.`
        );
        resolve();
      }, this.timeoutMs);
      timeout.unref?.();
      void flush.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeout);
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[ops] Request latency shutdown flush failed: ${reason}`);
          resolve();
        }
      );
    });
    return this.draining;
  }

  private readonly onSignal = (): void => {
    void this.flushOnce();
  };

  private stopListening(): void {
    if (!this.signalSource) return;
    this.signalSource.off('SIGTERM', this.onSignal);
    this.signalSource.off('SIGINT', this.onSignal);
    this.signalSource = null;
  }
}

class RequestLatencyShutdownPlugin extends Plugin {
  static manifest = {
    name: 'requestLatencyShutdown',
    displayName: 'Request latency shutdown',
    description: 'Flushes buffered request latency spans during graceful server shutdown.',
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<'requestLatencyShutdown'>;

  private readonly coordinator = new RequestLatencyShutdown();

  setup(): Promise<void> {
    this.coordinator.listen();
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.coordinator.flushOnce();
  }

  exports() {
    return {
      setRecorder: this.coordinator.bind.bind(this.coordinator),
      flushOnce: this.coordinator.flushOnce.bind(this.coordinator),
    };
  }
}

export const requestLatencyShutdown = toPlugin(RequestLatencyShutdownPlugin);
