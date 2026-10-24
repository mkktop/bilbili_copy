use anyhow::{Context, Result};
use rsa::{pkcs8::DecodePublicKey, Oaep, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
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
    #[serde(default)]
    pub level: u8,
    #[serde(default)]
    pub coins: f64,
    #[serde(default)]
    pub sign: String,
    #[serde(default)]
    pub vip: bool,
    #[serde(default)]
    pub following: u64,
    #[serde(default)]
    pub follower: u64,
    #[serde(default)]
    pub sex: String,
}

/// Cookie 刷新检查结果
pub struct CookieRefreshInfo {
    pub need_refresh: bool,
    pub timestamp: Option<i64>,
}

fn credentials_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("credentials.json")
}

// ==================== DPAPI 加密存储 ====================
// 凭据（SESSDATA/bili_jct 等）不再明文落盘：Windows DPAPI 按当前用户加密，
// 同机其他账户/直接读文件都拿不到明文。文件格式：b"DPAPIV1\n" + 密文；
// 兼容旧版明文 JSON（读到即解析并在下次 save 时自动升级为密文）。

#[cfg(target_os = "windows")]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    const UI_FORBIDDEN: u32 = 0x1;

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let mut input = data.to_vec();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: input.len() as u32,
            pbData: input.as_mut_ptr(),
        };
        let mut out_blob = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(&in_blob, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut out_blob)
        };
        if ok == 0 {
            return None;
        }
        let out = unsafe {
            let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
            let v = slice.to_vec();
            LocalFree(out_blob.pbData as _);
            v
        };
        Some(out)
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let mut input = data.to_vec();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: input.len() as u32,
            pbData: input.as_mut_ptr(),
        };
        let mut out_blob = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let mut desc_out: *mut u16 = std::ptr::null_mut(); // 出参（描述串），不使用
        let ok = unsafe {
            CryptUnprotectData(&in_blob, &mut desc_out, std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut out_blob)
        };
        if ok == 0 {
            return None;
        }
        let out = unsafe {
            let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
            let v = slice.to_vec();
            LocalFree(out_blob.pbData as _);
            v
        };
        Some(out)
    }
}

#[cfg(not(target_os = "windows"))]
mod dpapi {
    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        Some(data.to_vec())
    }
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        Some(data.to_vec())
    }
}

const DPAPI_MAGIC: &[u8] = b"DPAPIV1\n";

/// 旧明文 → 密文的迁移只需做一次；load() 会被高频并发调用，
/// 用原子标记避免多个线程同时回写造成 tmp 文件互踩。
static LEGACY_MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

