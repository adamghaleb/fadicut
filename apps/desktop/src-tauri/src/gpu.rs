use pollster::FutureExt as _;

/// Check if a GPU adapter is available
pub fn is_gpu_available() -> bool {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });

    instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .block_on()
        .is_some()
}

/// Get info about the GPU adapter
pub fn get_adapter_info() -> serde_json::Value {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });

    match instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .block_on()
    {
        Some(adapter) => {
            let info = adapter.get_info();
            serde_json::json!({
                "name": info.name,
                "vendor": info.vendor,
                "device": info.device,
                "backend": format!("{:?}", info.backend),
                "driver": info.driver,
                "driver_info": info.driver_info,
            })
        }
        None => serde_json::json!({
            "error": "No GPU adapter found"
        }),
    }
}
