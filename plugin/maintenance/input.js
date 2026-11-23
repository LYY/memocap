import { requireMaintenance } from "./boundary.js";
import { clean } from "../capture/screen.js";

function strings(input) {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];
  return Object.values(input).flatMap(strings);
}

export function createMaintenanceInputGuard(tasks) {
  function check(worker) {
    tasks.check(worker.turn);
    if ((worker.messageBytes ?? 0) + (worker.systemBytes ?? 0) > 49152) {
      tasks.invalidate(worker.turn, "input_budget");
      requireMaintenance(false, "input_budget");
    }
    if (worker.sensitive || !clean(worker.messageInput ?? []) || !clean(worker.systemInput ?? []) ||
      !clean([...(worker.systemInput ?? []), ...(worker.messageInput ?? [])].join(""))) {
      delete worker.messageInput;
      delete worker.systemInput;
      tasks.invalidate(worker.turn, "sensitive_input");
      requireMaintenance(false, "sensitive_input");
    }
  }
  return {
    messages(output) {
      const sessionID = output.messages.find((message) => tasks.workers.has(message.info.sessionID))?.info.sessionID;
      const worker = tasks.workers.get(sessionID);
      if (!worker) return;
      requireMaintenance(output.messages.every((message) => message.info.sessionID === sessionID), "task_changed");
      worker.messageBytes = Buffer.byteLength(JSON.stringify(output.messages));
      worker.messageInput = strings(output.messages.flatMap((message) => message.parts).map((part) => part.text ?? part.state?.output ?? part));
      worker.sensitive = !clean(output.messages);
      check(worker);
    },
    system(input, output) {
      const worker = tasks.workers.get(input.sessionID);
      if (!worker) return;
      worker.systemBytes = Buffer.byteLength(JSON.stringify(output.system));
      worker.systemInput = strings(output.system);
      check(worker);
    },
  };
}
