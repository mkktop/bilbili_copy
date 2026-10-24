use crate::bilibili::credential::Credential;
use crate::bilibili::{REFERER, api_client, http_to_https};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 视频预览缩略图（videoshot）索引
/// API: GET https://api.bilibili.com/x/player/videoshot?bvid=&cid=&index=1
///
/// `images` 是雪碧图 URL 列表；`index` 是时间戳数组（秒），
/// 其中 -1 作为分隔符：每组时间戳对应 `images` 中的一张雪碧图。
/// 每张雪碧图按 `img_x_len × img_y_len` 网格排列 `img_x_size × img_y_size` 的小图。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Videoshot {
    pub images: Vec<String>,
    /// 时间戳（秒），-1 = 换下一张雪碧图
    pub index: Vec<i64>,
    /// 每行小图数
    pub img_x_len: u32,
    /// 每列小图数
    pub img_y_len: u32,
    /// 单张小图宽（px）
    pub img_x_size: u32,
    /// 单张小图高（px）
    pub img_y_size: u32,
}

impl Videoshot {
    /// 定位某个时间点对应的雪碧图与小图坐标
    /// 返回 (雪碧图序号, 行, 列)；无有效索引时返回 None。
    /// 时间超出末尾时钳制到最后一格（与官方播放器一致）。
    pub fn locate(&self, time_s: f64) -> Option<(usize, u32, u32)> {
        if self.images.is_empty() || self.img_x_len == 0 {
            return None;
        }
        let max_ts = self.index.iter().copied().filter(|v| *v >= 0).max()?;
        let t = (time_s.max(0.0) as i64).min(max_ts);
        let mut sprite = 0usize;
        let mut cell = 0u32;
        for (i, &ts) in self.index.iter().enumerate() {
            if ts < 0 {
                // 分隔符：后续时间戳属于下一张雪碧图
                sprite += 1;
                cell = 0;
                continue;
            }
            // 覆盖终点是下一个时间戳（跨过分隔符取下一组的第一个）
            let end = self.index[i + 1..]
                .iter()
                .find(|&&v| v >= 0)
                .copied()
                .unwrap_or(i64::MAX);
            if ts <= t && t < end {
                let x = cell % self.img_x_len;
                let y = cell / self.img_x_len;
                return Some((sprite, y, x));
            }
            cell += 1;
        }
        None
    }
}

/// 获取视频预览缩略图索引（部分视频无索引，images 为空属正常）
pub async fn get_videoshot(
    bvid: &str,
    cid: i64,
    credential: Option<&Credential>,
) -> Result<Videoshot> {
    let client = api_client();
    let cid_s = cid.to_string();
    let mut req = client
        .get("https://api.bilibili.com/x/player/videoshot")
        .header("Referer", REFERER)
        .query(&[("bvid", bvid), ("cid", cid_s.as_str()), ("index", "1")]);
    if let Some(c) = credential {
        req = req.header("Cookie", c.cookie_header());
    }
    let resp_text = req.send().await?.text().await?;
    let resp: Value = serde_json::from_str(&resp_text).context("videoshot 响应解析失败")?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!(
            "获取缩略图索引失败: {}",
            resp["message"].as_str().unwrap_or("未知错误")
        );
    }
    let d = &resp["data"];
    Ok(Videoshot {
        images: d["image"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(http_to_https)
                    .collect()
            })
            .unwrap_or_default(),
        index: d["index"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
            .unwrap_or_default(),
        img_x_len: d["img_x_len"].as_u64().unwrap_or(5) as u32,
        img_y_len: d["img_y_len"].as_u64().unwrap_or(5) as u32,
        img_x_size: d["img_x_size"].as_u64().unwrap_or(160) as u32,
        img_y_size: d["img_y_size"].as_u64().unwrap_or(90) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot() -> Videoshot {
        // 两张雪碧图：第一张 6 个时间点（0,5,10,15,20,25），第二张 2 个（30,35）
        Videoshot {
            images: vec!["a.jpg".into(), "b.jpg".into()],
            index: vec![0, 5, 10, 15, 20, 25, -1, 30, 35],
            img_x_len: 3,
            img_y_len: 2,
            img_x_size: 160,
            img_y_size: 90,
        }
    }

    #[test]
    fn locate_first_cell() {
        assert_eq!(shot().locate(0.0), Some((0, 0, 0)));
    }

    #[test]
    fn locate_wraps_row() {
        // cell 3 → 第 2 行第 1 列
        assert_eq!(shot().locate(15.0), Some((0, 1, 0)));
        assert_eq!(shot().locate(10.0), Some((0, 0, 2)));
    }

    #[test]
    fn locate_second_sprite() {
        assert_eq!(shot().locate(31.0), Some((1, 0, 0)));
        assert_eq!(shot().locate(40.0), Some((1, 0, 1)));
    }

    #[test]
    fn locate_before_zero_clamps() {
        assert_eq!(shot().locate(-5.0), Some((0, 0, 0)));
    }

    #[test]
    fn locate_empty_returns_none() {
        let s = Videoshot {
            images: vec![],
            index: vec![],
            img_x_len: 3,
            img_y_len: 2,
            img_x_size: 160,
            img_y_size: 90,
        };
        assert_eq!(s.locate(10.0), None);
    }
}
