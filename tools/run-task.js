// hana-dsh-adapter tool: run-task.
export const name = "run-task";
export const description =
  "向本地 DeepSeek Harness (DSH) 提交一个编码任务：创建会话（queue 模式）、提交 prompt 并记录适配任务元数据。cwd 必须存在且位于允许的工作区根目录下；waitSeconds>0 时同步等待 DSH 会话空闲并返回最终文本（上限 900 秒）。";

export const parameters = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "任务描述（必填，非空，最多 200000 字符）。",
    },
    cwd: {
      type: "string",
      description: "任务工作目录（必填，绝对路径，必须位于允许的工作区根目录之下）。",
    },
    agentPreset: {
      type: "string",
      description: "DSH agent 预设（可选，默认 router-standard，受限标识符）。",
    },
    waitSeconds: {
      type: "integer",
      description: "同步等待秒数，0 表示异步提交（默认 0，最大 900）。",
    },
  },
  required: ["prompt", "cwd"],
  additionalProperties: false,
};

export async function execute(input, ctx) {
  const runtime = requireRuntime(ctx);
  const result = await runtime.service.submit({
    prompt: input.prompt,
    cwd: input.cwd,
    agentPreset: input.agentPreset,
    waitSeconds: input.waitSeconds,
    // autoStart intentionally NOT passed: undefined falls back to the plugin
    // configuration (dshAutoStart), so the tool never overrides operator policy.
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
