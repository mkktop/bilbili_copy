/**
 * 首页品牌英雄区：二次元风——蓝发小人头像悬浮 + 圆润渐变艺术字 + 星光点缀。
 * 纯 CSS/SVG 动画（keyframes 见 index.css），无额外依赖。
 */

const avatarUrl = new URL("../assets/avatar.png", import.meta.url).href;

/** 全局天光渐变：外壳背景与全屏覆盖层共用同一条"由深到浅"，保证任意页面颜色连续 */
export const SKY_GRADIENT =
  "linear-gradient(180deg, rgba(59,130,246,0.24) 0%, rgba(96,165,250,0.15) 30%, rgba(147,197,253,0.08) 60%, rgba(191,219,254,0.04) 100%)";

/** 全页细雨参数：模运算生成确定性伪随机分布（位置/时长/线径），重渲染不跳动 */
const PAGE_DROPS = Array.from({ length: 32 }, (_, i) => ({
  left: (i * 31 + 7) % 100,
  delay: ((i * 41) % 230) / 100,
  dur: 1.5 + ((i * 29) % 100) / 90,
  h: 38 + ((i * 17) % 34),
  thick: i % 4 === 0,
}));

/** 全页雨幕层：铺满最近的定位祖先（主页根容器），内容容器需 relative 叠在雨后 */
export function RainLayer() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      {PAGE_DROPS.map((d, i) => (
        <span
          key={i}
          className={`animate-rain-page absolute top-[-70px] rounded-full bg-gradient-to-b from-blue-300/0 via-blue-400/30 to-blue-300/0 ${
            d.thick ? "w-[2px]" : "w-px"
          }`}
          style={{
            left: `${d.left}%`,
            height: d.h,
            animationDelay: `${d.delay}s`,
            animationDuration: `${d.dur}s`,
          }}
        />
      ))}
    </div>
  );
}

/** 四角星光 */
function Sparkle({ x, y, size, delay, color }: { x: number; y: number; size: number; delay: number; color: string }) {
  const s = size;
  return (
    <path
      d={`M 0 ${-s} L ${s * 0.26} ${-s * 0.26} L ${s} 0 L ${s * 0.26} ${s * 0.26} L 0 ${s} L ${-s * 0.26} ${s * 0.26} L ${-s} 0 L ${-s * 0.26} ${-s * 0.26} Z`}
      transform={`translate(${x} ${y})`}
      fill={color}
      className="animate-twinkle"
      style={{ animationDelay: `${delay}s`, transformBox: "fill-box", transformOrigin: "center" }}
    />
  );
}

