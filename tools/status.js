// hana-dsh-adapter tool: status.
export const name = "status";
export const description =
  "查看 DeepSeek Harness (DSH) 本地后端的适配状态：可达性、进程归属（本插件启动还是外部）、可执行文件、允许的工作区根目录。";

export const parameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export async function execute(input, ctx) {
  const runtime = requireRuntime(ctx);
  const result = await runtime.service.status();
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
