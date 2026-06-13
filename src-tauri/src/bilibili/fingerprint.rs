use base64::{engine::general_purpose, Engine as _};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;

// ==================== GPU 预设 ====================

/// GPU 预设信息
#[derive(Debug, Clone)]
struct GpuPreset {
    display_name: &'static str,
    model: &'static str,
    device_id: &'static str,
    angle_info: &'static str,
}

/// GPU 预设列表 (id → 配置)
fn gpu_presets() -> Vec<(&'static str, GpuPreset)> {
    vec![
        ("nvidia_4070", GpuPreset {
            display_name: "NVIDIA GeForce RTX 4070",
            model: "NVIDIA GeForce RTX 4070",
            device_id: "0x00002786",
            angle_info: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (NVIDIA)",
        }),
        ("nvidia_4070ti", GpuPreset {
            display_name: "NVIDIA GeForce RTX 4070 Ti SUPER",
            model: "NVIDIA GeForce RTX 4070 Ti SUPER",
            device_id: "0x00002705",
            angle_info: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER (0x00002705) Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (NVIDIA)",
        }),
        ("nvidia_4080", GpuPreset {
            display_name: "NVIDIA GeForce RTX 4080",
            model: "NVIDIA GeForce RTX 4080",
            device_id: "0x00002782",
            angle_info: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (NVIDIA)",
        }),
        ("nvidia_4090", GpuPreset {
            display_name: "NVIDIA GeForce RTX 4090",
            model: "NVIDIA GeForce RTX 4090",
            device_id: "0x00002684",
            angle_info: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (NVIDIA)",
        }),
        ("amd_7800xt", GpuPreset {
            display_name: "AMD Radeon RX 7800 XT",
            model: "AMD Radeon RX 7800 XT",
            device_id: "0x0000747E",
            angle_info: "ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)ATI Technologies Inc.",
        }),
        ("amd_7900xtx", GpuPreset {
            display_name: "AMD Radeon RX 7900 XTX",
            model: "AMD Radeon RX 7900 XTX",
            device_id: "0x0000744C",
            angle_info: "ANGLE (AMD, AMD Radeon RX 7900 XTX (0x0000744C) Direct3D11 vs_5_0 ps_5_0, D3D11)ATI Technologies Inc.",
        }),
        ("intel_a770", GpuPreset {
            display_name: "Intel Arc A770",
            model: "Intel Arc A770 Graphics",
            device_id: "0x000056A0",
            angle_info: "ANGLE (Intel, Intel Arc A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)Intel Inc.",
        }),
    ]
}

// ==================== 分辨率预设 ====================

#[derive(Debug, Clone)]
struct ResolutionPreset {
    display_name: &'static str,
    width: u32,
    height: u32,
}

fn resolution_presets() -> Vec<(&'static str, ResolutionPreset)> {
    vec![
        ("1080p", ResolutionPreset { display_name: "1920×1080 (1080p)", width: 1920, height: 1080 }),
        ("1440p", ResolutionPreset { display_name: "2560×1440 (2K)", width: 2560, height: 1440 }),
        ("4k", ResolutionPreset { display_name: "3840×2160 (4K)", width: 3840, height: 2160 }),
        ("ultrawide", ResolutionPreset { display_name: "3440×1440 (超宽)", width: 3440, height: 1440 }),
        ("laptop", ResolutionPreset { display_name: "1366×768 (笔记本)", width: 1366, height: 768 }),
    ]
}

// ==================== WebGL 扩展 (Chrome) ====================

const CHROME_WEBGL_EXTENSIONS: &[&str] = &[
    "ANGLE_instanced_arrays",
    "EXT_blend_minmax",
    "EXT_color_buffer_half_float",
    "EXT_disjoint_timer_query",
    "EXT_float_blend",
    "EXT_frag_depth",
    "EXT_shader_texture_lod",
    "EXT_texture_compression_bptc",
    "EXT_texture_compression_rgtc",
    "EXT_texture_filter_anisotropic",
    "WEBKIT_EXT_texture_filter_anisotropic",
    "EXT_sRGB",
    "KHR_parallel_shader_compile",
    "OES_element_index_uint",
    "OES_fbo_render_mipmap",
    "OES_standard_derivatives",
    "OES_texture_float",
    "OES_texture_float_linear",
    "OES_texture_half_float",
    "OES_texture_half_float_linear",
    "OES_vertex_array_object",
    "WEBGL_color_buffer_float",
    "WEBGL_compressed_texture_s3tc",
    "WEBGL_compressed_texture_s3tc_srgb",
    "WEBGL_debug_renderer_info",
    "WEBGL_debug_shaders",
    "WEBGL_depth_texture",
    "WEBGL_draw_buffers",
    "WEBGL_lose_context",
    "WEBGL_multi_draw",
];

// ==================== Fingerprint 生成 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fingerprint {
    pub dm_img_str: String,
    pub dm_cover_img_str: String,
    pub dm_img_list: String,
    pub dm_img_inter: String,
}

/// GPU 预设选项 (id, display_name) — 供前端下拉使用
pub fn get_gpu_preset_options() -> Vec<(String, String)> {
    gpu_presets()
        .into_iter()
        .map(|(id, p)| (id.to_string(), p.display_name.to_string()))
        .collect()
}

