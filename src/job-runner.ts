export interface JobState {
  readonly running: boolean;
  readonly runs: number;
  readonly skippedOverlaps: number;
  readonly lastStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly lastDurationMs: number | null;
  readonly lastError: string;
}

export type JobRunResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'skipped-overlap' };

interface MutableJobState {
  running: boolean;
  runs: number;
  skippedOverlaps: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastError: string;
}

export class JobRunner {
  private readonly states = new Map<string, MutableJobState>();

  async run<T>(name: string, task: () => Promise<T>): Promise<JobRunResult<T>> {
    const state = this.state(name);
    if (state.running) {
      state.skippedOverlaps += 1;
      console.warn(`Background job ${name} skipped: previous run is still active.`);
      return { status: 'skipped-overlap' };
    }
    const started = Date.now();
    state.running = true;
    state.runs += 1;
    state.lastStartedAt = new Date(started).toISOString();
    state.lastError = '';
    console.log(`Background job ${name} started.`);
    try {
      const value = await task();
      state.lastCompletedAt = new Date().toISOString();
      state.lastDurationMs = Date.now() - started;
      console.log(`Background job ${name} completed in ${state.lastDurationMs}ms.`);
      return { status: 'completed', value };
    } catch (error) {
      state.lastDurationMs = Date.now() - started;
      state.lastError = safeError(error);
      console.error(`Background job ${name} failed after ${state.lastDurationMs}ms: ${state.lastError}`);
      throw error;
    } finally {
      state.running = false;
    }
  }

  snapshot(): Readonly<Record<string, JobState>> {
    return Object.fromEntries([...this.states.entries()].map(([name, state]) => [name, { ...state }]));
  }

  private state(name: string): MutableJobState {
    let state = this.states.get(name);
    if (!state) {
      state = { running: false, runs: 0, skippedOverlaps: 0, lastStartedAt: null, lastCompletedAt: null, lastDurationMs: null, lastError: '' };
      this.states.set(name, state);
    }
    return state;
  }
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

export const backgroundJobs = new JobRunner();

export interface SchedulerHandle {
  stop(): void;
}
