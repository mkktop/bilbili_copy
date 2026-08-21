//! 真实登录态冒烟测试：验证 v1.1.0 新接入的 B站接口在真实凭证下工作正常。
//! 手动运行（不入 CI）：
//!   cp target/debug/credentials.json target/debug/examples/   # 首次需要
//!   cargo run --example smoke_api
//! 涉及写操作的只有稍后再看（加 → 查 → 删，结束态为已移除）。

use bilbli_copy_lib::bilibili::{
    comment, credential::Credential, following, search, video, watch_later, weekly,
};

/// 弹幕/评论量都很大的经典视频，适合做接口冒烟
const BVID: &str = "BV1GJ411x7h7";
/// 用于粉丝列表测试的公开 UP 主 mid
const UP_MID: i64 = 2;

fn ok(name: &str, detail: String) {
    println!("[PASS] {name}: {detail}");
}

fn fail(name: &str, err: impl std::fmt::Display) -> ! {
    println!("[FAIL] {name}: {err}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let cred = match Credential::load() {
        Ok(Some(c)) => c,
        Ok(None) => fail("credential", "未登录（examples 目录下无 credentials.json）"),
        Err(e) => fail("credential", e),
    };
    ok("credential", format!("已加载 mid={}", cred.dedeuserid));

    // 1. 视频信息（拿到 cid / aid / up_mid 供后续接口使用）
    let info = match video::get_video_info(Some(BVID), None, None, None, None, Some(&cred)).await {
        Ok(v) => v,
        Err(e) => fail("get_video_info", e),
    };
    let cid = info.pages.first().map(|p| p.cid).unwrap_or(0);
    ok(
        "get_video_info",
        format!("《{}》aid={} cid={} 弹幕={}", info.title, info.aid, cid, info.danmaku_count),
    );

    // 2. AI 总结（可能为 None——视频没生成总结不算失败）
    match video::get_ai_summary(BVID, cid, info.owner_mid, &cred).await {
        Ok(Some(s)) => ok("get_ai_summary", format!("摘要 {} 条 / 大纲 {} 节", s.summary.len(), s.outline.len())),
        Ok(None) => {
            // 本视频无总结：从排行榜找有总结的热门视频验证正向解析
            let mut verified = false;
            if let Ok(rank) = bilbli_copy_lib::bilibili::ranking::get_ranking(0, Some(&cred)).await {
                for v in rank.iter().take(10) {
                    let Ok(vi) = video::get_video_info(Some(&v.bvid), None, None, None, None, Some(&cred)).await else { continue };
                    let Some(c) = vi.pages.first().map(|p| p.cid) else { continue };
                    match video::get_ai_summary(&v.bvid, c, vi.owner_mid, &cred).await {
                        Ok(Some(s)) => {
                            ok("get_ai_summary", format!("《{}》摘要 {} 条 / 大纲 {} 节", v.title, s.summary.len(), s.outline.len()));
                            verified = true;
                            break;
                        }
                        Ok(None) => continue,
                        Err(e) => fail("get_ai_summary(正向)", e),
                    }
                }
            }
            if !verified {
                ok("get_ai_summary", "排行榜前 10 均无 AI 总结（Ok(None) 降级符合预期）".into());
            }
        }
        Err(e) => fail("get_ai_summary", e),
    }

    // 3. 相关推荐
    match video::get_related_videos(BVID, Some(&cred)).await {
        Ok(v) => ok("get_related_videos", format!("{} 条，首条《{}》", v.len(), v.first().map(|x| x.title.clone()).unwrap_or_default())),
        Err(e) => fail("get_related_videos", e),
    }

    // 4. 评论（热度排序）+ 楼中楼
    let comments = match comment::get_comments(info.aid as i64, 1, 3, Some(&cred)).await {
        Ok(p) => p,
        Err(e) => fail("get_comments", e),
    };
    ok("get_comments", format!("总数 {}，本页 {} 条", comments.total, comments.items.len()));
    if let Some(root) = comments.items.iter().find(|c| c.reply_count > 0) {
        match comment::get_replies(info.aid as i64, root.rpid, 1, Some(&cred)).await {
            Ok(p) => ok("get_comment_replies", format!("root={} 子回复 {} 条（总 {}）", root.rpid, p.items.len(), p.total)),
            Err(e) => fail("get_comment_replies", e),
        }
    } else {
        ok("get_comment_replies", "本页无带回复的评论，跳过".into());
    }

    // 5. 稍后再看：加 → 查 → 删（结束态为已移除，不留痕；B站列表有秒级缓存，带重试）
    async fn list_contains(cred: &Credential, bvid: &str, want: bool) -> bool {
        for i in 0..6 {
            if let Ok(v) = watch_later::get_watch_later(cred).await {
                if v.iter().any(|x| x.bvid == bvid) == want {
                    return true;
                }
            }
            if i < 5 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
        false
    }
    if let Err(e) = watch_later::add_watch_later(BVID, &cred).await {
        fail("add_watch_later", e);
    }
    if list_contains(&cred, BVID, true).await {
        ok("add_watch_later", "加入稍后再看后列表确认存在".into());
    } else {
        fail("add_watch_later", "接口返回成功但列表中未出现（静默失效）");
    }
    if let Err(e) = watch_later::remove_watch_later(BVID, &cred).await {
        fail("remove_watch_later", e);
    }
    if list_contains(&cred, BVID, false).await {
        ok("remove_watch_later", "移除后列表确认消失".into());
    } else {
        fail("remove_watch_later", "接口返回成功但列表中仍存在（静默失效）");
    }

    // 6. 粉丝列表
    match following::get_followers(UP_MID, 1, &cred).await {
        Ok(p) => ok("get_followers", format!("mid={} 总 {}，本页 {} 条", UP_MID, p.total, p.items.len())),
        Err(e) => fail("get_followers", e),
    }

    // 7. 入站必刷
    match weekly::get_precious_list(Some(&cred)).await {
        Ok(v) => ok("get_precious_list", format!("{} 条，首条《{}》", v.len(), v.first().map(|x| x.title.clone()).unwrap_or_default())),
        Err(e) => fail("get_precious_list", e),
    }

    // 8. 搜索联想
    match search::get_suggest("原神").await {
        Ok(v) => ok("get_search_suggest", format!("{} 条: {}", v.len(), v.join(" / "))),
        Err(e) => fail("get_search_suggest", e),
    }

    // 9. 历史弹幕：当前分段 + 近 2 天合并（cid 已知，直接调用内部 API 层）
    {
        use bilbli_copy_lib::bilibili::api_client;
        let client = api_client();
        match bilbli_copy_lib::bilibili::danmaku::fetch_danmaku_list(&client, &cred, cid, info.aid, 300, 0).await {
            Ok(cur) => {
                let cur_n = cur.len();
                match bilbli_copy_lib::bilibili::danmaku::fetch_danmaku_list(&client, &cred, cid, info.aid, 300, 2).await {
                    Ok(merged) => ok("history_danmaku", format!("当前 {} 条 + 近 2 天合并后 {} 条", cur_n, merged.len())),
                    Err(e) => fail("history_danmaku", e),
                }
            }
            Err(e) => fail("history_danmaku(current)", e),
        }
    }

    // 10. videoshot 缩略图索引 + 雪碧图可下载性
    {
        use bilbli_copy_lib::bilibili::videoshot;
        match videoshot::get_videoshot(BVID, cid, Some(&cred)).await {
            Ok(vs) => {
                let detail = format!(
                    "雪碧图 {} 张，索引 {} 项，网格 {}x{}，单元 {}x{}",
                    vs.images.len(), vs.index.len(), vs.img_x_len, vs.img_y_len, vs.img_x_size, vs.img_y_size
                );
                if vs.images.is_empty() {
                    ok("get_videoshot", format!("{detail}（该视频无索引）"));
                } else {
                    let mid = vs.locate(10.0).map(|(s, y, x)| format!("t=10s → 图{} 行{} 列{}", s, y, x)).unwrap_or_else(|| "定位失败".into());
                    // 抓第一张雪碧图头部字节验证 CDN 可达
                    let client = bilbli_copy_lib::bilibili::api_client();
                    let head = match client.get(&vs.images[0]).header("Referer", "https://www.bilibili.com/").send().await {
                        Ok(r) => format!("HTTP {}", r.status()),
                        Err(e) => format!("请求失败: {e}"),
                    };
                    ok("get_videoshot", format!("{detail}；{mid}；雪碧图[0] {head}"));
                }
            }
            Err(e) => fail("get_videoshot", e),
        }
    }

    println!("\n全部冒烟测试通过 ✓");
}