export function HomeHero() {
  return (
    <div className="relative flex flex-col items-center">
      {/* 头像：悬浮起伏，柔光衬托 */}
      <img
        src={avatarUrl}
        alt="未雨"
        className="animate-float relative h-[116px] w-[116px] rounded-full"
        style={{ filter: "drop-shadow(0 10px 26px rgba(59,130,246,0.35))" }}
        draggable={false}
      />

      {/* 手绘艺术字：圆头粗笔画逐笔绘制，白描边 + 高光，歪头错落，不依赖任何字体 */}
      <svg
        width="320"
        height="134"
        viewBox="0 0 360 150"
        className="relative mt-2 select-none"
        role="img"
        aria-label="未雨"
      >
        <defs>
          {/* userSpaceOnUse：全字共享一条渐变轴，左字偏天蓝、右字偏靛紫，浑然一体 */}
          <linearGradient id="weiyu-pop" gradientUnits="userSpaceOnUse" x1="40" y1="10" x2="320" y2="140">
            <stop offset="0%" stopColor="#5eb8ff" />
            <stop offset="55%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#8b7cf6" />
          </linearGradient>
        </defs>

        {/* 未：二横 + 一竖 + 撇捺，笔画带微弧度，拒绝直尺感 */}
        <g transform="translate(40 8) rotate(-6 60 60)">
          {[
            "M 34 30 Q 60 24 86 27",
            "M 20 62 Q 62 56 102 59",
            "M 61 16 Q 58 62 62 108",
            "M 54 72 Q 38 92 18 106",
            "M 68 72 Q 86 92 104 106",
          ].map((d, i) => (
            <path key={`w${i}`} d={d} fill="none" stroke="#ffffff" strokeWidth={[26, 27, 28, 27, 27][i]} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {[
            "M 34 30 Q 60 24 86 27",
            "M 20 62 Q 62 56 102 59",
            "M 61 16 Q 58 62 62 108",
            "M 54 72 Q 38 92 18 106",
            "M 68 72 Q 86 92 104 106",
          ].map((d, i) => (
            <path key={`w${i}`} d={d} fill="none" stroke="url(#weiyu-pop)" strokeWidth={[15, 16, 17, 16, 16][i]} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {/* 高光：横画左上的两道白弧 */}
          <path d="M 28 57 Q 38 54.5 48 54" fill="none" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" opacity="0.85" />
          <path d="M 40 26.5 Q 50 24.5 60 24.5" fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" opacity="0.7" />
        </g>

        {/* 雨：外框三笔 + 中竖 + 四颗会呼吸的雨点 */}
        <g transform="translate(186 16) rotate(5 60 60)">
          {[
            "M 22 28 Q 60 22 98 26",
            "M 26 32 Q 23 66 26 100",
            "M 94 32 Q 97 66 94 100",
            "M 60 34 Q 60 60 60 84",
          ].map((d, i) => (
            <path key={`y${i}`} d={d} fill="none" stroke="#ffffff" strokeWidth={[27, 26, 26, 26][i]} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {[[44, 52], [38, 76], [76, 52], [82, 76]].map(([cx, cy], i) => (
            <circle key={`yd${i}`} cx={cx} cy={cy} r="12.5" fill="#ffffff" />
          ))}
          {[
            "M 22 28 Q 60 22 98 26",
            "M 26 32 Q 23 66 26 100",
            "M 94 32 Q 97 66 94 100",
            "M 60 34 Q 60 60 60 84",
          ].map((d, i) => (
            <path key={`y${i}`} d={d} fill="none" stroke="url(#weiyu-pop)" strokeWidth={[15, 15, 15, 15][i]} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {[[44, 52], [38, 76], [76, 52], [82, 76]].map(([cx, cy], i) => (
            <circle
              key={`yd${i}`} cx={cx} cy={cy} r="7" fill="url(#weiyu-pop)"
              className="animate-twinkle" style={{ animationDelay: `${i * 0.55}s`, transformBox: "fill-box", transformOrigin: "center" }}
            />
          ))}
          {/* 高光：外框顶横 + 左框上段 */}
          <path d="M 30 25 Q 42 22.5 54 22" fill="none" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" opacity="0.85" />
          <path d="M 25.5 36 Q 24 48 24.5 58" fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" opacity="0.7" />
        </g>

        {/* 字底弧形托笔，像一笔收尾的笑 */}
        <path d="M 66 132 Q 178 150 296 128" fill="none" stroke="url(#weiyu-pop)" strokeWidth="5" strokeLinecap="round" opacity="0.45" />

        {/* 挂在「雨」旁的小雨滴，轻轻晃 */}
        <g className="animate-float" style={{ animationDuration: "2.6s" }}>
          <path
            d="M 322 96 C 328 105 331 109 331 113 A 9 9 0 1 1 313 113 C 313 109 316 105 322 96 Z"
            fill="#5eb8ff" stroke="#ffffff" strokeWidth="3" paintOrder="stroke" strokeLinejoin="round"
          />
          <circle cx="318.5" cy="114" r="2.4" fill="#ffffff" opacity="0.85" />
        </g>

        {/* 星光点缀 */}
        <Sparkle x={22} y={28} size={10} delay={0} color="#7cb8f5" />
        <Sparkle x={338} y={34} size={11} delay={1.1} color="#a78bfa" />
        <Sparkle x={348} y={96} size={7} delay={0.6} color="#93c5fd" />
      </svg>

      <p
        className="relative mt-1 text-[13px] text-ink-3"
        style={{ letterSpacing: "0.35em", textIndent: "0.35em" }}
      >
        好雨知时节 · 润物细无声
      </p>
    </div>
  );
}
