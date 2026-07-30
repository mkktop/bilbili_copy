/**
 * 把任意错误（通常是 Rust 后端返回的字符串）映射成中文友好文案。
 *
 * 用法：catch (e) { toast.error(friendlyError(e)); }
 * 后端错误经由 Tauri 的 invoke 抛出，类型为 string 或 Error。
 */

/** 一条匹配规则：命中 message 子串则返回对应文案 */
interface Rule {
  /** 匹配字符串（小写包含判断） */
  match: string;
  /** 友好文案 */
  text: string;
}

// 常见错误模式 → 文案。顺序无关，命中即返回。
const RULES: Rule[] = [
  // 网络
  { match: "timed out", text: "网络请求超时，请检查网络后重试" },
  { match: "timeout", text: "网络请求超时，请检查网络后重试" },
  { match: "dns error", text: "域名解析失败，请检查网络连接" },
  { match: "connection refused", text: "无法连接到服务器，请稍后重试" },
  { match: "connect error", text: "网络连接失败，请检查网络后重试" },
  { match: "network", text: "网络异常，请检查网络连接" },
  // 凭证 / 登录
  { match: "未登录", text: "未登录或登录已失效，请先扫码登录" },
  { match: "cookie", text: "登录凭证已失效，请重新登录" },
  { match: "凭证", text: "登录凭证已失效，请重新登录" },
  { match: "login", text: "登录状态异常，请重新登录" },
  { match: "-101", text: "账号未登录，请先扫码登录" },
  // 风控 / 验证码
  { match: "风控", text: "触发风控验证，请完成验证后重试" },
  { match: "验证码", text: "需要完成验证码验证" },
  { match: "risk", text: "触发风控验证，请完成验证后重试" },
  { match: "geetest", text: "需要完成滑块验证" },
  // 视频 / 链接
  { match: "bvid", text: "视频链接无效或无法识别" },
  { match: "url", text: "链接格式不正确，请检查后重试" },
  { match: "cid", text: "无法获取视频分P信息" },
  { match: "不存在", text: "视频不存在或已被删除" },
  { match: "已失效", text: "视频已失效或被删除" },
  // 权限 / 地区 / 会员
  { match: "试看", text: "该视频为大会员专享，当前账号只能获取试看片段，已取消" },
  { match: "大会员", text: "该视频为大会员专享，当前账号没有观看权限" },
  { match: "充电", text: "该视频为充电专属内容，需先给 UP 主充电后观看" },
  { match: "专享", text: "该视频为专享内容，当前账号没有观看权限" },
  { match: "付费", text: "该视频为付费内容，需购买后观看" },
  { match: "权限", text: "没有访问权限（可能需要大会员登录）" },
  { match: "地区", text: "当前地区无法观看该视频" },
  // 数据库
  { match: "database is locked", text: "数据库繁忙，请稍后重试" },
  { match: "数据库锁", text: "数据库繁忙，请稍后重试" },
];

/**
 * 将未知错误转为友好中文文案。
 * @param e 任意错误值
 * @returns 友好文案；未匹配到规则时返回原始字符串（兜底）
 */
export function friendlyError(e: unknown): string {
  const raw = toRawString(e);
  if (!raw) return "发生未知错误";

  const lower = raw.toLowerCase();
  for (const rule of RULES) {
    if (lower.includes(rule.match.toLowerCase())) {
      return rule.text;
    }
  }
  return raw;
}

/** 把任意错误值规范化为字符串 */
function toRawString(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  // 兜底：JSON 或 toString
  try {
    return typeof e === "object" ? JSON.stringify(e) : String(e);
  } catch {
    return String(e);
  }
}
