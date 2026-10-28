const examples = ["/memory help", "/memory organize", "/memory organize -a", "/memory organize --help"];
const commands = {
  help: "显示当前命令与常用示例", status: "查看当前后端、scope 和召回状态", recall: "刷新当前 scope 的记忆参考",
  scope: "选择 repository 路径", scopes: "查看 scope 清单", list: "分页读取指定 placement", recent: "查看最近写入",
  why: "查看当前召回依据", remember: "请求通过工具保存记忆", organize: "预览整个本地库中的未整理记忆；确认具体建议后经工具应用",
};

export function memoryHelp(command = "help", invalid = false) {
  return { status: invalid ? "failed" : "ok", ...(invalid ? { error: { code: "invalid_arguments",
    message: "未知参数。请使用 /memory help 或 /memory organize --help 查看用法。" } } : {}),
    help: { command: command === "organize" ? "/memory organize" : "/memory", commands, examples,
      options: { "--all, -a": "包括已整理记忆；检查范围始终覆盖全库", "--help, -h": "离线显示帮助，不启动整理" },
      workflow: "整理分为只读预览、用户确认具体建议、工具权限和应用读回。每页最多 20 条，单页不代表全库完成。帮助只显示用法。" } };
}

export function organizationCommand(raw) {
  const args = raw.trim() ? raw.trim().split(/\s+/) : [];
  if (args.some((arg) => !["-a", "--all", "-h", "--help"].includes(arg))) return { help: memoryHelp("organize", true) };
  if (args.some((arg) => ["-h", "--help"].includes(arg))) return { help: memoryHelp("organize") };
  return { selection: args.length ? "all" : "pending" };
}
