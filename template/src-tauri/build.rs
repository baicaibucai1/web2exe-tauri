/*
 * 构建脚本。tauri-build 会在这里做几件事：
 *   - 把 tauri.conf.json 编译成 Rust 常量（前端资源、窗口配置、图标都在里面）
 *   - 生成 capabilities 对应的权限清单（src-tauri/gen/schemas/）
 *   - 在 GNU 目标下把 WebView2Loader.dll 拷进构建目录
 * 内容保持一行就够，不要往里加逻辑：它每次构建都跑，出错信息很难读。
 */
fn main() {
    tauri_build::build()
}
