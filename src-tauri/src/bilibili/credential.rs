use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credential {
    pub sessdata: String,
    pub bili_jct: String,
    pub buvid3: String,
    pub dedeuserid: String,
    pub ac_time_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buvid4: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dedeuserid_ckmd5: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub mid: u64,
    pub uname: String,
    pub face: String,
}

fn credentials_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("credentials.json")
}

impl Credential {
    pub fn load() -> Result<Option<Self>> {
        let path = credentials_path();
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)?;
        let cred: Credential = serde_json::from_str(&content)?;
        Ok(Some(cred))
    }

    pub fn save(&self) -> Result<()> {
        let path = credentials_path();
        let content = serde_json::to_string_pretty(self)?;
        // 原子写入：先写临时文件再 rename，防止崩溃导致数据丢失
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &content)?;
        std::fs::rename(&tmp_path, &path)?;
        Ok(())
    }

    pub fn delete() -> Result<()> {
        let path = credentials_path();
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// 构建 Cookie 请求头
    pub fn cookie_header(&self) -> String {
        let mut parts = vec![
            format!("SESSDATA={}", self.sessdata),
            format!("bili_jct={}", self.bili_jct),
            format!("buvid3={}", self.buvid3),
            format!("DedeUserID={}", self.dedeuserid),
            format!("ac_time_value={}", self.ac_time_value),
        ];
        if let Some(ref b4) = self.buvid4 {
            parts.push(format!("buvid4={}", b4));
        }
        if let Some(ref ck) = self.dedeuserid_ckmd5 {
            parts.push(format!("DedeUserID__ckMd5={}", ck));
        }
        parts.join("; ")
    }
}
