import type { IncomingHttpHeaders } from "node:http";

export interface FakeProxy {
  readonly port: number;
  url(login?: string): string;
  readonly connects: { authority: string; headers: IncomingHttpHeaders }[];
  readonly requests: { method: string; url: string; headers: IncomingHttpHeaders }[];
  sent(): string;
  close(): Promise<void>;
}

export function startFakeProxy(opts?: { auth?: string | null; refuse?: number | null }): Promise<FakeProxy>;
