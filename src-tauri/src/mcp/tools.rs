//! MCP 工具层：把命令层能力映射为 MCP tools。
//!
//! 原则：薄封装。工具函数直接调用 `commands::*` 的命令函数（Tauri 命令本质是
//! 普通函数，`State<DbState>` 用 `app.state::<DbState>()` 构造），不做逻辑复制。
//! 返回值统一裁剪为对 AI 省字的 JSON（完整字段对模型是 token 浪费）。

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ProtocolVersion, ServerCapabilities, ServerConfig,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use rmcp::schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use tauri::Manager;
use tauri::AppHandle;

use crate::bilibili::credential::Credential;
use crate::bilibili::url;
use crate::bilibili::video::VideoInfo;
use crate::commands;
use crate::commands::batch::SubmitOptions;
use crate::db::{self, DbState};

// ==================== 通用辅助 ====================

fn internal_err(msg: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(msg.to_string(), None)
}

fn param_err(msg: impl Into<String>) -> ErrorData {
    ErrorData::invalid_params(msg.into(), None)
}

/// 把内部错误字符串翻译成对 AI 有行动指引的提示。
/// `RISK_CONTROL:<voucher>` 前缀：无头实例没有验证码 UI，指引用户去桌面应用完成验证。
fn friendly(err: String) -> String {
    if err.starts_with("RISK_CONTROL:") {
        "触发B站风控验证。MCP 无头实例无法弹出验证码，请在 未雨 桌面应用中操作一次以完成验证后重试。"
            .to_string()
    } else {
        err
    }
}

fn map_cmd<T>(r: Result<T, String>) -> Result<T, ErrorData> {
    r.map_err(|e| internal_err(friendly(e)))
}

fn json_ok(value: serde_json::Value) -> Result<CallToolResult, ErrorData> {
    let text = serde_json::to_string_pretty(&value).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// B站搜索结果标题带 `<em class="keyword">` 高亮标签，剥掉再给 AI
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// 专栏 HTML → 纯文本：块级标签换行后剥掉全部标签，段落结构保留给 AI 读。
fn html_to_text(html: &str) -> String {
    let with_breaks = html
        .replace("</p>", "</p>\n\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</div>", "</div>\n")
        .replace("</h1>", "</h1>\n\n")
        .replace("</h2>", "</h2>\n\n")
        .replace("</h3>", "</h3>\n\n");
    let text = strip_html(&with_breaks);
    // 压掉多余空行
    let mut out = String::with_capacity(text.len());
    let mut blanks = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// HTML 实体还原（B站评论/专栏常见）
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let t: String = s.chars().take(max_chars).collect();
        format!("{t}…")
    }
}

/// VideoInfo 的省字摘要：下载/订阅所需的全部标识（bvid/cid/ep_id）+ 概览信息
fn summarize_video(info: &VideoInfo) -> serde_json::Value {
    json!({
        "bvid": info.bvid,
        "aid": info.aid,
        "title": info.title,
        "owner": { "mid": info.owner_mid, "name": info.owner_name },
        "duration_seconds": info.duration,
        "pic": info.pic,
        "desc": truncate_str(&info.desc, 200),
        "view_count": info.view_count,
        "like_count": info.like_count,
        "danmaku_count": info.danmaku_count,
        "pubdate": info.pubdate,
        "series_title": info.series_title,
        "ep_id": info.ep_id,
        "total_pages": info.pages.len(),
        "pages": info.pages.iter().enumerate().map(|(i, pg)| json!({
            "page": i + 1,
            "cid": pg.cid,
            "part": pg.part,
            "duration_seconds": pg.duration,
        })).collect::<Vec<_>>(),
    })
}

fn trim_video_list(items: &[crate::bilibili::VideoListItem]) -> Vec<serde_json::Value> {
    items
        .iter()
        .map(|v| {
            json!({
                "bvid": v.bvid,
                "aid": v.aid,
                "title": v.title,
                "upper_name": v.upper_name,
                "upper_mid": v.upper_mid,
                "duration_seconds": v.duration,
                "play": v.play,
            })
        })
        .collect()
}

// ==================== 工具参数（字段 doc 注释 → JSON Schema description） ====================

