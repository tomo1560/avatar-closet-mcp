import type { BoothTransport, TransportFactory, TransportResponse } from "../../src/browser/transport.js";
import type { StorageState } from "../../src/session-state.js";

export interface FakeResponseSpec {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface RecordedRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

export type FakeHandler = (request: RecordedRequest, index: number) => FakeResponseSpec;

/** In-memory transport: records every request and never touches the network. */
export class FakeTransportHarness {
  readonly requests: RecordedRequest[] = [];
  readonly createdWith: StorageState[] = [];
  closedCount = 0;
  /** What storageState() returns after a request, i.e. the cookie jar to write back. */
  jar: StorageState | undefined;

  constructor(private readonly handler: FakeHandler) {}

  readonly factory: TransportFactory = (state) => {
    this.createdWith.push(state);
    const transport: BoothTransport = {
      get: (url, headers) => Promise.resolve(this.respond({ url, headers })),
      storageState: () => Promise.resolve(this.jar ?? state),
      close: () => {
        this.closedCount += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(transport);
  };

  private respond(request: RecordedRequest): TransportResponse {
    this.requests.push(request);
    const spec = this.handler(request, this.requests.length - 1);
    return {
      status: spec.status,
      headers: spec.headers ?? {},
      text: () => Promise.resolve(spec.body ?? ""),
      dispose: () => Promise.resolve(),
    };
  }
}

/** Fake clock whose sleep() advances time instantly and records every delay. */
export function createFakeClock(): { sleeps: number[]; now: () => number; sleep: (ms: number) => Promise<void> } {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
}
