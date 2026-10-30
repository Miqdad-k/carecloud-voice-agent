// The parts of Vapi's server messages this app reads. Field names checked against
// Vapi's OpenAPI document (https://api.vapi.ai/api-json) and its docs on 2026-10-30.

export type VapiToolCall = {
  id: string;
  type: string;
  // Vapi's docs show an object here and its OpenAPI document says string, so the
  // handler accepts both.
  function: { name: string; arguments: Record<string, unknown> | string };
};

type VapiCall = { id?: string; customer?: { number?: string } };

export type VapiToolCallsMessage = {
  type: 'tool-calls';
  call?: VapiCall;
  customer?: { number?: string };
  toolCallList: VapiToolCall[];
};

export type VapiEndOfCallReport = {
  type: 'end-of-call-report';
  endedReason?: string;
  call?: VapiCall;
  customer?: { number?: string };
  artifact?: { transcript?: string };
  analysis?: { summary?: string };
  startedAt?: string;
  endedAt?: string;
};

export type VapiMessage = VapiToolCallsMessage | VapiEndOfCallReport | { type: string };

// Vapi rules for the reply: always HTTP 200, one entry per tool call, and `result`
// must be a single flat string. Tool outcomes are JSON text the model can read.
export type VapiToolResult = { name: string; toolCallId: string; result: string };

export function callerNumberOf(message: { call?: VapiCall; customer?: { number?: string } }): string | null {
  return message.customer?.number ?? message.call?.customer?.number ?? null;
}
