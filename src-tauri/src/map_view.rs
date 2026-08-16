use serde::Deserialize;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const MAP_WEBVIEW_LABEL: &str = "pz-map";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub url: String,
}

#[tauri::command]
pub async fn open_project_zomboid_map(app: AppHandle, bounds: MapBounds) -> Result<(), String> {
    let position = LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0));
    let size = LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0));
    let url = bounds
        .url
        .parse()
        .map_err(|error| format!("Unable to parse the embedded map site URL: {error}"))?;

    if let Some(webview) = app.get_webview(MAP_WEBVIEW_LABEL) {
        webview
            .navigate(url)
            .map_err(|error| format!("Unable to navigate the embedded map site: {error}"))?;
        webview
            .set_position(position)
            .map_err(|error| format!("Unable to position the embedded map site: {error}"))?;
        webview
            .set_size(size)
            .map_err(|error| format!("Unable to resize the embedded map site: {error}"))?;
        return Ok(());
    }

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Unable to find the main application window".to_string())?;
    main_window
        .add_child(
            WebviewBuilder::new(MAP_WEBVIEW_LABEL, WebviewUrl::External(url)),
            position,
            size,
        )
        .map_err(|error| format!("Unable to embed the map site: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn close_project_zomboid_map(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(MAP_WEBVIEW_LABEL) {
        webview
            .close()
            .map_err(|error| format!("Unable to close the embedded map site: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_project_zomboid_map_visibility(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(webview) = app.get_webview(MAP_WEBVIEW_LABEL) {
        if visible {
            webview
                .show()
                .map_err(|error| format!("Unable to show the embedded map site: {error}"))?;
        } else {
            webview
                .hide()
                .map_err(|error| format!("Unable to hide the embedded map site: {error}"))?;
        }
    }

    Ok(())
}
