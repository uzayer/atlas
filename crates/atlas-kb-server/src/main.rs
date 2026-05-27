//! Single-binary static server for an exported Atlas knowledge base.
//! All HTML/CSS is embedded at compile time via `include_dir!`. On
//! startup the binary picks a free port (default 4747), opens the
//! system default browser at that URL, and serves the embedded files
//! until interrupted.

use include_dir::{include_dir, Dir};
use std::io::Cursor;
use std::net::TcpListener;
use tiny_http::{Header, Response, Server};

static WEB: Dir = include_dir!("$OUT_DIR/web");

const DEFAULT_PORT: u16 = 4747;

fn main() {
    let preferred = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let port = pick_port(preferred);
    let addr = format!("127.0.0.1:{port}");

    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("atlas-kb-server: failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    let url = format!("http://{addr}");
    println!("atlas-kb-server listening on {url}");
    println!("Press Ctrl-C to stop.");
    if let Err(e) = webbrowser::open(&url) {
        eprintln!("could not open browser ({e}); navigate to {url} manually");
    }

    for req in server.incoming_requests() {
        let mut path = req.url().split('?').next().unwrap_or("").trim_start_matches('/').to_string();
        if path.is_empty() || path.ends_with('/') {
            path.push_str("index.html");
        }
        let resp = match WEB.get_file(&path) {
            Some(file) => {
                let bytes = file.contents();
                Response::new(
                    tiny_http::StatusCode(200),
                    vec![Header::from_bytes(&b"Content-Type"[..], guess_mime(&path).as_bytes()).unwrap()],
                    Cursor::new(bytes.to_vec()),
                    Some(bytes.len()),
                    None,
                )
            }
            None => Response::new(
                tiny_http::StatusCode(404),
                vec![Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap()],
                Cursor::new(b"Not Found".to_vec()),
                Some(9),
                None,
            ),
        };
        let _ = req.respond(resp);
    }
}

/// Try the preferred port first; fall back to any free port if it's
/// already in use (common when the user runs two exports).
fn pick_port(preferred: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr().map(|a| a.port()))
        .unwrap_or(preferred)
}

fn guess_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}
