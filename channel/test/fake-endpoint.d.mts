export interface FakeEndpoint {
  readonly url: string;
  readonly requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  readonly state: { answer: number; hang: boolean; redirectTo: string | null };
  messages(): Record<string, unknown>[];
  close(): Promise<void>;
}
export function startFakeEndpoint(opts?: { answer?: number; hang?: boolean; redirectTo?: string | null }): Promise<FakeEndpoint>;
