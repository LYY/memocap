import { CaptureStop } from "./contract.js";
import { clean } from "./screen.js";

function strings(input) {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];
  return Object.values(input).flatMap(strings);
}

export function createCaptureInputGuard(lifecycle) {
  function reject(worker, reason) {
    delete worker.messageInput;
    delete worker.systemInput;
    lifecycle.invalidate(worker.turn, reason);
    throw new CaptureStop(reason);
  }
  function check(worker) {
    if (worker.closed) throw new CaptureStop("worker_closed");
    lifecycle.check(worker.turn);
    if ((worker.messageBytes ?? 0) + (worker.systemBytes ?? 0) > 49152) reject(worker, "input_budget");
    if (!clean([...(worker.systemInput ?? []), ...(worker.messageInput ?? [])].join(""))) reject(worker, "sensitive_input");
  }
  return {
    messages(output) {
      const sessionID = output.messages.find((message) => lifecycle.workers.has(message.info.sessionID))?.info.sessionID;
      const worker = lifecycle.workers.get(sessionID);
      if (!worker) return;
      if (!output.messages.every((message) => message.info.sessionID === sessionID)) reject(worker, "task_changed");
      worker.messageBytes = Buffer.byteLength(JSON.stringify(output.messages));
      check(worker);
      if (!clean(output.messages)) reject(worker, "sensitive_input");
      worker.messageInput = strings(output.messages.flatMap((message) => message.parts).map((part) => part.text ?? part.state?.output ?? part));
      check(worker);
    },
    system(input, output) {
      const worker = lifecycle.workers.get(input.sessionID);
      if (!worker) return;
      worker.systemBytes = Buffer.byteLength(JSON.stringify(output.system));
      check(worker);
      if (!clean(output.system)) reject(worker, "sensitive_input");
      worker.systemInput = strings(output.system);
      check(worker);
    },
  };
}
