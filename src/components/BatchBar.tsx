import { CheckSquare, Square, Download, Loader2, X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * 列表页批量下载工具条：
 * 「选择」开关 + 全选/清选 + 「下载已选 (N)」。
 * 列表组件维护 selected: Set<string>，本组件只负责操作入口。
 */
export function BatchBar({
  selectMode,
  onToggleMode,
  selectedCount,
  totalCount,
  onSelectAll,
  onClearSelection,
  onDownloadSelected,
  busy,
  extra,
}: {
  selectMode: boolean;
  onToggleMode: () => void;
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDownloadSelected: () => void;
  busy?: boolean;
  /** 追加按钮（如「下载全部」「订阅追更」），显示在选择开关左侧 */
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      {extra}
      <button
        onClick={onToggleMode}
        className={cn(
          "flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors",
          selectMode
            ? "bg-blue-50 border-blue-300 text-blue-600"
            : "bg-panel border-line text-ink-3 hover:bg-panel-2"
        )}
      >
        {selectMode ? <CheckSquare size={12} /> : <Square size={12} />}
        选择
      </button>
      {selectMode && (
        <>
          <button
            onClick={onSelectAll}
            className="text-xs text-ink-3 hover:text-ink-2 px-1.5"
          >
            全选{totalCount > 0 ? `(${totalCount})` : ""}
          </button>
          <button
            onClick={onClearSelection}
            className="flex items-center gap-0.5 text-xs text-ink-3 hover:text-ink-2 px-1.5"
          >
            <X size={11} />
            清选
          </button>
          <button
            onClick={onDownloadSelected}
            disabled={busy || selectedCount === 0}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ml-auto",
              selectedCount > 0 && !busy
                ? "bg-blue-500 text-white hover:bg-blue-600"
                : "bg-panel-2 text-ink-3 cursor-not-allowed"
            )}
          >
            {busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            {busy ? "提交中..." : `下载已选 (${selectedCount})`}
          </button>
        </>
      )}
    </div>
  );
}
