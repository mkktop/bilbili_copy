//! 在线播放器精准拖动：解析 B站 DASH **分片式 fMP4** 的 `sidx`（Segment Index）盒，
//! 构建「时间→字节」索引（每个分片/子段一个点），供前端 seek 时直接跳到目标分片的
//! moof 字节 —— 该 moof 自带绝对时间(tfdt)，MSE 会按其真实时间放置，无需 timestampOffset。
//!
//! B站 DASH 实测结构：ftyp + moov(极小、空 stbl) + sidx + (moof + mdat)×N。
//! 仅用于在线播放器；下载路径不使用。解析失败 / 数据不全一律返回 None，前端走回退。

use crate::proxy_fetch_bytes;
use anyhow::Result;
use serde::Serialize;

/// 一个 seek 关键点：某分片起点的播放时间（秒）与其 moof 在文件中的字节偏移
#[derive(Debug, Clone, Serialize)]
pub struct SeekPoint {
    pub time_secs: f64,
    pub byte: u64,
}

/// 单条流的 seek 索引
#[derive(Debug, Clone, Default, Serialize)]
pub struct StreamSeekIndex {
    /// init 段结束字节偏移（= ftyp + moov + sidx 之后、首个 moof 之前）。
    /// 前端 seek 重建 SourceBuffer 后 fetch [0, init_end) 作为 init 段 append（让 MSE 拿到 moov）。
    pub init_end: u64,
    /// 时间升序的分片起点
    pub points: Vec<SeekPoint>,
}

// ==================== box 头解析 ====================

/// 读 box 头，返回 (type, header_size, total_size)。越界 / 数据不全返回 None。
///
/// 安全约束（防畸形流 panic）：box 声明的大小必须 ≥ 头长度且完全落在缓冲区
/// [off, end) 内。size==1 时 large size 可达 2^64，直接 `off + total` 会溢出
/// 回绕绕过上界检查，随后 `data[off]` 越界 panic（畸形/被篡改的流头即可触发）。
fn box_header(data: &[u8], off: usize, end: usize) -> Option<([u8; 4], usize, usize)> {
    if off.checked_add(8)? > end {
        return None;
    }
    let size = u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]) as u64;
    let typ: [u8; 4] = data[off + 4..off + 8].try_into().ok()?;
    let (hdr, total) = if size == 1 {
        if off.checked_add(16)? > end {
            return None;
        }
        let large = u64::from_be_bytes(data[off + 8..off + 16].try_into().ok()?);
        (16usize, large)
    } else if size == 0 {
        // size==0：box 延伸到缓冲区末尾
        (8usize, (end - off) as u64)
    } else {
        (8usize, size)
    };
    let total = total as usize; // 64 位平台无损；32 位平台本模块无实际使用
    if total < hdr || total > end - off {
        return None;
    }
    Some((typ, hdr, total))
}

/// 在 [start, end) 范围内查找第一个类型为 typ 的直接子 box，返回其 body（去掉头）范围。
/// box_header 已保证 total ≥ 8 且 off + total ≤ end，推进不会溢出也不会死循环。
fn find_child(data: &[u8], start: usize, end: usize, typ: &[u8; 4]) -> Option<(usize, usize)> {
    let mut off = start;
    while let Some((t, hdr, total)) = box_header(data, off, end) {
        if &t == typ {
            return Some((off + hdr, off + total));
        }
        off += total;
    }
    None
}

fn u16_at(data: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_be_bytes(data.get(off..off + 2)?.try_into().ok()?))
}
fn u32_at(data: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(off..off + 4)?.try_into().ok()?))
}
fn u64_at(data: &[u8], off: usize) -> Option<u64> {
    Some(u64::from_be_bytes(data.get(off..off + 8)?.try_into().ok()?))
}

// ==================== sidx 解析 ====================

