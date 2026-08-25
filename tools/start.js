// hana-dsh-adapter tool: start.
export const name = "start";
export const description =
  "确保本地 DeepSeek Harness (DSH) 可达：不可达时用固定参数启动本地 DSH 进程（web --host 127.0.0.1 --port <配置端口>），已在运行则复用外部服务。";

export const parameters = {
  type: "object",
  properties: {
    autoStart: {
      type: "boolean",
      description: "不可达时是否允许自动启动 DSH。默认取插件配置。",
    },
  },
  additionalProperties: false,
};

export async function execute(input, ctx) {
  const runtime = requireRuntime(ctx);
  const result = await runtime.service.start({ autoStart: input.autoStart });
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
