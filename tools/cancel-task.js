// hana-dsh-adapter tool: cancel-task.
export const name = "cancel-task";
export const description =
  "取消适配任务对应的 DSH 会话（session.cancel）。只取消会话，不终止 DSH 服务进程。取消请求被接受后任务进入 cancelling 状态，由后续观测（get-task/overview/启动对账）确认终止（cancelled/done/failed/orphaned）；取消请求失败会抛出错误并记录 lastError，不会误报 cancelled。终态任务上调用 cancel 是无害的 no-op（accepted:false）。";

export const parameters = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "适配任务 ID（submit 返回的 task.id）。",
    },
  },
  required: ["taskId"],
  additionalProperties: false,
};

export async function execute(input, ctx) {
  const runtime = requireRuntime(ctx);
  const result = await runtime.service.cancel(input.taskId);
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