/// 解析 sidx box（body 已去 8 字节 box 头）。返回 (init_end, points)。
/// - init_end = sidx box 结束偏移 + first_offset = 首个 moof 的字节偏移。
/// - points = 每个子段起点 (cum_time/timescale, cum_byte)。
fn parse_sidx(data: &[u8], body: (usize, usize)) -> Option<(u64, Vec<SeekPoint>)> {
    let (s, e) = body;
    if s + 12 > e {
        return None;
    }
    let version = data[s]; // body[0]=version, body[1..4]=flags
    let timescale = u32_at(data, s + 8)? as f64; // body[4]=reference_ID(4), body[8]=timescale(4)
    if timescale <= 0.0 {
        return None;
    }
    // version0: earliest_presentation_time(4)@body[12] + first_offset(4)@body[16]
    // version1: earliest_presentation_time(8)@body[12] + first_offset(8)@body[20]
    let (ept, first_offset, p) = if version == 0 {
        (u32_at(data, s + 12)? as u64, u32_at(data, s + 16)? as u64, s + 20)
    } else {
        (u64_at(data, s + 12)?, u64_at(data, s + 20)?, s + 28)
    };
    if p + 4 > e {
        return None;
    }
    let ref_count = u16_at(data, p + 2)? as usize; // body[p]=reserved(2), body[p+2]=reference_count(2)
    let mut rp = p + 4;
    // 首个 moof 字节 = sidx box 结束(body_end) + first_offset
    let first_moof = body.1 as u64 + first_offset;

    let mut points: Vec<SeekPoint> = Vec::with_capacity(ref_count);
    let mut t = ept;
    let mut byte = first_moof;
    for _ in 0..ref_count {
        if rp + 12 > e {
            break;
        }
        let raw = u32_at(data, rp)?;
        let referenced_size = (raw & 0x7FFF_FFFF) as u64; // 1 bit reference_type | 31 bit size
        let subseg_duration = u32_at(data, rp + 4)? as u64;
        points.push(SeekPoint {
            time_secs: t as f64 / timescale,
            byte,
        });
        byte += referenced_size;
        t += subseg_duration;
        rp += 12;
    }
    Some((first_moof, points))
}

// ==================== 主解析 ====================

/// 解析已抓取的字节，从顶层 sidx 构建 seek 索引。
/// data 须包含完整 sidx（通常在首个 2MB 内）；否则返回 Err(reason)（调用方继续抓取 / 诊断）。
pub fn parse_index(data: &[u8]) -> Result<StreamSeekIndex, String> {
    let sidx_body = find_child(data, 0, data.len(), b"sidx").ok_or_else(|| "无 sidx".to_string())?;
    let (init_end, points) = parse_sidx(data, sidx_body).ok_or_else(|| "sidx 解析失败".to_string())?;
    if points.is_empty() {
        return Err("sidx 无 reference".to_string());
    }
    Ok(StreamSeekIndex { init_end, points })
}

/// 诊断：打印顶层 box 布局（type@偏移(大小)）
fn log_top_boxes(data: &[u8]) {
    let mut off = 0usize;
    let mut parts: Vec<String> = Vec::new();
    while let Some((typ, _hdr, total)) = box_header(data, off, data.len()) {
        let t = std::str::from_utf8(&typ).unwrap_or("?");
        parts.push(format!("{}@{}({})", t, off, total));
        if total == 0 {
            break;
        }
        off += total;
        if parts.len() >= 24 {
            break;
        }
    }
    log::warn!("[seek-index] 顶层 box(前{}): {} | buf={}B", parts.len(), parts.join(" "), data.len());
}

// ==================== 抓取（复用池化代理 client）====================

