// ABOUTME: Prebuilt Web Worker entry (SPEC §4.5) — self-wires the prover handler to the worker's message
// ABOUTME: channel, so a consumer points a browser Worker at @armada/sdk/prover/worker with no glue to write.

import { createProverWorkerHandler, type ProverWorkerRequest, type ProverWorkerReply } from './worker-prover';

// `self` inside a Web Worker: reply via postMessage, dispatch each incoming request to the handler.
const ctx = self as unknown as {
  postMessage(reply: ProverWorkerReply): void;
  onmessage: ((event: { data: ProverWorkerRequest }) => void) | null;
};

const handle = createProverWorkerHandler((reply) => ctx.postMessage(reply));
ctx.onmessage = (event): void => {
  void handle(event.data);
};
