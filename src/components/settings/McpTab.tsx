import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Bot, Copy, Check, ShieldCheck, Gauge } from "lucide-react";
import { useToast } from "../Toast";
import { NumberInput } from "./shared";
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
  const [copiedPrompt, setCopiedPrompt] = useState(false);

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
        weiyu: {
          command: exePath || "<未雨安装目录下的 Weiyu.exe>",
          args: ["--mcp"],
        },
      },
    },
    null,
    2
  );

  // 一句话口令：粘给任意支持 MCP 的 AI 客户端，由它自行完成注册与验证。
  // 必须自带 exe 路径与 --mcp 参数（客户端配置文件位置各家不同，交给 AI 找）。
  const installPrompt =
    `请把我本机的未雨 Weiyu（B站视频下载器）注册为你的 MCP 服务器：` +
    `名称 weiyu，传输方式 stdio，启动命令 "${exePath || "<未雨安装目录下的 Weiyu.exe>"}"，参数 ["--mcp"]。` +
    `写入你的 MCP 配置并重新加载后，调用它的 get_login_status 工具验证连通性，然后告诉我结果。` +
    `如果连接失败且提示 MCP 服务未开启，请提醒我打开未雨的 设置 → MCP 服务 开关后再重试。`;

  const copyToClipboard = async (text: string, markCopied: () => void, failLabel: string) => {
    try {
      await writeText(text);
      markCopied();
    } catch (e) {
      toast.error(`${failLabel}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleCopy = async () => {
    await copyToClipboard(
      configSnippet,
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      "复制失败"
    );
  };

  const handleCopyPrompt = async () => {
    await copyToClipboard(
      installPrompt,
      () => {
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 2000);
      },
      "复制失败"
    );
  };

  return (
    <div className="space-y-6">
      {/* 总开关 */}
      <div className="flex items-center justify-between rounded-xl border border-line/60 bg-panel/30 backdrop-blur-sm p-4">
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

      {/* 接口限速 */}
      <div className="flex items-center justify-between rounded-xl border border-line/60 bg-panel/30 backdrop-blur-sm p-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <Gauge size={18} className="text-accent" />
            <p className="text-sm font-medium text-ink-2">接口限速</p>
          </div>
          <p className="text-xs text-ink-3">
            AI 客户端调用B站接口的全局频率上限（次/秒），防止 AI 失控连接触发风控。
            下载速度不受此限制（由下载并发设置控制）。改动即时生效，选「不限速」关闭。
          </p>
        </div>
        <NumberInput
          value={settings.mcp_rate_limit_per_sec}
          onChange={(v) => {
            patchSetting({ mcp_rate_limit_per_sec: v });
          }}
          unit="次/秒"
          unlimitedLabel="不限速"
        />
      </div>

      {/* 使用步骤 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">接入 AI 客户端</h3>
          <p className="text-xs text-ink-3">开启开关后，把下面的配置片段粘贴到客户端的 MCP 设置里</p>
        </header>

        <div className="rounded-xl border border-line/60 bg-panel/30 backdrop-blur-sm p-4 space-y-3">
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
              className="absolute top-2 right-2 p-1.5 rounded-md border border-line/60 bg-panel/30 backdrop-blur-sm hover:bg-panel-2 transition-colors text-ink-3 hover:text-ink-2"
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

      {/* AI 自动安装口令 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">懒得手动配置？让 AI 自己装</h3>
          <p className="text-xs text-ink-3">
            复制下面这句话，直接发给任意支持 MCP 的 AI 客户端（Claude Desktop / ZCode / Cursor
            等），它会自动完成注册、重载和连通性验证
          </p>
        </header>

        <div className="rounded-xl border border-line/60 bg-panel/30 backdrop-blur-sm p-4 space-y-3">
          <div className="relative">
            <p className="rounded-lg bg-panel-2 border border-line p-3 pr-12 text-xs leading-5 text-ink-2">
              {installPrompt}
            </p>
            <button
              onClick={handleCopyPrompt}
              title="复制口令"
              className="absolute top-2 right-2 p-1.5 rounded-md border border-line/60 bg-panel/30 backdrop-blur-sm hover:bg-panel-2 transition-colors text-ink-3 hover:text-ink-2"
            >
              {copiedPrompt ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </section>

      {/* 说明 */}
      <section className="space-y-2">
        <header className="space-y-1">
          <h3 className="text-sm font-medium text-ink-2">工作方式与安全边界</h3>
        </header>
        <div className="rounded-xl border border-line/60 bg-panel/30 backdrop-blur-sm p-4 space-y-2.5 text-xs text-ink-3">
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