impl Credential {
    pub fn load() -> Result<Option<Self>> {
        let path = credentials_path();
        if !path.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(&path)?;
        // 新格式：DPAPI 密文
        if bytes.starts_with(DPAPI_MAGIC) {
            let plain = match dpapi::unprotect(&bytes[DPAPI_MAGIC.len()..]) {
                Some(p) => p,
                None => {
                    // 密文无法解密（用户账户变更/文件损坏）：按未登录处理，不中断启动
                    log::warn!("[credential] DPAPI 解密失败，视为未登录（凭证可能已失效）");
                    return Ok(None);
                }
            };
            let cred: Credential = serde_json::from_slice(&plain)?;
            return Ok(Some(cred));
        }
        // 旧格式：明文 JSON。解析成功后立即回写为密文，完成原地升级（仅一次）。
        let content = String::from_utf8_lossy(&bytes).to_string();
        let cred: Credential = serde_json::from_str(&content)?;
        if !LEGACY_MIGRATED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let _ = cred.save();
        }
        Ok(Some(cred))
    }

    pub fn save(&self) -> Result<()> {
        let path = credentials_path();
        let plain = serde_json::to_string_pretty(self)?;
        let mut out = DPAPI_MAGIC.to_vec();
        match dpapi::protect(plain.as_bytes()) {
            Some(cipher) => out.extend_from_slice(&cipher),
            None => {
                // 加密不可用时退回明文（非 Windows 目标），保持可用性优先
                out = plain.into_bytes();
            }
        }
        // 原子写入：先写临时文件再 rename，防止崩溃导致数据丢失
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &out)?;
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

    // ==================== Cookie 自动刷新 ====================

    /// 检查 Cookie 是否需要刷新
    pub async fn refresh_info(&self) -> Result<CookieRefreshInfo> {
        let client = crate::bilibili::api_client();
        let resp = client
            .get("https://passport.bilibili.com/x/passport-login/web/cookie/info")
            .header("Cookie", self.cookie_header())
            .header("User-Agent", crate::bilibili::USER_AGENT)
            .header("Referer", "https://www.bilibili.com")
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        let code = resp["code"].as_i64().unwrap_or(-1);
        // -101 表示账号未登录，也视为需要刷新
        if code == -101 {
            return Ok(CookieRefreshInfo {
                need_refresh: true,
                timestamp: None,
            });
        }
        if code != 0 {
            anyhow::bail!("检查刷新状态失败: {}", resp["message"].as_str().unwrap_or("未知错误"));
        }

        Ok(CookieRefreshInfo {
            need_refresh: resp["data"]["refresh"].as_bool().unwrap_or(false),
            timestamp: resp["data"]["timestamp"].as_i64(),
        })
    }

    /// 执行 Cookie 刷新，返回新的 Credential
    pub async fn refresh(&self, timestamp: Option<i64>) -> Result<Self> {
        self.ensure_can_refresh()?;

        log::info!("[credential] 开始刷新 Cookie");
        let old_refresh_token = self.ac_time_value.clone();
        let correspond_path = Self::get_correspond_path(timestamp);
        let csrf = self
            .get_refresh_csrf(&correspond_path)
            .await
            .context("获取刷新 CSRF 失败，Cookie 可能已完全失效，请重新登录")?;
        let new_credential = self
            .get_new_credential(&csrf, &old_refresh_token)
            .await
            .context("刷新 Cookie 失败，ac_time_value 可能已失效")?;
        Self::confirm_refresh(&new_credential, &old_refresh_token)
            .await
            .context("确认 Cookie 刷新失败")?;

        log::info!("[credential] Cookie 刷新成功");
        Ok(new_credential)
    }

    fn ensure_can_refresh(&self) -> Result<()> {
        anyhow::ensure!(
            !self.sessdata.trim().is_empty(),
            "缺少 SESSDATA，请重新登录"
        );
        anyhow::ensure!(
            !self.bili_jct.trim().is_empty(),
            "缺少 bili_jct，请重新登录"
        );
        anyhow::ensure!(
            !self.ac_time_value.trim().is_empty(),
            "缺少 ac_time_value，请重新登录"
        );
        Ok(())
    }

    /// RSA 加密生成 correspond_path
    fn get_correspond_path(timestamp: Option<i64>) -> String {
        let key = RsaPublicKey::from_public_key_pem(
            "-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----",
        )
        .expect("RSA public key 解析失败");

        let ts = timestamp.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
                - 20000
        });
        let data = format!("refresh_{}", ts).into_bytes();
        let mut rng = rand::rngs::OsRng;
        let encrypted = key
            .encrypt(&mut rng, Oaep::new::<Sha256>(), &data)
            .expect("RSA 加密失败");
        hex::encode(encrypted)
    }

    /// 从 correspond 页面提取 refresh_csrf
    async fn get_refresh_csrf(&self, correspond_path: &str) -> Result<String> {
        let client = crate::bilibili::api_client();
        let resp = client
            .get(format!(
                "https://www.bilibili.com/correspond/1/{}",
                correspond_path
            ))
            .header("Cookie", self.cookie_header())
            .header("User-Agent", crate::bilibili::USER_AGENT)
            .header("Referer", "https://www.bilibili.com")
            .send()
            .await?
            .error_for_status()
            .context("CSRF 页面返回非成功状态")?;

        let text = resp.text().await?;
        // 从 <div id="1-name">...</div> 提取内容
        if let Some(start) = text.find(r#"<div id="1-name">"#) {
            let after = &text[start + r#"<div id="1-name">"#.len()..];
            if let Some(end) = after.find("</div>") {
                return Ok(after[..end].to_string());
            }
        }
        anyhow::bail!("CSRF 页面未返回 refresh_csrf")
    }

    /// 用新的 CSRF 和 refresh_token 换取新 Cookie
    async fn get_new_credential(&self, csrf: &str, old_refresh_token: &str) -> Result<Self> {
        let client = crate::bilibili::api_client();
        let mut resp = client
            .post("https://passport.bilibili.com/x/passport-login/web/cookie/refresh")
            .header("Cookie", self.cookie_header())
            .header("User-Agent", crate::bilibili::USER_AGENT)
            .header("Referer", "https://www.bilibili.com")
            .form(&[
                ("csrf", self.bili_jct.as_str()),
                ("refresh_csrf", csrf),
                ("refresh_token", old_refresh_token),
                ("source", "main_web"),
            ])
            .send()
            .await?
            .error_for_status()
            .context("Cookie 刷新接口返回非成功状态")?;

        // 必须在 .json 前取出 headers
        let headers = std::mem::take(resp.headers_mut());
        let body: serde_json::Value = resp.json().await?;
        let code = body["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            anyhow::bail!(
                "Cookie 刷新失败: {}",
                body["message"].as_str().unwrap_or("未知错误")
            );
        }

        // 从 Set-Cookie 提取新凭证
        let mut new_sessdata = String::new();
        let mut new_bili_jct = String::new();
        let mut new_dedeuserid = String::new();

        for cookie_header in headers.get_all("set-cookie") {
            if let Ok(val) = cookie_header.to_str() {
                if let Some((name, value)) = val.split_once('=') {
                    let name = name.trim();
                    if let Some(end) = value.find(';') {
                        match name {
                            "SESSDATA" => new_sessdata = value[..end].to_string(),
                            "bili_jct" => new_bili_jct = value[..end].to_string(),
                            "DedeUserID" => new_dedeuserid = value[..end].to_string(),
                            _ => {}
                        }
                    }
                }
            }
        }

        anyhow::ensure!(!new_sessdata.is_empty(), "刷新响应缺少 SESSDATA");
        anyhow::ensure!(!new_bili_jct.is_empty(), "刷新响应缺少 bili_jct");
        anyhow::ensure!(!new_dedeuserid.is_empty(), "刷新响应缺少 DedeUserID");

        let new_refresh_token = body["data"]["refresh_token"]
            .as_str()
            .context("刷新响应缺少 refresh_token")?
            .to_string();

        Ok(Credential {
            sessdata: new_sessdata,
            bili_jct: new_bili_jct,
            buvid3: self.buvid3.clone(),
            dedeuserid: new_dedeuserid,
            ac_time_value: new_refresh_token,
            buvid4: self.buvid4.clone(),
            dedeuserid_ckmd5: self.dedeuserid_ckmd5.clone(),
        })
    }

    /// 确认刷新（使用新凭证 + 旧 refresh_token）
    async fn confirm_refresh(new_cred: &Credential, old_refresh_token: &str) -> Result<()> {
        let client = crate::bilibili::api_client();
        let body: serde_json::Value = client
            .post("https://passport.bilibili.com/x/passport-login/web/confirm/refresh")
            .header("Cookie", new_cred.cookie_header())
            .header("User-Agent", crate::bilibili::USER_AGENT)
            .header("Referer", "https://www.bilibili.com")
            .form(&[
                ("csrf", new_cred.bili_jct.as_str()),
                ("refresh_token", old_refresh_token),
            ])
            .send()
            .await?
            .json()
            .await?;

        let code = body["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            log::warn!(
                "[credential] 确认刷新返回非0: {}",
                body["message"].as_str().unwrap_or("未知")
            );
            // 确认失败不阻塞，Cookie 已经刷新成功了
        }
        Ok(())
    }

    /// 检查并刷新 Cookie（如果需要），返回刷新后的凭证
    pub async fn check_and_refresh(&self) -> Result<Option<Self>> {
        match self.refresh_info().await {
            Ok(info) => {
                if !info.need_refresh {
                    log::debug!("[credential] Cookie 无需刷新");
                    return Ok(None);
                }
                log::info!("[credential] Cookie 需要刷新，开始刷新流程");
                let new_cred = self.refresh(info.timestamp).await?;
                new_cred.save()?;
                Ok(Some(new_cred))
            }
            Err(e) => {
                log::warn!("[credential] 检查刷新状态失败: {}", e);
                Ok(None)
            }
        }
    }
}
