#!/usr/bin/env bash
# Add by MHY, 2026-08-17: dsh-llm-pi-ai supportsDeveloperRole 透传补丁
# 用途：升级 DSH 后 node_modules 里的补丁会被覆盖，重新执行本脚本即可重打。
# 用法：bash ~/scripts/dsh-web/patch-dsh.sh [--restart]
#   --restart  安排 2 秒后重启 dsh web（不要在 dsh 会话内直接前台执行）

set -euo pipefail

DSH_PKG_DIR="${DSH_PKG_DIR:-$HOME/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai}"
INDEX_JS="$DSH_PKG_DIR/lib/index.js"
CATALOG_DTS="$DSH_PKG_DIR/lib/types/catalog.d.ts"

for f in "$INDEX_JS" "$CATALOG_DTS"; do
  if [[ ! -f "$f" ]]; then
    echo "找不到补丁目标: $f" >&2
    exit 1
  fi
done

apply_patches() {
  python3 - "$INDEX_JS" "$CATALOG_DTS" <<'PY'
import sys
from datetime import date

index_path, dts_path = sys.argv[1:3]
tag = f"Add by MHY, {date.today().isoformat()}:"

patches = [
    {
        "file": index_path,
        "marker": "const supportsDeveloperRole = entry.compat?.supportsDeveloperRole ?? route?.supportsDeveloperRole;",
        "old": """\tconst thinkingFormat = entry.compat?.thinkingFormat ?? route?.thinkingFormat;
\tconst supportsReasoningEffort = entry.compat?.supportsReasoningEffort ?? route?.supportsReasoningEffort;
\tif (thinkingFormat === void 0 && supportsReasoningEffort === void 0) return {};
\tif (api !== "openai-completions") {
\t\tif (entry.compat?.thinkingFormat !== void 0 || entry.compat?.supportsReasoningEffort !== void 0) invalid(provider, `model "${entry.id}" sets compat reasoning switches, but its api is "${api}"; thinkingFormat and supportsReasoningEffort exist only on openai-completions`);
\t\treturn {};
\t}
\treturn { compat: {
\t\t...base?.api === api ? base.compat : void 0,
\t\t...thinkingFormat === void 0 ? {} : { thinkingFormat },
\t\t...supportsReasoningEffort === void 0 ? {} : { supportsReasoningEffort }
\t} };""",
        "new": """\t// """ + tag + """ 透传 supportsDeveloperRole, 否则第三方中转(DeepSeek)开思考时 system prompt 用 developer role 被 400 拒
\tconst thinkingFormat = entry.compat?.thinkingFormat ?? route?.thinkingFormat;
\tconst supportsReasoningEffort = entry.compat?.supportsReasoningEffort ?? route?.supportsReasoningEffort;
\tconst supportsDeveloperRole = entry.compat?.supportsDeveloperRole ?? route?.supportsDeveloperRole;
\tif (thinkingFormat === void 0 && supportsReasoningEffort === void 0 && supportsDeveloperRole === void 0) return {};
\tif (api !== "openai-completions") {
\t\tif (entry.compat?.thinkingFormat !== void 0 || entry.compat?.supportsReasoningEffort !== void 0 || entry.compat?.supportsDeveloperRole !== void 0) invalid(provider, `model "${entry.id}" sets compat reasoning switches, but its api is "${api}"; thinkingFormat, supportsReasoningEffort and supportsDeveloperRole exist only on openai-completions`);
\t\treturn {};
\t}
\treturn { compat: {
\t\t...base?.api === api ? base.compat : void 0,
\t\t...thinkingFormat === void 0 ? {} : { thinkingFormat },
\t\t...supportsReasoningEffort === void 0 ? {} : { supportsReasoningEffort },
\t\t...supportsDeveloperRole === void 0 ? {} : { supportsDeveloperRole }
\t} };""",
    },
    {
        "file": index_path,
        "marker": "supportsDeveloperRole: z.boolean()",
        "old": """const compatProfile = z.object({
\tthinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
\tsupportsReasoningEffort: z.boolean()
});""",
        "new": """const compatProfile = z.object({
\tthinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
\tsupportsReasoningEffort: z.boolean(),
\t// """ + tag + """ 允许显式关 developer role(第三方中转走 system), 见 resolveModelCompat
\tsupportsDeveloperRole: z.boolean()
});""",
    },
    {
        "file": index_path,
        "marker": "request.compat?.supportsDeveloperRole !== void 0",
        "old": "\tconst routeCompatDefined = request.compat?.thinkingFormat !== void 0 || request.compat?.supportsReasoningEffort !== void 0;",
        "new": "\tconst routeCompatDefined = request.compat?.thinkingFormat !== void 0 || request.compat?.supportsReasoningEffort !== void 0 || request.compat?.supportsDeveloperRole !== void 0;",
    },
    {
        "file": index_path,
        "marker": "thinkingFormat, supportsReasoningEffort and supportsDeveloperRole exist only on that protocol",
        "old": 'invalid(provider, "sets compat reasoning switches, but no model on the route speaks openai-completions; thinkingFormat and supportsReasoningEffort exist only on that protocol");',
        "new": 'invalid(provider, "sets compat reasoning switches, but no model on the route speaks openai-completions; thinkingFormat, supportsReasoningEffort and supportsDeveloperRole exist only on that protocol");',
    },
    {
        "file": dts_path,
        "marker": "supportsDeveloperRole?: boolean;",
        "old": """    /** Whether the endpoint accepts `reasoning_effort`; absent keeps the catalog entry's, then pi-ai's baseURL-derived guess. */
    supportsReasoningEffort?: boolean;
}""",
        "new": """    /** Whether the endpoint accepts `reasoning_effort`; absent keeps the catalog entry's, then pi-ai's baseURL-derived guess. */
    supportsReasoningEffort?: boolean;
    /** Whether the endpoint accepts the `developer` message role for reasoning models; set false for DeepSeek-style endpoints that only accept `system`. */
    supportsDeveloperRole?: boolean;
}""",
    },
]

changed_any = False
for patch in patches:
    path = patch["file"]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if patch["marker"] in text:
        print(f"已打补丁，跳过: {path}")
        continue
    old = patch["old"]
    new = patch["new"]
    count = text.count(old)
    if count != 1:
        print(f"补丁上下文不匹配（出现 {count} 次）: {path}")
        print(f"目标标记: {patch['marker']}")
        sys.exit(1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.replace(old, new, 1))
    print(f"已打补丁: {path}")
    changed_any = True

if not changed_any:
    print("全部补丁已存在，无需修改。")
PY
}

BACKUP_DIR="$DSH_PKG_DIR/lib/.patch-dsh-backups"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$INDEX_JS" "$BACKUP_DIR/index.js.$STAMP.bak"
cp "$CATALOG_DTS" "$BACKUP_DIR/catalog.d.ts.$STAMP.bak"
echo "已备份到: $BACKUP_DIR"

apply_patches

node --check "$INDEX_JS"
echo "语法检查通过: $INDEX_JS"

if [[ "${1:-}" == "--restart" ]]; then
  nohup bash -c '
    sleep 2
    pkill -f "node .*/dsh web" 2>/dev/null || true
    sleep 1
    tmux kill-session -t dsh 2>/dev/null || true
    if command -v tmux >/dev/null 2>&1; then
      tmux new-session -d -s dsh "dsh web"
    else
      nohup dsh web >/dev/null 2>&1 &
    fi
  ' >/dev/null 2>&1 &
  echo "已安排 2 秒后重启 dsh web。"
else
  echo "未重启；若本次运行了补丁，请重启 dsh web 使改动生效（bash $0 --restart）。"
fi
