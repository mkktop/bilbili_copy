import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Bot, Copy, Check, ShieldCheck } from "lucide-react";
import { useToast } from "../Toast";
import type { AppSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";

interface McpTabProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  /** 单字段局部保存（走后端 patch_settings，不整份覆盖） */
  onPatch?: (partial: Partial<AppSettings>) => Promise<void>;
}

export function McpTab({ settings, onSave, onPatch }: McpTabProps) {
  const toast = useToast();
  const [exePath, setExePath] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    invoke<{ exe_path: string }>("get_app_info")
      .then((info) => setExePath(info.exe_path))
      .catch(() => setExePath(""));
  }, []);

  const patchSetting = async (partial: Partial<AppSettings>) => {
    try {
      if (onPatch) {
        await onPatch(partial);
      } else {
        await onSave({ ...settings, ...partial });
      }
    } catch (e) {
      console.error(e);
      window.alert(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleToggle = () => {
    patchSetting({ mcp_enabled: !settings.mcp_enabled }).then(() => {
      if (!settings.mcp_enabled) {
        toast.success("MCP 服务已开启，按下方步骤配置 AI 客户端即可");
      }
    });
  };

  const configSnippet = JSON.stringify(
    {
      mcpServers: {
        "bilbli-copy": {
          command: exePath || "<BilbliCopy 安装目录下的 bilbli-copy.exe>",
          args: ["--mcp"],
        },
      },
    },
    null,
    2
  );

  const handleCopy = async () => {
    try {
      await writeText(configSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      toast.error(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* 总开关 */}
      <div className="flex items-center justify-between rounded-xl border border-line bg-panel p-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-accent" />
            <p className="text-sm font-medium text-ink-2">MCP 服务</p>
          </div>
          <p className="text-xs text-ink-3">
            开启后，Claude Desktop / ZCode / Cursor 等 AI 客户端可通过本程序内置的
            MCP 接口对话式驱动下载：搜索、解析、下载、查进度、订阅追更、点赞投币收藏等。
            关闭时 AI 客户端将无法连接。
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.mcp_enabled}
          onClick={handleToggle}
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0",
            settings.mcp_enabled ? "bg-blue-500" : "bg-line-2"
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 rounded-full bg-white transform transition-transform shadow",
              settings.mcp_enabled ? "translate-x-6" : "translate-x-1"
            )}
          />
        </button>
      </div>

      {/* 使用步骤 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">接入 AI 客户端</h3>
          <p className="text-xs text-ink-3">开启开关后，把下面的配置片段粘贴到客户端的 MCP 设置里</p>
        </header>

        <div className="rounded-xl border border-line bg-panel p-4 space-y-3">
          <ol className="text-xs text-ink-3 space-y-1 list-decimal list-inside">
            <li>打开上方「MCP 服务」开关</li>
            <li>复制下方配置片段</li>
            <li>
              粘贴到客户端的 MCP 配置文件：Claude Desktop 的
              <code className="mx-1 px-1 rounded bg-panel-2 text-[11px]">claude_desktop_config.json</code>
              ，或 ZCode / Cursor 的 MCP 服务器设置
            </li>
            <li>重启客户端后，即可直接对话操作下载（如「帮我下载这个视频：&lt;链接&gt;」）</li>
          </ol>

          <div className="relative">
            <pre className="rounded-lg bg-panel-2 border border-line p-3 pr-12 text-[11px] leading-5 overflow-x-auto text-ink-2 whitespace-pre">
              {configSnippet}
            </pre>
            <button
              onClick={handleCopy}
              title="复制配置"
              className="absolute top-2 right-2 p-1.5 rounded-md border border-line bg-panel hover:bg-panel-2 transition-colors text-ink-3 hover:text-ink-2"
            >
              {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            </button>
          </div>

          {!settings.mcp_enabled && (
            <p className="text-xs text-amber-600">
              当前开关处于关闭状态：客户端连接会被拒绝并提示到此处开启。
            </p>
          )}
        </div>
      </section>

      {/* 说明 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">工作方式与安全边界</h3>
        </header>
        <div className="rounded-xl border border-line bg-panel p-4 space-y-2.5 text-xs text-ink-3">
          <div className="flex gap-2">
            <ShieldCheck size={14} className="text-accent shrink-0 mt-0.5" />
            <p>
              本机通信：AI 客户端在本机拉起一个无头实例（不弹窗口），仅本机进程可访问，
              不开放网络端口、无需 Token。
            </p>
          </div>
          <div className="flex gap-2">
            <Bot size={14} className="text-accent shrink-0 mt-0.5" />
            <p>
              与桌面应用共享登录和下载库：无需重复登录；应用正在下载的任务在
              AI 侧同样可见。桌面应用关闭时 AI 发起的下载仍会继续执行。
            </p>
          </div>
          <div className="flex gap-2">
            <ShieldCheck size={14} className="text-accent shrink-0 mt-0.5" />
            <p>
              互动操作（投币、收藏、点赞等）作用于真实账号，AI 客户端调用前会向你确认；
              删除下载文件、触发B站风控验证等操作会引导回桌面应用完成。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
