import { useEffect, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface VirtualListProps<T> {
  items: T[];
  /** 渲染单条；返回的内容自带样式即可，间距由 gap 处理 */
  renderItem: (item: T, index: number) => ReactNode;
  /** 外层滚动容器的 ref（必须是 overflow:auto 且有确定高度的元素） */
  scrollRef: RefObject<HTMLElement | null>;
  /** 单项预估高度（px，含行间距）。实际高度由 measureElement 自动修正 */
  estimateSize?: number;
  /** 预渲染屏外项数，越大滚动越平滑但 DOM 更多 */
  overscan?: number;
  /** 每项底部间距（px），用于替代原 space-y-* 的视觉间距 */
  gap?: number;
  /** 滚动接近底部时回调（用于「无限滚动」自动加载更多）。不传则不自动加载 */
  onNearEnd?: () => void;
  /** 触发 onNearEnd 的距底阈值（px） */
  nearEndThreshold?: number;
  /** 内容容器额外 className（一般不需要） */
  className?: string;
}

/**
 * 通用虚拟化纵向列表：只渲染可视区域 + overscan 内的项，避免上千条卡片全挂 DOM。
 *
 * 要求：外层 scrollRef 指向一个 `overflow:auto` 且高度确定的滚动容器。
 * 列表内部用 `position:relative` 容器撑开 getTotalSize() 总高，每项 `absolute + translateY` 定位；
 * 每项实际高度由 measureElement 动态测量修正（适配标题换行/评论内容长短不一）。
 * 行间距通过每项内层 paddingBottom 实现，与原 `space-y-*` 视觉一致。
 */
export function VirtualList<T>({
  items,
  renderItem,
  scrollRef,
  estimateSize = 96,
  overscan = 10,
  gap = 8,
  onNearEnd,
  nearEndThreshold = 600,
  className,
}: VirtualListProps<T>) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  // 滚动接近底部 → 自动加载更多（无限滚动）。仅在传入 onNearEnd 时启用。
  useEffect(() => {
    if (!onNearEnd) return;
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < nearEndThreshold) {
        onNearEnd();
      }
    };
    el.addEventListener("scroll", handler, { passive: true });
    handler(); // 首屏也检查一次（内容不足以滚动时立即触发）
    return () => el.removeEventListener("scroll", handler);
  }, [scrollRef, onNearEnd, nearEndThreshold]);

  return (
    <div
      className={className}
      style={{
        height: virtualizer.getTotalSize(),
        position: "relative",
        width: "100%",
      }}
    >
      {virtualizer.getVirtualItems().map((vi) => (
        <div
          key={vi.key}
          data-index={vi.index}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${vi.start}px)`,
          }}
        >
          {/* 内层 paddingBottom 充当行间距，会被 measureElement 计入项高度 */}
          <div style={{ paddingBottom: gap }}>{renderItem(items[vi.index], vi.index)}</div>
        </div>
      ))}
    </div>
  );
}