/// 抓取流头部字节直到 sidx 完整，解析返回 seek 索引；抓不到 / 解析失败返回 None（带诊断日志）。
pub async fn fetch_index(url: &str, label: &str) -> Result<Option<StreamSeekIndex>> {
    const CHUNK: u64 = 2 * 1024 * 1024;
    const CAP: u64 = 8 * 1024 * 1024; // sidx 通常在首个 2MB 内；上限放宽到 8MB
    let mut buf: Vec<u8> = Vec::new();
    let mut fetched: u64 = 0;
    let mut last_reason = String::new();
    loop {
        let chunk = proxy_fetch_bytes(url, fetched, fetched + CHUNK - 1).await?;
        if chunk.is_empty() {
            break;
        }
        buf.extend_from_slice(&chunk);
        fetched += chunk.len() as u64;
        match parse_index(&buf) {
            Ok(idx) => {
                log::info!(
                    "[seek-index] {} 解析成功: points={}, init_end={}, fetched={}B",
                    label, idx.points.len(), idx.init_end, fetched
                );
                return Ok(Some(idx));
            }
            Err(r) => last_reason = r,
        }
        if fetched >= CAP {
            break;
        }
    }
    log::warn!(
        "[seek-index] {} 解析失败: {}（已抓 {}B），回退顺序填充",
        label, last_reason, fetched
    );
    log_top_boxes(&buf);
    Ok(parse_index(&buf).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let size = (8 + body.len()) as u32;
        let mut v = size.to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn box_header_parses_normal_and_extended() {
        let b = box_(b"ftyp", &[0u8; 4]);
        let (typ, hdr, total) = box_header(&b, 0, b.len()).unwrap();
        assert_eq!(&typ, b"ftyp");
        assert_eq!(hdr, 8);
        assert_eq!(total, b.len());
        // 扩展 size
        let mut v = 1u32.to_be_bytes().to_vec();
        v.extend_from_slice(b"mdat");
        v.extend_from_slice(&100u64.to_be_bytes());
        v.resize(100, 0);
        let (typ2, hdr2, total2) = box_header(&v, 0, v.len()).unwrap();
        assert_eq!(&typ2, b"mdat");
        assert_eq!(hdr2, 16);
        assert_eq!(total2, 100);
    }

    #[test]
    fn find_child_locates_top_level_sidx() {
        let ftyp = box_(b"ftyp", &[0u8; 4]);
        let moov = box_(b"moov", &[0u8; 8]);
        let sidx = box_(b"sidx", &[0u8; 4]);
        let mut data = ftyp;
        data.extend_from_slice(&moov);
        data.extend_from_slice(&sidx);
        let found = find_child(&data, 0, data.len(), b"sidx").unwrap();
        assert_eq!(&data[found.0..found.0 + 4], &[0u8; 4]); // sidx body = 4 zero bytes
    }

    #[test]
    fn parse_sidx_builds_segment_points() {
        // 构造 version0 sidx：timescale=1000, ept=0, first_offset=0, 2 个 reference
        // ref0: size=1000, dur=2000 ; ref1: size=2000, dur=3000
        let mut body: Vec<u8> = Vec::new();
        body.push(0); // version
        body.extend_from_slice(&[0u8; 3]); // flags
        body.extend_from_slice(&1u32.to_be_bytes()); // reference_ID
        body.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        body.extend_from_slice(&0u32.to_be_bytes()); // earliest_presentation_time
        body.extend_from_slice(&0u32.to_be_bytes()); // first_offset
        body.extend_from_slice(&[0u8; 2]); // reserved
        body.extend_from_slice(&2u16.to_be_bytes()); // reference_count
        // ref0
        body.extend_from_slice(&1000u32.to_be_bytes()); // referenced_size(31bit) = 1000
        body.extend_from_slice(&2000u32.to_be_bytes()); // subsegment_duration
        body.extend_from_slice(&0u32.to_be_bytes()); // SAP
        // ref1
        body.extend_from_slice(&2000u32.to_be_bytes()); // size
        body.extend_from_slice(&3000u32.to_be_bytes()); // duration
        body.extend_from_slice(&0u32.to_be_bytes()); // SAP
        // sidx box：放在偏移 32 处（前面塞个 ftyp 占位）
        let mut ftyp = box_(b"ftyp", &[0u8; 24]);
        let sidx_box = box_(b"sidx", &body);
        ftyp.extend_from_slice(&sidx_box);
        // sidx body 范围：ftyp(32) 之后，去 8 字节 sidx 头
        let sidx_body_start = 32 + 8;
        let sidx_body_end = ftyp.len();
        let (init_end, points) = parse_sidx(&ftyp, (sidx_body_start, sidx_body_end)).unwrap();
        // init_end = sidx box 结束 = ftyp.len()（first_offset=0）
        assert_eq!(init_end, ftyp.len() as u64);
        assert_eq!(points.len(), 2);
        // 段0：t=0/1000=0, byte=init_end
        assert!((points[0].time_secs - 0.0).abs() < 1e-9);
        assert_eq!(points[0].byte, init_end);
        // 段1：t=(0+2000)/1000=2.0, byte=init_end+1000
        assert!((points[1].time_secs - 2.0).abs() < 1e-9);
        assert_eq!(points[1].byte, init_end + 1000);
    }
}
