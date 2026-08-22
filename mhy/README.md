# NieRMHY fork 特色修改

这是 [NieRMHY/deepseek-harness](https://github.com/NieRMHY/deepseek-harness) 在官方 `0.1.1-rc.2` 之上的三组特色修改。上游 Issues 已关闭，反馈请走官方 [Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。

## 1. 自定义 OpenAI 兼容中转支持 DeepSeek 思考强度

rc8 起官方已经原生支持：`dsh-llm-pi-ai` 把 `supportsDeveloperRole`、`reasoningEfforts` 以及大量 compat 开关加进了 config schema 和 catalog。因此**本 fork 不再需要给 `dsh-llm-pi-ai` 打补丁**，只需要按 [`mhy/settings.example.yaml`](settings.example.yaml) 配置网关即可。

下面保留 rc7 时代的问题说明，帮助理解配置含义：

问题：用公司网关 / New API 之类第三方中转连 DeepSeek 时，模型选择器没有思考强度选项；开启思考后还可能收到：

```text
unknown variant `developer`, expected one of `system`, `user`, `assistant`, ...
```

根因有两层：

- `dsh-llm-pi-ai` 的 `compatProfile` schema 白名单没有 `supportsDeveloperRole`，配置会被解析层丢掉；
- 没显式关闭时，第三方中转请求的 system prompt 会被序列化成 `developer` role，DeepSeek 官方 OpenAI 接口拒绝。

修复（仅 ≤rc.7 需要）：

- [`mhy/patch-dsh.sh`](patch-dsh.sh)：幂等补丁 `dsh-llm-pi-ai`，把 `supportsDeveloperRole` 加进 schema 和路由透传，rc7 升级后重跑即可；rc8 起不要运行，上游 schema 已包含该字段。
- [`mhy/settings.example.yaml`](settings.example.yaml)：中转 provider 完整示例，DeepSeek v4 思考强度三档 `low / high / max`（DeepSeek 官方目前只支持这三档，`medium` 会映射成 `high`），GLM 模型不配 `reasoningEfforts`。

rc8 用法：

```bash
# 只改 settings.yaml 即可，无需 patch-dsh.sh
# 按 settings.example.yaml 修改 DSH settings.yaml 后重启
```

## 2. NieRMHY-Standard 预设

[`mhy/preset/`](preset/) 是任务感知路由预设（目录 id：`niermhy-standard`）：

- 首请求用最小工具面（`bash` + `str_replace_editor`）锚定，产生首个 tool call 后放开完整 Standard 工具目录；
- `router-bootstrap-v1.mjs` 按任务在 `spec ↔ react` 连续轴上路由，会话可自行查看/调整模式（`dev_router_status` / `dev_router_mode`）；
- 自动加载 `AGENTS.md` / `CLAUDE.md`，项目根标记 `.git` / `.obsidian` / `.dsh-root`，兼容 Claude Code 工作流；
- 完整 Standard 工具集：fs、搜索、编辑器、subagent、workflow、plan、web、skills、goal、todo 等。

安装：

```bash
mkdir -p "$DSH_HOME/.agent-presets/niermhy-standard"
cp -a mhy/preset/. "$DSH_HOME/.agent-presets/niermhy-standard/"
# 在 settings.yaml 中设置
# agent-presets:
#   default: niermhy-standard
```

## 3. 归档会话可见、取消归档与彻底删除

上游（含 `0.1.1-rc.2`）归档会话后没有任何入口再看到它，也没有删除会话的 API。本 fork 补齐：

- 侧边栏会话列表新增「已归档」分组，归档会话可点开查看历史；
- 归档会话行菜单提供「取消归档」和「删除会话」；
- 新增 RPC：`workspace.unarchiveSession`、`workspace.deleteSession`，删除会清理会话日志、工作区记账、归档集合和投影缓存；live 会话会先停止并 flush 再删除；
- 打开归档会话不会再被旧的「当前选择在归档集合就清空」逻辑弹回新对话界面。

涉及包：`dsh-workspace`、`dsh-session-persistence`（JSONL / SQLite）、`dsh-session-projection-cache`、`dsh-host-apiproxy`、`dsh-client-runtime`、`dsh-client-ui-workspace`，相应单元/组件测试已同步更新。