#[derive(Deserialize, JsonSchema)]
struct SearchVideosParams {
    /// 搜索关键词
    keyword: String,
    /// 结果类型：video（默认）| media_bangumi（番剧）| media_ft（影视）
    #[serde(default)]
    search_type: Option<String>,
    /// 页码（从 1 开始，默认 1）
    #[serde(default)]
    page: Option<u32>,
    /// 排序：totalrank（综合，默认）| pubdate（最新发布）| click（最多播放）| stow（最多收藏）| dm（最多弹幕）
    #[serde(default)]
    order: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct GetHotSearchParams {
    /// 返回条数（默认 20，最大 50）
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct BvidParams {
    /// 视频 BV 号（如 BV1xx411c7mD）
    bvid: String,
}

#[derive(Deserialize, JsonSchema)]
struct UpperMidParams {
    /// UP 主的 mid（用户 ID 数字）
    mid: i64,
}

#[derive(Deserialize, JsonSchema)]
struct GetCollectionVideosParams {
    /// UP 主的 mid
    mid: i64,
    /// 合集/列表 id（来自 get_upper_collections 的 id 字段）
    sid: String,
    /// 类型：season（合集）| series（列表），来自 get_upper_collections 的 collection_type
    collection_type: String,
    /// 页码（从 1 开始，默认 1）
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct ParseVideoParams {
    /// B站链接或 BV 号：支持普通视频页、番剧页(ep)、合集页(ss)、短链接(b23.tv)
    url: String,
}

#[derive(Deserialize, JsonSchema)]
struct DownloadVideoParams {
    /// B站链接或 BV 号（会先自动解析）
    url_or_bvid: String,
    /// 下载第几个分P（从 1 开始，默认 1；仅对多P视频有意义）
    #[serde(default)]
    page: Option<u32>,
    /// 指定画质 qn 值（如 127=8K, 116=1080P60, 80=1080P, 64=720P, 32=480P, 16=360P）。
    /// 不填则用应用设置里的默认画质；高画质需要对应大会员
    #[serde(default)]
    qn: Option<i64>,
    /// 仅下载音轨（封装为 .m4a/.mp3），默认 false
    #[serde(default)]
    audio_only: Option<bool>,
    /// 仅下载字幕（不下载视频），默认 false
    #[serde(default)]
    subtitle_only: Option<bool>,
    /// 下载目录分组名（如合集名）；不填按视频自身标题分组
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct BatchDownloadParams {
    /// BV 号列表（每个视频取 P1 入队）
    bvids: Vec<String>,
    /// 下载目录分组名（如合集名）；不填按各视频自身标题分组
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct ListDownloadsParams {
    /// 按状态过滤：queued（排队）| downloading（下载中）| paused（已暂停）| done（已完成）| error（失败）| cancelled（已取消）。不填返回全部
    #[serde(default)]
    status: Option<String>,
    /// 页码（从 1 开始，默认 1，每页 20 条）
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct TaskIdParams {
    /// 下载任务 id（来自 download_video / batch_download / list_downloads 返回的 id）
    task_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct SetPriorityParams {
    /// 下载任务 id
    task_id: String,
    /// 优先级（数值越大越优先，仅对排队中任务生效）
    priority: i32,
}

#[derive(Deserialize, JsonSchema)]
struct PageParams {
    /// 页码（从 1 开始，默认 1，每页 20 条）
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct DeleteDownloadParams {
    /// 下载任务 id
    task_id: String,
    /// 是否同时删除本地视频文件及附属文件（弹幕/字幕/NFO/封面）。默认 false（仅删记录）。
    /// 删除文件不可恢复，请先向用户确认
    #[serde(default)]
    delete_file: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct AddSubscriptionParams {
    /// 订阅类型：season（合集）| series（视频列表）| favorite（收藏夹）
    kind: String,
    /// 订阅源 id：合集 season_id / 列表 series_id / 收藏夹 media_id（来自 get_upper_collections 或收藏夹接口）
    source_id: String,
    /// 订阅显示名（会用作下载目录分组名）
    title: String,
    /// 封面 URL（可空）
    #[serde(default)]
    cover: Option<String>,
    /// UP 主名字（可空）
    #[serde(default)]
    upper_name: Option<String>,
    /// UP 主 mid（season/series 必填；来自 get_upper_collections 的 mid 字段）
    upper_mid: i64,
}

#[derive(Deserialize, JsonSchema)]
struct SubscriptionIdParams {
    /// 订阅 id（来自 list_subscriptions）
    subscription_id: i64,
}

#[derive(Deserialize, JsonSchema)]
struct LikeVideoParams {
    /// 视频 BV 号
    bvid: String,
    /// true=点赞（默认），false=取消点赞。这是对用户真实账号的公开操作
    #[serde(default)]
    like: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct CoinVideoParams {
    /// 视频 BV 号
    bvid: String,
    /// 投币数量：1 或 2（默认 1）。消耗用户真实硬币，请先向用户确认
    #[serde(default)]
    multiply: Option<u8>,
    /// 是否同时点赞（默认 false）
    #[serde(default)]
    like_too: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct FavoriteVideoParams {
    /// 视频 BV 号
    bvid: String,
    /// 目标收藏夹 id（来自 get_favorite_folders）
    folder_id: i64,
}

#[derive(Deserialize, JsonSchema)]
struct GetVideoCommentsParams {
    /// 视频 BV 号
    bvid: String,
    /// 页码（从 1 开始，默认 1，每页 20 条）
    #[serde(default)]
    page: Option<u32>,
    /// 排序："hot"（按热度，默认）| "time"（按时间）
    #[serde(default)]
    sort: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct GetCommentRepliesParams {
    /// 视频 BV 号
    bvid: String,
    /// 根评论 id（来自 get_video_comments 返回的 rpid）
    root_rpid: i64,
    /// 页码（从 1 开始，默认 1）
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct GetAiSummaryParams {
    /// 视频 BV 号
    bvid: String,
    /// 分P 的 cid（来自 parse_video 返回的 pages[].cid）
    cid: i64,
    /// UP 主 mid（来自 parse_video 返回的 owner.mid）
    up_mid: i64,
}

#[derive(Deserialize, JsonSchema)]
struct GetDanmakuParams {
    /// 视频 BV 号
    bvid: String,
    /// 分P 的 cid（来自 parse_video）
    cid: i64,
    /// 分P 时长（秒，来自 parse_video；提供后可合并历史弹幕）
    #[serde(default)]
    duration_seconds: Option<u64>,
    /// 最多返回条数（默认 300，上限 2000；按出现时间取最早的 N 条）
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct GetSubtitlesParams {
    /// 视频 BV 号
    bvid: String,
    /// 分P 的 cid（来自 parse_video）
    cid: i64,
}

#[derive(Deserialize, JsonSchema)]
struct GetSubtitleContentParams {
    /// 字幕轨道地址（来自 get_video_subtitles 返回的 subtitle_url）
    subtitle_url: String,
}

#[derive(Deserialize, JsonSchema)]
struct GetArticleParams {
    /// 专栏 id（cv 号数字；与 opus_id 二选一）
    #[serde(default)]
    cvid: Option<u64>,
    /// opus 图文 id（新版图文；与 cvid 二选一）
    #[serde(default)]
    opus_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct GetWeeklyDetailParams {
    /// 期数（不传返回最新一期；期数列表来自 get_weekly_series）
    #[serde(default)]
    number: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct GetUpperVideosParams {
    /// UP 主 mid
    mid: i64,
    /// 页码（从 1 开始，默认 1）
    #[serde(default)]
    page: Option<u32>,
    /// 按关键词过滤投稿标题
    #[serde(default)]
    keyword: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct GetFollowersParams {
    /// 目标用户的 mid
    mid: i64,
    /// 页码（从 1 开始，默认 1）
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct GetFavoriteVideosParams {
    /// 收藏夹 media_id（来自 get_favorite_folders 的 id）
    media_id: String,
    /// 页码（从 1 开始，默认 1）
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct GetBangumiFollowParams {
    /// 类型：1=追番（默认）| 2=追剧
    #[serde(default)]
    follow_type: Option<u8>,
    /// 页码（从 1 开始，默认 1）
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct GetPgcRankParams {
    /// 榜单类型：4=番剧（默认）| 5=国创 | 2=电影 | 6=纪录片 等
    #[serde(default)]
    season_type: Option<u8>,
}

#[derive(Deserialize, JsonSchema)]
struct GetRegionParams {
    /// 分区 id：1=动画（默认）| 4=游戏 | 3=音乐 | 36=知识 | 234=生活 等
    #[serde(default)]
    rid: Option<u32>,
    /// 每页条数（默认 30）
    #[serde(default)]
    ps: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct GetRecommendParams {
    /// 刷新索引：首次 1，每次"换一批"递增
    #[serde(default)]
    fresh_idx: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct GetDynamicFeedParams {
    /// 分页游标：首页不传，下一页传上次响应的 offset
    #[serde(default)]
    offset: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct GetWatchHistoryParams {
    /// 翻页游标：首页不传；下一页传上次响应的 next_view_at（unix 秒）
    #[serde(default)]
    view_at: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct GetRankingParams {
    /// 分区 id，0 = 全站（默认）
    #[serde(default)]
    rid: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct SearchSuggestParams {
    /// 输入前缀（联想词）
    term: String,
}

#[derive(Deserialize, JsonSchema)]
struct SeasonIdParams {
    /// 番剧/剧集/合集的 season_id（来自搜索结果或 get_pgc_rank）
    season_id: u64,
}

// ==================== 服务定义 ====================

/// MCP 服务端。工具直接复用命令层函数；DB 经 `app.state::<DbState>()` 访问，
/// 与桌面 App 共享同一个 SQLite（WAL 多进程安全）。
#[derive(Clone)]
pub struct BiliMcpServer {
    app: AppHandle,
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl BiliMcpServer {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            tool_router: Self::tool_router(),
        }
    }

    // ---------- 发现 / 解析 ----------

    /// 搜索B站视频、番剧或影视。返回分页结果，条目含 bvid（可直接用于 download_video / parse_video）。
    #[tool(description = "搜索B站视频/番剧/影视。返回分页结果列表，条目含 bvid、UP主、时长、播放量。bvid 可直接传给 download_video 或 parse_video。")]
    async fn search_videos(
        &self,
        Parameters(p): Parameters<SearchVideosParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(
            commands::search::search_videos(p.keyword, p.search_type, p.page, p.order, None, None)
                .await,
        )?;
        let items: Vec<serde_json::Value> = res
            .results
            .iter()
            .map(|r| {
                json!({
                    "type": r.result_type,
                    "title": strip_html(&r.title),
                    "author": r.author,
                    "bvid": r.bvid,
                    "season_id": r.season_id,
                    "duration": r.duration,
                    "play": r.play,
                })
            })
            .collect();
        json_ok(json!({
            "page": res.page,
            "num_pages": res.num_pages,
            "results": items,
        }))
    }

    /// 获取B站实时热搜榜关键词列表。
    #[tool(description = "获取B站实时热搜榜。返回 [{keyword, show_name}]，keyword 可直接用于 search_videos。")]
    async fn get_hot_search(
        &self,
        Parameters(p): Parameters<GetHotSearchParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::search::get_hot_search(p.limit.or(Some(20))).await)?;
        json_ok(json!(items
            .iter()
            .map(|i| json!({ "keyword": i.keyword, "show_name": i.show_name }))
            .collect::<Vec<_>>()))
    }

    /// 获取某视频的相关推荐视频列表（用于「再下几个类似的」）。
    #[tool(description = "获取B站视频的相关推荐列表（同款/相似内容），条目含 bvid 可直接下载。")]
    async fn get_related_videos(
        &self,
        Parameters(p): Parameters<BvidParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::video::get_related_videos(p.bvid).await)?;
        json_ok(json!(trim_video_list(&items)))
    }

    /// 列出 UP 主创建的全部合集与视频列表（add_subscription 的 source_id 来源）。
    #[tool(description = "列出UP主的合集(season)/视频列表(series)。返回的 id + collection_type + mid 可用于 add_subscription 或 get_collection_videos。")]
    async fn get_upper_collections(
        &self,
        Parameters(p): Parameters<UpperMidParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::collection::get_upper_collections(p.mid).await)?;
        json_ok(json!(items
            .iter()
            .map(|c| json!({
                "id": c.id,
                "name": c.name,
                "collection_type": c.collection_type,
                "total": c.total,
                "mid": c.mid,
            }))
            .collect::<Vec<_>>()))
    }

    /// 分页获取合集/列表内的视频（订阅前的内容预览）。
    #[tool(description = "分页获取UP主合集(season)/列表(series)内的视频，条目含 bvid 可直接下载。")]
    async fn get_collection_videos(
        &self,
        Parameters(p): Parameters<GetCollectionVideosParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(
            commands::collection::get_collection_videos(
                p.mid, p.sid, p.collection_type, p.page,
            )
            .await,
        )?;
        json_ok(json!({
            "page": res.page,
            "total": res.total,
            "has_more": res.has_more,
            "items": trim_video_list(&res.items),
        }))
    }

    /// 解析B站链接/BV号/番剧ep/合集ss/短链接，返回标题、UP主、分P列表（含 cid）等。
    #[tool(description = "解析B站链接或BV号（支持番剧ep、合集ss、b23.tv短链），返回标题、UP主、时长、分P列表（含 cid）。下载前可用它了解视频详情，但 download_video 内部会自动解析，无需先调用。")]
    async fn parse_video(
        &self,
        Parameters(p): Parameters<ParseVideoParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let info = map_cmd(commands::video::parse_video(p.url.clone()).await)?;
        let summary = summarize_video(&info);

        // 与 GUI 行为一致：解析成功写入解析历史（按 bvid 去重 upsert，共享库）
        let state = self.app.state::<DbState>();
        let entry = db::ParseHistoryEntry {
            id: info.bvid.clone(),
            url: p.url,
            bvid: info.bvid.clone(),
            title: info.title.clone(),
            video_info: summary.clone(),
            parsed_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        };
        {
            let conn = state
                .0
                .lock()
                .map_err(|e| internal_err(format!("获取数据库锁失败: {e}")))?;
            if let Err(e) = db::insert_parse(&conn, &entry) {
                log::warn!("[mcp] 解析历史落库失败: {e}");
            }
        }
        json_ok(summary)
    }

    // ---------- 下载控制 ----------

    /// 提交单个视频下载，立即返回任务 id；进度用 list_downloads 查询。
    #[tool(description = "下载B站视频/番剧。传链接或BV号即可（自动解析）。立即返回任务 id 并在后台执行；用 list_downloads 查询进度，用 pause_download/cancel_download 控制。audio_only=true 只下音轨（m4a），subtitle_only=true 只下字幕。同一视频已存在未失败任务时自动跳过（幂等）。")]
    async fn download_video(
        &self,
        Parameters(p): Parameters<DownloadVideoParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let info = map_cmd(commands::video::parse_video(p.url_or_bvid.clone()).await)?;
        if info.pages.is_empty() {
            return Err(param_err("解析成功但该视频没有可下载的分P"));
        }
        let idx = p.page.unwrap_or(1).max(1) as usize;
        let page = info
            .pages
            .get(idx - 1)
            .ok_or_else(|| param_err(format!("page={idx} 超出范围：该视频共 {} 个分P", info.pages.len())))?
            .clone();
        // 番剧每集是独立 bvid（PageInfo.bvid），普通视频回退 VideoInfo.bvid
        let bvid = page.bvid.clone().unwrap_or(info.bvid.clone());
        let title = if info.pages.len() > 1 {
            format!("P{} {}", idx, page.part)
        } else {
            info.title.clone()
        };
        let video_title = p
            .folder
            .or(info.series_title.clone())
            .unwrap_or_else(|| info.title.clone());
        let video_meta = if commands::settings::load_settings().download_nfo {
            Some(commands::batch::build_video_meta(&info, &title, &page))
        } else {
            None
        };
        let opts = SubmitOptions {
            qn: p.qn,
            subtitle_only: p.subtitle_only.unwrap_or(false),
            audio_only: p.audio_only.unwrap_or(false),
        };

        let state = self.app.state::<DbState>();
        let task_id = {
            let conn = state
                .0
                .lock()
                .map_err(|e| internal_err(format!("获取数据库锁失败: {e}")))?;
            let mut dedup = db::build_download_dedup(&conn).map_err(internal_err)?;
            commands::batch::submit_video(
                &conn,
                &mut dedup,
                &bvid,
                page.cid,
                &title,
                &video_title,
                page.ep_id,
                Some(page.duration),
                &info.pic,
                &info.owner_name,
                video_meta,
                opts,
            )
        };
        match task_id {
            Some(id) => json_ok(json!({
                "task_id": id,
                "title": title,
                "bvid": bvid,
                "cid": page.cid,
                "hint": "已提交到下载队列。用 list_downloads 查询进度。",
            })),
            None => json_ok(json!({
                "task_id": format!("{bvid}_{}", page.cid),
                "title": title,
                "skipped": true,
                "hint": "该视频已有同任务（排队/下载中/已完成/已暂停），未重复提交。可用 list_downloads 查看现状。",
            })),
        }
    }

    /// 批量下载一组 BV 号（每个取 P1），返回 total/queued/skipped 统计。
    #[tool(description = "批量下载一组BV号（每个视频取P1）。返回 {total, queued, skipped}。已存在的任务自动跳过。逐个解析有节奏控制，视频多时可能较慢。")]
    async fn batch_download(
        &self,
        Parameters(p): Parameters<BatchDownloadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let state = self.app.state::<DbState>();
        let res = map_cmd(
            commands::batch::batch_download_bvids_core(p.bvids, p.folder, &state).await,
        )?;
        json_ok(serde_json::to_value(&res).map_err(internal_err)?)
    }

    /// 查询下载任务列表（含进度/状态/错误信息/输出路径）。
    #[tool(description = "查询下载任务列表与进度。status 过滤：queued/downloading/paused/done/error/cancelled。返回条目含 task_id、status、progress(0-100)、error_msg、output_path。提交下载后用它轮询进度。")]
    async fn list_downloads(
        &self,
        Parameters(p): Parameters<ListDownloadsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app.state::<DbState>();
        let items =
            map_cmd(commands::history::get_download_history(state, p.page, p.status.clone()))?;
        let items: Vec<serde_json::Value> = items
            .iter()
            .map(|e| {
                json!({
                    "id": e.id,
                    "title": e.title,
                    "video_title": e.video_title,
                    "bvid": e.bvid,
                    "status": e.status,
                    "progress": e.progress,
                    "phase": e.phase,
                    "quality": e.quality,
                    "size_bytes": e.size,
                    "duration_seconds": e.duration,
                    "owner_name": e.owner_name,
                    "audio_only": e.audio_only,
                    "subtitle_only": e.subtitle_only,
                    "error_msg": e.error_msg.as_ref().map(|m| friendly(m.clone())),
                    "output_path": e.output_path,
                    "created_at": e.created_at,
                })
            })
            .collect();
        json_ok(json!({ "status_filter": p.status, "count": items.len(), "items": items }))
    }

    /// 下载统计（累计完成数/总大小/总时长）。
    #[tool(description = "查询下载统计：当前记录数、累计完成数、累计体积、累计时长。")]
    async fn get_download_stats(&self) -> Result<CallToolResult, ErrorData> {
        let state = self.app.state::<DbState>();
        let stats = map_cmd(commands::history::get_download_stats(state))?;
        json_ok(serde_json::to_value(&stats).map_err(internal_err)?)
    }

    /// 暂停下载任务（运行中任务保留临时文件可续传，排队任务直接移出队列）。
    #[tool(description = "暂停下载任务：运行中的中断并保留 .tmp 供续传；排队中的移出队列。返回 false 表示任务不存在（可能已结束）。")]
    async fn pause_download(
        &self,
        Parameters(p): Parameters<TaskIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let paused = map_cmd(commands::download::pause_download(p.task_id.clone(), self.app.clone()))?;
        json_ok(json!({ "task_id": p.task_id, "paused": paused }))
    }

    /// 取消下载任务（清理临时文件，不删已完成文件）。
    #[tool(description = "取消下载任务：中断并清理临时文件（已完成文件不受影响）。返回 false 表示任务不存在（可能已结束）。从队列彻底移除需再调 delete_download 清记录。")]
    async fn cancel_download(
        &self,
        Parameters(p): Parameters<TaskIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let cancelled = map_cmd(commands::download::cancel_download(p.task_id.clone()))?;
        json_ok(json!({ "task_id": p.task_id, "cancelled": cancelled }))
    }

    /// 调整排队中任务的优先级。
    #[tool(description = "调整排队中下载任务的优先级（数值越大越早开始）。仅对排队中任务生效。")]
    async fn set_download_priority(
        &self,
        Parameters(p): Parameters<SetPriorityParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ok = map_cmd(commands::download::set_download_priority(
            p.task_id.clone(),
            p.priority,
        ))?;
        json_ok(json!({ "task_id": p.task_id, "priority": p.priority, "applied": ok }))
    }

    /// 查询解析历史（不含完整视频信息）。
    #[tool(description = "查询解析历史列表（最近解析过的视频）。返回 id/url/bvid/title/parsed_at。")]
    async fn get_parse_history(
        &self,
        Parameters(p): Parameters<PageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app.state::<DbState>();
        let entries = map_cmd(commands::history::get_parse_history(state, p.page))?;
        json_ok(json!(entries
            .iter()
            .map(|e| json!({
                "bvid": e.bvid,
                "title": e.title,
                "url": e.url,
                "parsed_at": e.parsed_at,
            }))
            .collect::<Vec<_>>()))
    }

    /// 删除下载记录（可选同时删本地文件——破坏性操作）。
    #[tool(description = "删除下载记录。delete_file=true 时同时删除本地视频及附属文件（弹幕/字幕/NFO/封面），不可恢复——调用前必须先向用户确认。默认只删记录不动文件。")]
    async fn delete_download(
        &self,
        Parameters(p): Parameters<DeleteDownloadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app.state::<DbState>();
        if p.delete_file.unwrap_or(false) {
            let deleted = map_cmd(commands::history::delete_download_with_file(state, p.task_id.clone()))?;
            json_ok(json!({ "task_id": p.task_id, "deleted_files": deleted }))
        } else {
            map_cmd(commands::history::delete_download_history(state, p.task_id.clone()))?;
            json_ok(json!({ "task_id": p.task_id, "record_deleted": true }))
        }
    }

    // ---------- 订阅追更 ----------

    /// 列出全部订阅。
    #[tool(description = "列出全部订阅追更源（合集/列表/收藏夹）。返回 id、kind、title、known_bvids_count、last_check。新增内容会由桌面应用按设置间隔自动下载。")]
    async fn list_subscriptions(&self) -> Result<CallToolResult, ErrorData> {
        let state = self.app.state::<DbState>();
        let subs = map_cmd(commands::subscription::get_subscriptions(state))?;
        json_ok(json!(subs
            .iter()
            .map(|s| json!({
                "id": s.id,
                "kind": s.kind,
                "source_id": s.source_id,
                "title": s.title,
                "upper_name": s.upper_name,
                "upper_mid": s.upper_mid,
                "known_count": s.known_bvids.len(),
                "last_check": s.last_check,
                "created_at": s.created_at,
            }))
            .collect::<Vec<_>>()))
    }

    /// 添加订阅（记录当前内容为基线，只自动下载之后的新增内容）。
    #[tool(description = "添加订阅追更：记录当前内容为基线，之后新增的视频自动入队下载（历史内容不回扫，需要回扫用 batch_download）。season/series 的 source_id 和 upper_mid 用 get_upper_collections 获取；favorite 用收藏夹 media_id。抓取基线失败会报错不入库。")]
    async fn add_subscription(
        &self,
        Parameters(p): Parameters<AddSubscriptionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let state = self.app.state::<DbState>();
        let sub = map_cmd(
            commands::subscription::add_subscription(
                p.kind,
                p.source_id,
                p.title,
                p.cover.unwrap_or_default(),
                p.upper_name.unwrap_or_default(),
                p.upper_mid,
                state,
            )
            .await,
        )?;
        json_ok(json!({
            "id": sub.id,
            "kind": sub.kind,
            "title": sub.title,
            "baseline_count": sub.known_bvids.len(),
            "hint": "已记录当前内容为基线，之后新增内容会自动下载。",
        }))
    }

    /// 删除订阅（不影响已入队任务）。
    #[tool(description = "删除订阅（已入队的下载任务不受影响）。")]
    async fn remove_subscription(
        &self,
        Parameters(p): Parameters<SubscriptionIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app.state::<DbState>();
        map_cmd(commands::subscription::remove_subscription(p.subscription_id, state))?;
        json_ok(json!({ "removed": p.subscription_id }))
    }

    /// 立即检查一次订阅更新（不等桌面应用的定时调度）。
    #[tool(description = "立即检查指定订阅的新增内容并自动入队下载。返回 {queued, skipped}。")]
    async fn check_subscription_now(
        &self,
        Parameters(p): Parameters<SubscriptionIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(commands::subscription::check_subscription(p.subscription_id, self.app.clone()).await)?;
        json_ok(serde_json::to_value(&res).map_err(internal_err)?)
    }

    // ---------- 互动（真实账号操作） ----------

    /// 点赞/取消点赞视频。
    #[tool(description = "给视频点赞或取消点赞。这是对用户真实B站账号的公开操作（点赞列表他人可见），确认用户意图后再调用。")]
    async fn like_video(
        &self,
        Parameters(p): Parameters<LikeVideoParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let like_flag = if p.like.unwrap_or(true) { 1u8 } else { 2u8 };
        map_cmd(commands::interaction::like_video(p.bvid.clone(), Some(like_flag)).await)?;
        json_ok(json!({ "bvid": p.bvid, "liked": p.like.unwrap_or(true) }))
    }

    /// 投币（消耗用户真实硬币，默认 1 个，可选同时点赞）。
    #[tool(description = "给视频投币。消耗用户真实硬币（每个账号有限），务必先向用户确认数量再调用。multiply=1或2；like_too=true 同时点赞。")]
    async fn coin_video(
        &self,
        Parameters(p): Parameters<CoinVideoParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let multiply = p.multiply.unwrap_or(1);
        if !(1..=2).contains(&multiply) {
            return Err(param_err("multiply 只能是 1 或 2"));
        }
        let select_like = if p.like_too.unwrap_or(false) { 1u8 } else { 0u8 };
        map_cmd(commands::interaction::coin_video(
            p.bvid.clone(),
            Some(multiply),
            Some(select_like),
        )
        .await)?;
        json_ok(json!({ "bvid": p.bvid, "coined": multiply, "liked_too": select_like == 1 }))
    }

    /// 收藏视频到指定收藏夹。
    #[tool(description = "把视频加入用户创建的收藏夹。folder_id 来自 get_favorite_folders。这是真实账号操作。")]
    async fn favorite_video(
        &self,
        Parameters(p): Parameters<FavoriteVideoParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let aid = url::bvid_to_aid(&p.bvid);
        map_cmd(commands::interaction::favorite_video(aid as i64, p.folder_id).await)?;
        json_ok(json!({ "bvid": p.bvid, "folder_id": p.folder_id, "favorited": true }))
    }

    /// 列出用户创建的收藏夹（favorite_video 的 folder_id 来源）。
    #[tool(description = "列出用户创建的收藏夹（id/title/media_count）。favorite_video 需要这里的 id。")]
    async fn get_favorite_folders(&self) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let folders = map_cmd(commands::favorite::get_favorite_folders().await)?;
        json_ok(json!(folders
            .iter()
            .map(|f| json!({ "id": f.id, "title": f.title, "media_count": f.media_count }))
            .collect::<Vec<_>>()))
    }

    /// 加入稍后再看。
    #[tool(description = "把视频加入用户的稍后再看列表。")]
    async fn add_watch_later(
        &self,
        Parameters(p): Parameters<BvidParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        map_cmd(commands::watch_later::add_watch_later(p.bvid.clone()).await)?;
        json_ok(json!({ "bvid": p.bvid, "added": true }))
    }

    /// 从稍后再看移除。
    #[tool(description = "把视频从用户的稍后再看列表移除。")]
    async fn remove_watch_later(
        &self,
        Parameters(p): Parameters<BvidParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        map_cmd(commands::watch_later::remove_watch_later(p.bvid.clone()).await)?;
        json_ok(json!({ "bvid": p.bvid, "removed": true }))
    }

    // ---------- 评论 / AI 总结 / 弹幕 / 字幕 ----------

    /// 获取视频评论区（分页，热度/时间排序）。
    #[tool(description = "获取B站视频评论区，分页返回（每页20条），条目含 rpid、用户、内容、点赞数、楼中楼回复数。sort=\"hot\" 按热度（默认）或 \"time\" 按时间。用 get_comment_replies 看某条的楼中楼。")]
    async fn get_video_comments(
        &self,
        Parameters(p): Parameters<GetVideoCommentsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let aid = url::bvid_to_aid(&p.bvid) as i64;
        let mode = match p.sort.as_deref() {
            Some("time") => 2u32,
            _ => 3u32,
        };
        let res = map_cmd(
            commands::comment::get_video_comments(aid, p.page, Some(mode)).await,
        )?;
        let items: Vec<serde_json::Value> = res
            .items
            .iter()
            .map(|c| {
                json!({
                    "rpid": c.rpid,
                    "uname": c.uname,
                    "content": decode_entities(&c.content),
                    "like": c.like,
                    "reply_count": c.reply_count,
                    "time": c.ctime,
                    "location_note": "用 get_comment_replies(bvid, rpid) 查看楼中楼",
                })
            })
            .collect();
        json_ok(json!({
            "page": res.page,
            "total": res.total,
            "has_more": res.has_more,
            "comments": items,
        }))
    }

    /// 获取某条评论的楼中楼回复。
    #[tool(description = "获取视频某条评论下的楼中楼回复（分页）。root_rpid 来自 get_video_comments 返回的 rpid。")]
    async fn get_comment_replies(
        &self,
        Parameters(p): Parameters<GetCommentRepliesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let aid = url::bvid_to_aid(&p.bvid) as i64;
        let res = map_cmd(
            commands::comment::get_comment_replies(aid, p.root_rpid, p.page).await,
        )?;
        let items: Vec<serde_json::Value> = res
            .items
            .iter()
            .map(|c| {
                json!({
                    "rpid": c.rpid,
                    "uname": c.uname,
                    "content": decode_entities(&c.content),
                    "like": c.like,
                    "time": c.ctime,
                })
            })
            .collect();
        json_ok(json!({
            "page": res.page,
            "total": res.total,
            "has_more": res.has_more,
            "replies": items,
        }))
    }

    /// 获取B站官方 AI 视频总结（大纲+摘要）。
    #[tool(description = "获取B站官方 AI 生成的视频总结：摘要要点 + 分段大纲（每段含标题与该段要点）。bvid/cid/up_mid 都来自 parse_video。视频未生成总结时返回 not_available 提示。")]
    async fn get_ai_summary(
        &self,
        Parameters(p): Parameters<GetAiSummaryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        match map_cmd(commands::video::get_ai_summary(p.bvid.clone(), p.cid, p.up_mid as u64).await)? {
            Some(s) => json_ok(json!({
                "bvid": p.bvid,
                "summary_points": s.summary,
                "outline": s.outline,
            })),
            None => json_ok(json!({
                "bvid": p.bvid,
                "not_available": true,
                "hint": "该视频尚未生成官方 AI 总结。",
            })),
        }
    }

    /// 获取视频弹幕（文本+时间，可限量）。
    #[tool(description = "获取视频某一分P的弹幕文本列表 [{time_seconds, text}]，按出现时间排序。弹幕可能数千条，默认返回最早 300 条，用 limit 调整（上限 2000）。提供 duration_seconds 可合并最近的历史弹幕。适合分析观众反应/高能时刻。")]
    async fn get_video_danmaku(
        &self,
        Parameters(p): Parameters<GetDanmakuParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let aid = url::bvid_to_aid(&p.bvid);
        let mut list = map_cmd(
            commands::player::get_danmaku_json(p.cid, aid, p.duration_seconds.unwrap_or(0)).await,
        )?;
        let total = list.len();
        let limit = p.limit.unwrap_or(300).min(2000) as usize;
        list.truncate(limit);
        let items: Vec<serde_json::Value> = list
            .iter()
            .map(|d| json!({ "time_seconds": d.time, "text": d.text }))
            .collect();
        json_ok(json!({ "total": total, "returned": items.len(), "danmaku": items }))
    }

    /// 获取视频字幕轨道列表。
    #[tool(description = "获取视频某一分P的可用字幕轨道（含AI自动生成的），返回 [{lan, lan_doc, is_ai, subtitle_url}]。需要字幕正文时把 subtitle_url 传给 get_subtitle_content。")]
    async fn get_video_subtitles(
        &self,
        Parameters(p): Parameters<GetSubtitlesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let aid = url::bvid_to_aid(&p.bvid);
        let tracks = map_cmd(
            commands::player::get_subtitle_list(p.bvid.clone(), p.cid, aid).await,
        )?;
        let items: Vec<serde_json::Value> = tracks
            .iter()
            .map(|t| {
                json!({
                    "lan": t.lan,
                    "lan_doc": t.lan_doc,
                    "is_ai": t.is_ai,
                    "subtitle_url": t.subtitle_url,
                })
            })
            .collect();
        if items.is_empty() {
            return json_ok(json!({ "bvid": p.bvid, "tracks": [], "hint": "该视频没有可用字幕（包括AI字幕）。" }));
        }
        json_ok(json!({ "bvid": p.bvid, "tracks": items }))
    }

    /// 获取字幕正文（时间轴+文本）。
    #[tool(description = "下载字幕轨道正文，返回 [{from_seconds, to_seconds, content}] 时间轴文本。subtitle_url 来自 get_video_subtitles。适合做视频内容转写/总结。")]
    async fn get_subtitle_content(
        &self,
        Parameters(p): Parameters<GetSubtitleContentParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let cues = map_cmd(commands::player::get_subtitle_cues(p.subtitle_url.clone()).await)?;
        let items: Vec<serde_json::Value> = cues
            .iter()
            .map(|c| json!({ "from": c.from, "to": c.to, "text": c.content }))
            .collect();
        json_ok(json!({ "cue_count": items.len(), "cues": items }))
    }

    // ---------- 榜单 / 发现 ----------

    /// 获取全站/分区排行榜。
    #[tool(description = "获取B站排行榜（公开无需登录）。rid=0 全站榜（默认），也可传分区 id。返回排名列表，条目含 bvid 可直接下载。")]
    async fn get_ranking(
        &self,
        Parameters(p): Parameters<GetRankingParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::ranking::get_ranking(p.rid).await)?;
        json_ok(json!(items
            .iter()
            .enumerate()
            .map(|(i, v)| json!({
                "rank": v.rank,
                "position": i + 1,
                "bvid": v.bvid,
                "title": v.title,
                "upper_name": v.upper_name,
                "play": v.play,
                "duration_seconds": v.duration,
            }))
            .collect::<Vec<_>>()))
    }

    /// 获取首页个性化推荐（需登录）。
    #[tool(description = "获取首页个性化推荐视频流（需登录）。fresh_idx=1 首次，每次传更大数字\"换一批\"。条目含 bvid 可直接下载。")]
    async fn get_recommend(
        &self,
        Parameters(p): Parameters<GetRecommendParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::recommend::get_recommend(p.fresh_idx).await)?;
        json_ok(json!(items
            .iter()
            .map(|v| json!({
                "bvid": v.bvid,
                "title": v.title,
                "upper_name": v.upper_name,
                "upper_mid": v.upper_mid,
                "play": v.play,
                "danmaku": v.danmaku,
                "duration_seconds": v.duration,
            }))
            .collect::<Vec<_>>()))
    }

    /// 获取分区最新视频。
    #[tool(description = "获取B站分区视频列表（公开）。默认动画区(rid=1)，可用 ps 控制条数。条目含 bvid 可直接下载。")]
    async fn get_region_videos(
        &self,
        Parameters(p): Parameters<GetRegionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::region::get_region(p.rid, p.ps).await)?;
        json_ok(json!(items
            .iter()
            .map(|v| json!({
                "bvid": v.bvid,
                "title": v.title,
                "upper_name": v.upper_name,
                "play": v.play,
                "danmaku": v.danmaku,
                "duration_seconds": v.duration,
            }))
            .collect::<Vec<_>>()))
    }

    /// 获取番剧/影视热门榜。
    #[tool(description = "获取番剧/国创/电影/纪录片热门榜（公开）。默认 season_type=4 番剧。返回 season_id 可用于 batch_download_season 整季下载。")]
    async fn get_pgc_rank(
        &self,
        Parameters(p): Parameters<GetPgcRankParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::pgc::get_pgc_rank(p.season_type).await)?;
        json_ok(json!(items
            .iter()
            .map(|v| json!({
                "rank": v.rank,
                "season_id": v.season_id,
                "title": v.title,
                "score": v.score,
                "badge": v.badge,
            }))
            .collect::<Vec<_>>()))
    }

    /// 获取用户的追番/追剧列表。
    #[tool(description = "获取当前用户B站的追番/追剧列表（需登录）。follow_type=1 追番（默认）| 2 追剧。条目含 season_id 与观看进度。")]
    async fn get_bangumi_follow(
        &self,
        Parameters(p): Parameters<GetBangumiFollowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(commands::pgc::get_bangumi_follow(p.follow_type, p.page).await)?;
        json_ok(json!({
            "page": res.page,
            "total": res.total,
            "has_more": res.has_more,
            "items": res.items.iter().map(|v| json!({
                "season_id": v.season_id,
                "title": v.title,
                "type_name": v.season_type_name,
                "badge": v.badge,
                "latest_ep": v.new_ep_show,
                "progress": v.progress,
            })).collect::<Vec<_>>(),
        }))
    }

    /// 获取每周必看各期列表。
    #[tool(description = "获取B站每周必看的期数列表（公开），number 传给 get_weekly_detail 看某期内容。")]
    async fn get_weekly_series(&self) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::weekly::get_weekly_series().await)?;
        json_ok(json!(items
            .iter()
            .map(|v| json!({ "number": v.number, "name": v.name, "subject": v.subject }))
            .collect::<Vec<_>>()))
    }

    /// 获取每周必看某期的视频列表。
    #[tool(description = "获取B站每周必看某一期的完整视频列表（公开）。number 不传返回最新一期；期数来自 get_weekly_series。条目含 bvid 可直接下载。")]
    async fn get_weekly_detail(
        &self,
        Parameters(p): Parameters<GetWeeklyDetailParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let detail = map_cmd(commands::weekly::get_weekly_detail(p.number).await)?;
        json_ok(json!({
            "number": detail.config.number,
            "name": detail.config.name,
            "reminder": detail.reminder,
            "videos": detail.list.iter().map(|v| json!({
                "bvid": v.bvid,
                "aid": v.aid,
                "cid": v.cid,
                "title": v.title,
                "upper_name": v.upper_name,
                "play": v.play,
                "duration_seconds": v.duration,
            })).collect::<Vec<_>>(),
        }))
    }

    /// 获取入站必刷榜单。
    #[tool(description = "获取B站入站必刷榜（官方编辑精选，公开）。条目含 bvid/cid 可直接下载。")]
    async fn get_precious_list(&self) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::weekly::get_precious_list().await)?;
        json_ok(json!(items
            .iter()
            .map(|v| json!({
                "bvid": v.bvid,
                "aid": v.aid,
                "cid": v.cid,
                "title": v.title,
                "upper_name": v.upper_name,
                "play": v.play,
                "duration_seconds": v.duration,
            }))
            .collect::<Vec<_>>()))
    }

    /// 获取关注 UP 的最新动态视频流。
    #[tool(description = "获取已关注 UP 主的最新视频动态（需登录），cursor 分页：下一页传上次响应的 offset。条目含 bvid 可直接下载。")]
    async fn get_dynamic_feed(
        &self,
        Parameters(p): Parameters<GetDynamicFeedParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(commands::dynamic::get_dynamic_feed(p.offset).await)?;
        json_ok(json!({
            "offset": res.offset,
            "has_more": res.has_more,
            "items": res.items.iter().map(|v| json!({
                "bvid": v.bvid,
                "title": v.title,
                "upper_name": v.upper_name,
                "upper_mid": v.upper_mid,
                "published_at": v.pub_ts,
                "action": v.pub_action,
                "play_text": v.play_text,
            })).collect::<Vec<_>>(),
        }))
    }

    /// 获取用户的观看历史。
    #[tool(description = "获取当前用户的B站观看历史（需登录），cursor 分页：下一页传上次响应的 next_view_at。条目含 bvid。")]
    async fn get_watch_history(
        &self,
        Parameters(p): Parameters<GetWatchHistoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let cursor = p.view_at.map(|view_at| {
            crate::bilibili::history::HistoryCursor {
                view_at,
                business: String::new(),
                max: String::new(),
            }
        });
        let res = map_cmd(commands::history_cmd::get_watch_history(cursor).await)?;
        json_ok(json!({
            "has_more": res.has_more,
            "next_view_at": res.next_cursor.as_ref().map(|c| c.view_at),
            "items": res.items.iter().map(|v| json!({
                "bvid": v.bvid,
                "title": v.title,
                "upper_name": v.upper_name,
                "duration_seconds": v.duration,
            })).collect::<Vec<_>>(),
        }))
    }

    /// 获取专栏/图文正文。
    #[tool(description = "获取B站专栏文章（cv号）或新版 opus 图文的正文，返回标题、作者、发布时间、字数与纯文本正文。适合让 AI 阅读并总结文章。cvid 与 opus_id 二选一。")]
    async fn get_article_content(
        &self,
        Parameters(p): Parameters<GetArticleParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        if p.cvid.is_none() && p.opus_id.as_deref().unwrap_or("").is_empty() {
            return Err(param_err("cvid 与 opus_id 至少提供一个"));
        }
        let data = map_cmd(
            commands::article::get_article_content(p.cvid, p.opus_id).await,
        )?;
        json_ok(json!({
            "cvid": data.cvid,
            "opus_id": data.opus_id,
            "title": data.title,
            "author": data.author_name,
            "publish_time": data.publish_time,
            "words": data.words,
            "content": html_to_text(&data.content_html),
        }))
    }

    // ---------- UP 主 / 用户列表 ----------

    /// 获取 UP 主资料（粉丝数、投稿数等）。
    #[tool(description = "获取UP主资料卡：名字、签名、等级、粉丝数、关注数、投稿总数。")]
    async fn get_upper_info(
        &self,
        Parameters(p): Parameters<UpperMidParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let info = map_cmd(commands::submission::get_upper_info(p.mid).await)?;
        json_ok(json!({
            "mid": info.mid,
            "name": info.name,
            "sign": info.sign,
            "level": info.level,
            "fans": info.fans,
            "following": info.following,
            "video_count": info.archive_count,
        }))
    }

    /// 获取 UP 主投稿列表（可关键词过滤）。
    #[tool(description = "获取UP主投稿视频列表（按发布时间倒序，可按关键词过滤标题），分页。条目含 bvid 可直接下载。")]
    async fn get_upper_videos(
        &self,
        Parameters(p): Parameters<GetUpperVideosParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(
            commands::submission::get_submission_videos(p.mid, p.page, p.keyword).await,
        )?;
        json_ok(json!({
            "page": res.page,
            "total": res.total,
            "has_more": res.has_more,
            "items": trim_video_list(&res.items),
        }))
    }

    /// 获取我的关注列表。
    #[tool(description = "获取当前用户关注的 UP 主列表（需登录），分页。条目含 mid（可用于订阅其合集/下载其投稿）。")]
    async fn get_followings(
        &self,
        Parameters(p): Parameters<PageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(commands::following::get_followings(p.page).await)?;
        json_ok(json!({
            "page": res.page,
            "total": res.total,
            "has_more": res.has_more,
            "items": res.items.iter().map(|u| json!({
                "mid": u.mid,
                "name": u.name,
                "sign": u.sign,
            })).collect::<Vec<_>>(),
        }))
    }

    /// 获取某用户的粉丝列表。
    #[tool(description = "获取某用户的粉丝列表，分页（需登录）。")]
    async fn get_followers(
        &self,
        Parameters(p): Parameters<GetFollowersParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(commands::following::get_followers(p.mid, p.page).await)?;
        json_ok(json!({
            "page": res.page,
            "total": res.total,
            "has_more": res.has_more,
            "items": res.items.iter().map(|u| json!({
                "mid": u.mid,
                "name": u.name,
                "sign": u.sign,
            })).collect::<Vec<_>>(),
        }))
    }

    /// 获取我收藏的合集列表。
    #[tool(description = "获取当前用户收藏的合集列表（需登录）。条目的 id/collection_type/mid 可用于 add_subscription 订阅追更。")]
    async fn get_subscribed_collections(&self) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::collection::get_subscribed_collections().await)?;
        json_ok(json!(items
            .iter()
            .map(|c| json!({
                "id": c.id,
                "name": c.name,
                "collection_type": c.collection_type,
                "total": c.total,
                "upper_name": c.upper_name,
                "upper_mid": c.upper_mid,
            }))
            .collect::<Vec<_>>()))
    }

    /// 获取收藏夹内的视频。
    #[tool(description = "分页获取收藏夹内的视频。media_id 来自 get_favorite_folders。条目含 bvid 可直接下载。")]
    async fn get_favorite_videos(
        &self,
        Parameters(p): Parameters<GetFavoriteVideosParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let res = map_cmd(commands::favorite::get_favorite_videos(p.media_id.clone(), p.page).await)?;
        json_ok(json!(res
            .medias
            .iter()
            .filter(|m| !m.bvid.is_empty())
            .map(|m| json!({ "id": m.id, "bvid": m.bvid, "title": m.title }))
            .collect::<Vec<_>>()))
    }

    /// 获取我的稍后再看列表。
    #[tool(description = "获取当前用户的稍后再看列表（需登录）。条目含 bvid 可直接下载。")]
    async fn get_watch_later(&self) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = map_cmd(commands::watch_later::get_watch_later().await)?;
        json_ok(json!(trim_video_list(&items)))
    }

    /// 搜索联想词。
    #[tool(description = "获取搜索联想词（输入前缀 → 候补关键词），帮助把模糊需求变成准确的搜索词。失败返回空数组。")]
    async fn get_search_suggest(
        &self,
        Parameters(p): Parameters<SearchSuggestParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let items = commands::search::get_search_suggest(p.term).await.map_err(internal_err)?;
        json_ok(json!(items))
    }

    // ---------- 下载补充 ----------

    /// 暂停全部下载任务。
    #[tool(description = "暂停全部下载任务：运行中的中断并保留 .tmp 供续传，排队中的移出队列。返回排队中被移除的任务数。")]
    async fn pause_all_downloads(&self) -> Result<CallToolResult, ErrorData> {
        let n = map_cmd(commands::download::pause_all_downloads(self.app.clone()))?;
        json_ok(json!({ "queued_paused": n }))
    }

    /// 批量下载整部番剧/剧集（按 season_id，每集独立入队）。
    #[tool(description = "批量下载整部番剧/剧集/合集：按 season_id 解析全部正片，每集独立入队（自动去重）。season_id 来自搜索结果或 get_pgc_rank。返回 {total, queued, skipped}。")]
    async fn batch_download_season(
        &self,
        Parameters(p): Parameters<SeasonIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        crate::mcp::rate_limit::acquire_bili().await;
        let state = self.app.state::<DbState>();
        let res = map_cmd(commands::batch::batch_download_season(p.season_id, state).await)?;
        json_ok(serde_json::to_value(&res).map_err(internal_err)?)
    }

    /// 读取应用当前设置（只读）。
    #[tool(description = "读取 未雨 当前应用设置（只读）：默认画质、编码偏好、下载目录、并发数、附加下载开关（弹幕/字幕/NFO）等。download_video 不传 qn 时按这里的 video_max_quality 执行。修改设置请到桌面应用。")]
    async fn get_app_settings(&self) -> Result<CallToolResult, ErrorData> {
        let s = commands::settings::load_settings();
        json_ok(json!({
            "video_max_quality": s.video_max_quality,
            "video_min_quality": s.video_min_quality,
            "video_codec_priority": s.video_codec_priority,
            "audio_format": s.audio_format,
            "download_dir": s.default_download_dir,
            "filename_template": if s.filename_template.is_empty() { "{video_title}/{title}" } else { s.filename_template.as_str() },
            "max_concurrent_downloads": s.max_concurrent_downloads,
            "download_danmaku": s.download_danmaku,
            "download_subtitle": s.download_subtitle,
            "download_nfo": s.download_nfo,
            "subscription_check_interval_min": s.subscription_check_interval_min,
        }))
    }

    // ---------- 状态 ----------

    /// 查询登录状态（下载与互动都需要登录；登录在桌面应用完成，凭证共享）。
    #[tool(description = "查询B站登录状态。下载和互动操作需要登录；未登录时提示用户在 未雨 桌面应用中扫码登录（凭证自动共享给 MCP 实例）。")]
    async fn get_login_status(&self) -> Result<CallToolResult, ErrorData> {
        match Credential::load() {
            Ok(Some(cred)) => json_ok(json!({
                "logged_in": true,
                // DedeUserID cookie 即用户 mid
                "mid": cred.dedeuserid,
            })),
            Ok(None) => json_ok(json!({
                "logged_in": false,
                "hint": "未登录。请在 未雨 桌面应用中扫码登录，登录后 MCP 实例立即可用（凭证文件共享，无需重启本服务）。",
            })),
            Err(e) => json_ok(json!({
                "logged_in": false,
                "error": e.to_string(),
            })),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BiliMcpServer {
    fn get_info(&self) -> ServerConfig {
        // 服务器在 initialize 响应里应回握手版本（LATEST 已无 initialize 握手，见 ProtocolVersion 文档）
        let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
        info.protocol_version = ProtocolVersion::LATEST_WITH_INITIALIZE;
        info.server_info = Implementation::new("weiyu", env!("CARGO_PKG_VERSION"));
        info.server_info.title = Some("未雨".to_string());
        info.instructions = Some(
            "未雨 是B站视频下载器。典型流程：search_videos 找视频 → download_video 提交下载（立即返回 task_id）→ list_downloads 轮询进度。\
             内容理解：parse_video 拿视频信息 → get_video_comments 看评论区、get_ai_summary 拿官方AI总结、get_video_danmaku/get_video_subtitles 取弹幕字幕、get_article_content 读专栏。\
             榜单发现：get_ranking/get_recommend/get_hot_search/get_weekly_detail/get_precious_list 等；UP主维度：get_upper_info/get_upper_videos。\
             整季下载：get_pgc_rank/batch_download_season。下载与互动需要用户已在桌面应用登录（凭证共享，可用 get_login_status 确认）。\
             coin_video 等互动是对真实账号的操作，调用前先确认用户意图；delete_download(delete_file=true) 不可恢复。\
             触发风控验证码时只能在桌面应用完成。"
                .to_string(),
        );
        info
    }
}
