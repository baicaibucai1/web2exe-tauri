// Windows 发布版不要弹出那个黑色控制台窗口。
// 注意只在非 debug 下生效 —— 开发时要留着它看 panic 信息。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // 自动更新。没有这两个插件注册，前端调 check() 会报
        // "command not found"，而不是给出任何有用的提示。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
