//! The `plugin` URI scheme: serves the files of installed plugins, and
//! nothing else, so the webview can `import()` a plugin's module and load
//! its styles, images and fonts.
//!
//! URLs are `plugin://localhost/<id>/<path>` on macOS and Linux and
//! `http://plugin.localhost/<id>/<path>` on Windows (and Android); both
//! reach [`handle`] with the URL path `/<id>/<path>`. A query string is
//! ignored, so callers may add one to bust caches.
//!
//! Responses allow any origin (module scripts are fetched in CORS mode, and
//! the app's origin differs from the scheme's) and are never cached, so a
//! replaced plugin is reloaded.

use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

use super::manifest;

/// The scheme's name, as registered with Tauri and used in the CSP.
pub const SCHEME: &str = "plugin";

/// The file for the URL path `uri_path` (`/<id>/<relative path>`, percent
/// encoded) inside the plugins directory `root`, or `None` if the path is
/// malformed, tries to leave the plugin's folder, or names no file.
pub fn resolve(root: &Path, uri_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(uri_path.strip_prefix('/')?).decode_utf8().ok()?;
    let (id, rel) = decoded.split_once('/')?;
    if !manifest::is_valid_id_format(id) || !manifest::is_plain_relative(rel) {
        return None;
    }
    // Canonical on both sides: the plugin folder itself may be a symlink (a
    // development checkout), but nothing inside it may point elsewhere.
    let plugin_dir = root.join(id).canonicalize().ok()?;
    let file = plugin_dir.join(rel).canonicalize().ok()?;
    (file.starts_with(&plugin_dir) && file.is_file()).then_some(file)
}

/// The `Content-Type` for a file, by extension.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "md" => "text/markdown; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The response for `method` and `uri_path` against the plugins directory
/// `root` (`None` if it cannot be determined).
pub fn respond(root: Option<&Path>, method: &Method, uri_path: &str) -> Response<Vec<u8>> {
    let builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    let status = |code: StatusCode| {
        Response::builder()
            .status(code)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(code.canonical_reason().unwrap_or_default().as_bytes().to_vec())
            .expect("valid response")
    };
    if method != Method::GET {
        let mut response = status(StatusCode::METHOD_NOT_ALLOWED);
        response.headers_mut().insert(header::ALLOW, header::HeaderValue::from_static("GET"));
        return response;
    }
    let Some(file) = root.and_then(|root| resolve(root, uri_path)) else {
        return status(StatusCode::NOT_FOUND);
    };
    match std::fs::read(&file) {
        Ok(bytes) => builder
            .header(header::CONTENT_TYPE, content_type(&file))
            .body(bytes)
            .expect("valid response"),
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}

/// The Tauri handler for [`SCHEME`]; reads files off the main thread.
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let root = super::plugins_root(ctx.app_handle()).ok();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(respond(root.as_deref(), &method, &path));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn plugins() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("hello/dist")).unwrap();
        fs::write(root.path().join("hello/main.js"), "export {}").unwrap();
        fs::write(root.path().join("hello/dist/my file.css"), "a{}").unwrap();
        fs::create_dir_all(root.path().join("other")).unwrap();
        fs::write(root.path().join("other/secret.js"), "").unwrap();
        fs::write(root.path().join("top.js"), "").unwrap();
        fs::create_dir_all(root.path().join(".import-x")).unwrap();
        fs::write(root.path().join(".import-x/main.js"), "").unwrap();
        root
    }

    #[test]
    fn resolves_files_inside_a_plugin() {
        let root = plugins();
        let canon = root.path().canonicalize().unwrap();
        assert_eq!(resolve(root.path(), "/hello/main.js"), Some(canon.join("hello/main.js")));
        assert_eq!(resolve(root.path(), "/hello/dist/my%20file.css"), Some(canon.join("hello/dist/my file.css")));
    }

    #[test]
    fn refuses_everything_else() {
        let root = plugins();
        for bad in [
            "",
            "/",
            "/hello",
            "/hello/",
            "/hello/dist",
            "/hello/missing.js",
            "/top.js",
            "/hello/../other/secret.js",
            "/hello/%2e%2e/other/secret.js",
            "/hello/dist%2f..%2f..%2fother%2fsecret.js",
            "/hello//main.js",
            "/hello/./main.js",
            "/hello/..%5cother%5csecret.js",
            "/..%2ftop.js",
            "/.import-x/main.js",
            "/Hello/main.js",
            "/hello/%ff.js",
            "hello/main.js",
        ] {
            assert_eq!(resolve(root.path(), bad), None, "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_must_stay_inside_the_plugin() {
        let root = plugins();
        std::os::unix::fs::symlink(root.path().join("other/secret.js"), root.path().join("hello/link.js")).unwrap();
        assert_eq!(resolve(root.path(), "/hello/link.js"), None);
        std::os::unix::fs::symlink(root.path().join("hello/main.js"), root.path().join("hello/inner.js")).unwrap();
        assert!(resolve(root.path(), "/hello/inner.js").is_some());
        // A linked plugin folder serves its own files.
        let dev = tempfile::tempdir().unwrap();
        fs::write(dev.path().join("main.js"), "").unwrap();
        std::os::unix::fs::symlink(dev.path(), root.path().join("dev")).unwrap();
        assert!(resolve(root.path(), "/dev/main.js").is_some());
    }

    #[test]
    fn responses() {
        let root = plugins();
        let ok = respond(Some(root.path()), &Method::GET, "/hello/main.js");
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(ok.body(), b"export {}");

        let missing = respond(Some(root.path()), &Method::GET, "/hello/nope.js");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(respond(None, &Method::GET, "/hello/main.js").status(), StatusCode::NOT_FOUND);
        let post = respond(Some(root.path()), &Method::POST, "/hello/main.js");
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(post.headers()[header::ALLOW], "GET");
    }

    #[test]
    fn content_types() {
        let cases = [
            ("a.js", "text/javascript; charset=utf-8"),
            ("a.MJS", "text/javascript; charset=utf-8"),
            ("a.css", "text/css; charset=utf-8"),
            ("a.json", "application/json"),
            ("a.svg", "image/svg+xml"),
            ("a.png", "image/png"),
            ("a.jpeg", "image/jpeg"),
            ("a.woff2", "font/woff2"),
            ("a.wasm", "application/wasm"),
            ("SKILL.md", "text/markdown; charset=utf-8"),
            ("a.html", "application/octet-stream"),
            ("noext", "application/octet-stream"),
        ];
        for (name, expected) in cases {
            assert_eq!(content_type(Path::new(name)), expected, "{name}");
        }
    }
}
