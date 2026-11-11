export class CaptureStop extends Error {
  constructor(code, status = "skipped") {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function data(result) {
  if (result.error || result.data === undefined) throw new CaptureStop("host_unavailable", "failed");
  return result.data;
}

export const limits = Object.freeze({ maxEvidenceUnits: 2, maxQuoteCodePoints: 800, maxBodyCodePoints: 1200 });

export function complete(messages, userID) {
  const latest = messages.findLast((message) => message.info.role === "user");
  const assistant = messages.at(-1)?.info;
  return latest?.info.id === userID && assistant?.role === "assistant" && assistant.parentID === userID &&
    Boolean(assistant.time.completed) && assistant.finish === "stop" && !assistant.error &&
    !messages.filter((message) => message.info.parentID === userID).some((message) => message.info.error ||
      message.parts.some((part) => part.type === "tool" && ["pending", "running", "error"].includes(part.state.status)));
}
