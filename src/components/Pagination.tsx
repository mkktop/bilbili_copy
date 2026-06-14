import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * 可复用的真分页控件：上一页 / 下一页 + 页码按钮组（带省略号）。
 *
 * 用法：<Pagination currentPage={1} totalCount={100} pageSize={20} onPageChange={setPage} />
 *
 * 页码显示策略：始终显示首页、末页与当前页前后各 1 页，其余用省略号折叠。
 */

interface PaginationProps {
  currentPage: number;
  totalCount: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

/** 生成要显示的页码槽位，"..." 表示省略号 */
function buildPages(current: number, total: number): (number | "...")[] {
  // 总页数很少时，全部显示
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | "...")[] = [];
  const first = 1;
  const last = total;
  // 当前页前后各显示 1 页
  const left = Math.max(current - 1, first + 1);
  const right = Math.min(current + 1, last - 1);

  pages.push(first);
  if (left > first + 1) pages.push("...");
  for (let p = left; p <= right; p++) pages.push(p);
  if (right < last - 1) pages.push("...");
  pages.push(last);
  return pages;
}

export function Pagination({
  currentPage,
  totalCount,
  pageSize,
  onPageChange,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // 只有一页时不渲染
  if (totalPages <= 1) return null;

  const pages = buildPages(currentPage, totalPages);
  const btnBase =
    "min-w-[28px] h-7 px-2 rounded text-xs transition-colors";

  return (
    <div className="flex items-center justify-center gap-1 pt-3 pb-1 flex-wrap">
      {/* 上一页 */}
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronLeft size={12} />
        上一页
      </button>

      {/* 页码按钮组 */}
      <div className="flex items-center gap-1">
        {pages.map((p, idx) => {
          if (p === "...") {
            return (
              <span
                key={`ellipsis-${idx}`}
                className="text-xs text-gray-400 px-1 select-none"
              >
                …
              </span>
            );
          }
          const active = p === currentPage;
          return (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={cn(
                btnBase,
                active
                  ? "bg-blue-500 text-white font-medium"
                  : "text-gray-500 hover:bg-gray-100"
              )}
            >
              {p}
            </button>
          );
        })}
      </div>

      {/* 下一页 */}
      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        下一页
        <ChevronRight size={12} />
      </button>
    </div>
  );
}
