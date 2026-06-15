/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // 语义色：绑定到 index.css 里的 CSS 变量，主题切换由 .dark 类翻转。
      // 用法与默认色板一致：bg-panel / text-ink / border-line，支持 /opacity 修饰符。
      colors: {
        base: "rgb(var(--color-base) / <alpha-value>)",
        panel: "rgb(var(--color-panel) / <alpha-value>)",
        "panel-2": "rgb(var(--color-panel-2) / <alpha-value>)",
        line: "rgb(var(--color-line) / <alpha-value>)",
        "line-2": "rgb(var(--color-line-2) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        "ink-2": "rgb(var(--color-ink-2) / <alpha-value>)",
        "ink-3": "rgb(var(--color-ink-3) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        "accent-soft": "rgb(var(--color-accent-soft) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
