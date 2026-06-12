use crate::bilibili::credential::Credential;
use crate::bilibili::credential::UserInfo;
use crate::bilibili::passport;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct QrCodeResult {
    pub url: String,
    pub qrcode_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QrPollStatus {
    Pending,
    Scanned,
    Confirmed,
    Expired,
}

#[derive(Debug, Serialize)]
pub struct QrPollResult {
    pub status: QrPollStatus,
    pub user_info: Option<UserInfo>,
}

/// 生成二维码
#[tauri::command]
pub async fn login_generate_qrcode() -> Result<QrCodeResult, String> {
    passport::seed_buvid().await.map_err(|e| e.to_string())?;
    let data = passport::generate_qrcode().await.map_err(|e| e.to_string())?;
    Ok(QrCodeResult {
        url: data.url,
        qrcode_key: data.qrcode_key,
    })
}

/// 轮询二维码状态
#[tauri::command]
pub async fn login_poll_qrcode(qrcode_key: String) -> Result<QrPollResult, String> {
    let (code, cred) = passport::poll_qrcode(&qrcode_key)
        .await
        .map_err(|e| e.to_string())?;

    match code {
        86101 => Ok(QrPollResult {
            status: QrPollStatus::Pending,
            user_info: None,
        }),
        86090 => Ok(QrPollResult {
            status: QrPollStatus::Scanned,
            user_info: None,
        }),
        0 => {
            let cred = cred.ok_or("登录成功但未获取到凭证")?;
            let user_info = passport::validate_credentials(&cred)
                .await
                .map_err(|e| e.to_string())?;
            cred.save().map_err(|e| e.to_string())?;
            Ok(QrPollResult {
                status: QrPollStatus::Confirmed,
                user_info: Some(user_info),
            })
        }
        86038 => Ok(QrPollResult {
            status: QrPollStatus::Expired,
            user_info: None,
        }),
        _ => Err(format!("未知状态码: {}", code)),
    }
}

/// 检查登录状态（启动时自动调用）
#[tauri::command]
pub async fn login_check() -> Result<Option<UserInfo>, String> {
    let cred = Credential::load().map_err(|e| e.to_string())?;
    match cred {
        Some(c) => match passport::validate_credentials(&c).await {
            Ok(info) => {
                // 验证成功，检查 Cookie 是否需要刷新
                if let Ok(Some(new_cred)) = c.check_and_refresh().await {
                    log::info!("[login] Cookie 已自动刷新");
                    // 用新凭证重新验证
                    if let Ok(new_info) = passport::validate_credentials(&new_cred).await {
                        return Ok(Some(new_info));
                    }
                }
                Ok(Some(info))
            }
            Err(e) => {
                let err_str = e.to_string();
                // -101 尝试刷新 Cookie
                if err_str.contains("-101") || err_str.contains("账号未登录") {
                    log::info!("[login] 凭证验证失败(-101)，尝试刷新 Cookie");
                    if let Ok(Some(new_cred)) = c.check_and_refresh().await {
                        if let Ok(new_info) = passport::validate_credentials(&new_cred).await {
                            log::info!("[login] Cookie 刷新后验证成功");
                            return Ok(Some(new_info));
                        }
                    }
                }
                log::warn!("[login] 凭证验证失败，删除凭证: {}", err_str);
                let _ = Credential::delete();
                Ok(None)
            }
        },
        None => Ok(None),
    }
}

/// 退出登录
#[tauri::command]
pub async fn login_logout() -> Result<(), String> {
    Credential::delete().map_err(|e| e.to_string())
}
