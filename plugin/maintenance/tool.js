import { tool } from "@opencode-ai/plugin";

export function maintenanceTool(maintenance) {
  const text = tool.schema.string().min(1);
  const use = tool.schema.object({ operation: tool.schema.literal("use"), receipt_id: text,
    id: tool.schema.number().int().positive().max(Number.MAX_SAFE_INTEGER), placement: text,
    content_hash: tool.schema.string().regex(/^[a-f0-9]{64}$/), statements: tool.schema.array(text).min(1).max(8) }).strict();
  const apply = tool.schema.object({ operation: tool.schema.literal("apply"), proposal_id: text }).strict();
  return tool({ description: "Declare adopted exact quotes using maintenance_read from an actual memocap_read, or apply a host-bound one-shot proposal. Declaration attests agent adoption; it does not prove mental reliance. Maintenance requires dedicated persistent grants.",
    args: { operation: tool.schema.enum(["use", "apply"]), receipt_id: text.optional(), id: tool.schema.number().int().positive().optional(),
      placement: text.optional(), content_hash: text.optional(), statements: tool.schema.array(text).optional(), proposal_id: text.optional() },
    async execute(args, context) {
      const parsed = tool.schema.discriminatedUnion("operation", [use, apply]).safeParse(args);
      const payload = parsed.success ? await maintenance.execute(parsed.data, context) : { status: "blocked", error: { code: "invalid_request" } };
      const output = JSON.stringify(payload);
      return { title: `memocap: ${payload.status}`, output, metadata: { status: payload.status, memocap_complete_output: output } };
    },
  });
}
