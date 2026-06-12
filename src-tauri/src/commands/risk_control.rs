use crate::bilibili::credential::Credential;
use crate::bilibili::risk_control;

/// 注册验证码（前端收到风控事件后调用）
#[tauri::command]
pub async fn captcha_register(v_voucher: String) -> Result<risk_control::CaptchaInfo, String> {
    let cred = Credential::load()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "请先登录".to_string())?;

    risk_control::register_captcha(&v_voucher, &cred.bili_jct)
        .await
        .map_err(|e| e.to_string())
}

/// 提交验证码结果（前端完成滑块后调用）
#[tauri::command]
pub async fn captcha_validate(
    challenge: String,
    token: String,
    validate: String,
    seccode: String,
) -> Result<(), String> {
    let cred = Credential::load()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "请先登录".to_string())?;

    risk_control::validate_captcha(
        &challenge, &token, &validate, &seccode, &cred.bili_jct,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}
