//! Embedded admin UI: the Vite build output of `web/` (see web/README.md),
//! served under `/admin/` with an SPA fallback to index.html.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "web/dist/"]
struct Assets;

pub async fn index() -> Response {
    serve("index.html")
}

pub async fn asset(Path(path): Path<String>) -> Response {
    serve(&path)
}

fn serve(path: &str) -> Response {
    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // Vite fingerprints everything under assets/; index.html must not be cached.
            let cache = if path.starts_with("assets/") || path.starts_with("fonts/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_string()),
                    (header::CACHE_CONTROL, cache.to_string()),
                ],
                file.data.into_owned(),
            )
                .into_response()
        }
        None if path.contains('.') => (StatusCode::NOT_FOUND, "not found").into_response(),
        // Client-side route: hand the SPA its shell.
        None => match Assets::get("index.html") {
            Some(file) => (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                file.data.into_owned(),
            )
                .into_response(),
            None => (
                StatusCode::NOT_FOUND,
                "admin UI not built: run `npm ci && npm run build` in web/",
            )
                .into_response(),
        },
    }
}
