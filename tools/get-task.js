// hana-dsh-adapter tool: get-task.
export const name = "get-task";
export const description =
  "查看适配任务：返回任务元数据、DSH 会话状态与最终助手文本。includeRaw=true 时附带事件摘要（仅 seq/type/time 与文本，绝不含工具参数）。";

export const parameters = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "适配任务 ID（submit 返回的 task.id）。",
    },
    includeRaw: {
      type: "boolean",
      description: "是否包含 DSH 事件摘要（默认 false）。",
    },
  },
  required: ["taskId"],
  additionalProperties: false,
};

export async function execute(input, ctx) {
  const runtime = requireRuntime(ctx);
  const result = await runtime.service.inspect(input.taskId, {
    includeRaw: input.includeRaw === true,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

function requireRuntime(ctx) {
  if (!ctx._dshAdapter?.service) {
    throw new Error("hana-dsh-adapter 插件尚未初始化，请确认 full-access 插件已启用。");
  }
  return ctx._dshAdapter;
}
