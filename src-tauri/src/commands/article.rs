use crate::bilibili::article::{self, ArticleData};
use crate::bilibili::credential::Credential;
use crate::bilibili::download::sanitize_filename;
use crate::commands::settings::load_settings;

/// 获取专栏/图文内容（登录态可选）。
/// 传 opus_id 走 opus 图文链路（id 为字符串：19 位数超 JS 安全整数）；否则按 cvid 走传统专栏。
#[tauri::command]
pub async fn get_article_content(
    cvid: Option<u64>,
    opus_id: Option<String>,
) -> Result<ArticleData, String> {
    let credential = Credential::load().ok().flatten();
    if let Some(oid) = opus_id.filter(|s| !s.is_empty()) {
        return article::get_opus(&oid, credential.as_ref())
            .await
            .map_err(|e| format!("获取图文失败: {e}"));
    }
    let cvid = cvid.ok_or("缺少专栏 id")?;
    article::get_article(cvid, credential.as_ref())
        .await
        .map_err(|e| format!("获取专栏失败: {e}"))
}

/// 导出专栏 Markdown 到下载目录（Markdown 文本由前端 DOM 解析生成，后端只负责落盘）。
/// 返回写入的文件绝对路径。
#[tauri::command]
pub fn export_article_markdown(
    cvid: u64,
    opus_id: Option<String>,
    title: String,
    markdown: String,
) -> Result<String, String> {
    let settings = load_settings();
    let dir = if settings.default_download_dir.trim().is_empty() {
        return Err("请先在 设置 → 下载 中配置下载目录".to_string());
    } else {
        std::path::PathBuf::from(settings.default_download_dir)
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;

    // 文件名后缀：传统专栏用 cv 号，opus 图文用 opus id
    let id_tag = match opus_id.as_deref().filter(|s| !s.is_empty()) {
        Some(oid) => format!("opus{oid}"),
        None => format!("cv{cvid}"),
    };
    let safe_title = sanitize_filename(&title);
    let name = if safe_title.is_empty() {
        format!("{id_tag}.md")
    } else {
        format!("{safe_title} [{id_tag}].md")
    };
    let path = dir.join(name);
    std::fs::write(&path, markdown).map_err(|e| format!("写入 Markdown 失败: {e}"))?;
    log::info!("[article] {} Markdown 已导出: {:?}", id_tag, path);
    Ok(path.to_string_lossy().to_string())
}
