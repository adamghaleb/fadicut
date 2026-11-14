mod gpu;

/// System info for the frontend to know what's available
#[tauri::command]
fn get_system_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "backend": "tauri",
        "gpu_available": gpu::is_gpu_available(),
    })
}

/// Read a file from the native filesystem
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

/// Write bytes to a file on the native filesystem
#[tauri::command]
async fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    tokio::fs::write(&path, &data)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))
}

/// Get GPU adapter info
#[tauri::command]
fn get_gpu_info() -> serde_json::Value {
    gpu::get_adapter_info()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            read_file_bytes,
            write_file_bytes,
            get_gpu_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
