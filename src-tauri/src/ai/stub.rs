//! A tiny HTTP server on 127.0.0.1 for the adapter tests. It records each
//! request and answers with canned responses, in order (the last repeats).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct Canned {
    pub status: u16,
    pub body: String,
    pub delay: Duration,
}

impl Canned {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self {
            status,
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }

    pub fn delayed(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

#[derive(Debug, Clone)]
pub struct Captured {
    pub method: String,
    pub path: String,
    /// Header names lowercased.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Captured {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap()
    }
}

pub struct Stub {
    pub url: String,
    requests: Arc<Mutex<Vec<Captured>>>,
}

impl Stub {
    pub fn requests(&self) -> Vec<Captured> {
        self.requests.lock().unwrap().clone()
    }
}

pub async fn serve(responses: Vec<Canned>) -> Stub {
    assert!(!responses.is_empty());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    tokio::spawn(async move {
        let mut served = 0usize;
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let canned = responses[served.min(responses.len() - 1)].clone();
            served += 1;
            let log = log.clone();
            tokio::spawn(async move {
                let Some(captured) = read_request(&mut socket).await else {
                    return;
                };
                log.lock().unwrap().push(captured);
                tokio::time::sleep(canned.delay).await;
                let head = format!(
                    "HTTP/1.1 {} Stub\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    canned.status,
                    canned.body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(canned.body.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    Stub { url, requests }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Captured> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    while buf.len() < header_end + length {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[header_end..]).to_string();
    Some(Captured {
        method,
        path,
        headers,
        body,
    })
}

/// A client for tests: no system proxy, short timeouts.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}