/// 分辨率预设选项 (id, display_name) — 供前端下拉使用
pub fn get_resolution_preset_options() -> Vec<(String, String)> {
    resolution_presets()
        .into_iter()
        .map(|(id, p)| (id.to_string(), p.display_name.to_string()))
        .collect()
}

/// 根据 GPU + 分辨率预设生成指纹
pub fn generate_fingerprint(gpu_preset: &str, resolution_preset: &str) -> Result<Fingerprint, String> {
    let gpu = gpu_presets()
        .iter()
        .find(|(id, _)| *id == gpu_preset)
        .map(|(_, p)| p.clone())
        .ok_or_else(|| format!("未知 GPU 预设: {}", gpu_preset))?;

    let res = resolution_presets()
        .iter()
        .find(|(id, _)| *id == resolution_preset)
        .map(|(_, p)| p.clone())
        .ok_or_else(|| format!("未知分辨率预设: {}", resolution_preset))?;

    Ok(Fingerprint {
        dm_img_str: generate_dm_img_str(&gpu),
        dm_cover_img_str: generate_dm_cover_img_str(&gpu),
        dm_img_list: generate_dm_img_list(res.width, res.height),
        dm_img_inter: generate_dm_img_inter(res.width, res.height),
    })
}

/// 随机生成默认指纹
pub fn generate_default_fingerprint() -> Fingerprint {
    let mut rng = rand::thread_rng();
    let gpus = gpu_presets();
    let resolutions = resolution_presets();
    let gpu = &gpus[rng.gen_range(0..gpus.len())].1;
    let res = &resolutions[rng.gen_range(0..resolutions.len())].1;

    Fingerprint {
        dm_img_str: generate_dm_img_str(gpu),
        dm_cover_img_str: generate_dm_cover_img_str(gpu),
        dm_img_list: generate_dm_img_list(res.width, res.height),
        dm_img_inter: generate_dm_img_inter(res.width, res.height),
    }
}

// ==================== 内部生成函数 ====================

/// 生成 dm_img_str (Base64 编码的 WebGL 上下文信息)
fn generate_dm_img_str(_gpu: &GpuPreset) -> String {
    let extensions_str = CHROME_WEBGL_EXTENSIONS.join(" ");
    let full_info = format!(
        "WebGL 1.0 | Version: WebGL 1.0, Vendor: WebKit, Renderer: WebKit WebGL, GLSL: WebGL GLSL ES 1.0 | WebKit WebGL | GLSL: WebGL GLSL ES 1.0 | Extensions: {}",
        extensions_str
    );
    general_purpose::STANDARD.encode(full_info.as_bytes())
}

/// 生成 dm_cover_img_str (Base64 编码的 GPU 信息)
fn generate_dm_cover_img_str(gpu: &GpuPreset) -> String {
    let full_gpu_info = format!(
        "{} | NVIDIA {} {} | Device: {} | Driver: vs_5_0 ps_5_0 | DirectX: Direct3D11",
        gpu.angle_info, gpu.model, gpu.device_id, gpu.device_id
    );
    general_purpose::STANDARD.encode(full_gpu_info.as_bytes())
}

/// 生成 dm_img_list (模拟鼠标交互 JSON)
fn generate_dm_img_list(width: u32, height: u32) -> String {
    let mut rng = rand::thread_rng();
    let max_duration = 60000u32; // 最多 1 分钟
    let interaction_count: usize = rng.gen_range(3..=6);

    let margin_x = width / 6;
    let margin_y = height / 8;
    if margin_x * 2 >= width || margin_y * 2 >= height {
        return "[]".to_string();
    }

    let mut timestamps: Vec<u32> = Vec::with_capacity(interaction_count);
    for _ in 0..interaction_count {
        timestamps.push(rng.gen_range(0..max_duration));
    }
    timestamps.sort();

    let mut interactions = Vec::with_capacity(interaction_count);
    for (i, &ts) in timestamps.iter().enumerate() {
        let x = rng.gen_range(margin_x..(width - margin_x));
        let y = rng.gen_range(margin_y..(height - margin_y));
        let z = if i == 0 {
            0
        } else {
            let gap = ts - timestamps[i - 1];
            if gap < 2000 { rng.gen_range(50..120) } else { rng.gen_range(120..200) }
        };
        let k = rng.gen_range(82..98);
        interactions.push(json!({
            "x": x, "y": y, "z": z, "timestamp": ts, "k": k, "type": 0
        }));
    }

    serde_json::to_string(&interactions).unwrap_or_else(|_| "[]".to_string())
}

/// 生成 dm_img_inter (交互统计 JSON)
fn generate_dm_img_inter(width: u32, height: u32) -> String {
    let mut rng = rand::thread_rng();

    let ds_data = json!([{
        "t": 2,
        "c": "dmlkZW8tY29udGFpbmVyLX",
        "p": [rng.gen_range(200..300), rng.gen_range(30..50), rng.gen_range(280..300)],
        "s": [rng.gen_range(400..600), rng.gen_range(18000..20000), rng.gen_range(-25000..-20000)]
    }]);

    let inter_data = json!({
        "ds": ds_data,
        "wh": [width, height, rng.gen_range(100..120)],
        "of": [rng.gen_range(500..520), rng.gen_range(1000..1020), rng.gen_range(500..520)]
    });

    serde_json::to_string(&inter_data).unwrap_or_else(|_| "{}".to_string())
}
