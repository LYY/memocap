use std::io::Read as IoRead;
use std::path::Path;

use anyhow::Result;
use tiny_http::{Header, Method, Response, Server, StatusCode};

mod request;
mod routes;

#[derive(Debug)]
pub struct Incoming {
    pub method: String,
    pub path: String,
    pub token: Option<String>,
    pub body: String,
}

#[derive(Debug)]
pub struct Outgoing {
    pub status: u16,
    pub body: String,
}

#[must_use]
pub fn token_ok(expected: &str, provided: Option<&str>) -> bool {
    let Some(got) = provided else {
        return false;
    };
    if expected.is_empty() || got.len() != expected.len() {
        return false;
    }
    got.bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

pub fn handle(database: &Path, expected_token: &str, incoming: &Incoming) -> Outgoing {
    if !token_ok(expected_token, incoming.token.as_deref()) {
        return error(401, "unauthorized");
    }
    let request = match request::parse(incoming) {
        Ok(request) => request,
        Err(request::ParseError::NotFound) => return error(404, "not_found"),
        Err(request::ParseError::Invalid) => return error(400, "invalid_request"),
    };
    let mut connection = match crate::store::open(database) {
        Ok(connection) => connection,
        Err(_) => return error(500, "internal"),
    };
    routes::execute(&mut connection, request)
}

pub fn dispatch(
    method: &str,
    path: &str,
    authorized: bool,
    body: &str,
    database: &Path,
) -> (u16, String) {
    let incoming = Incoming {
        method: method.to_owned(),
        path: path.to_owned(),
        token: authorized.then(|| "secret".to_owned()),
        body: body.to_owned(),
    };
    let outgoing = handle(database, "secret", &incoming);
    (outgoing.status, outgoing.body)
}

pub fn serve(bind: &str, token: &str, database: &Path) -> Result<()> {
    if token.trim().is_empty() {
        anyhow::bail!("MEMOCAP_TOKEN is required to serve");
    }
    let server = Server::http(bind).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let json_header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .map_err(|_| anyhow::anyhow!("static JSON header is invalid"))?;
    for mut request in server.incoming_requests() {
        let incoming = Incoming {
            method: method_name(request.method()),
            path: request.url().to_owned(),
            token: extract_token(request.headers()),
            body: read_body(&mut request),
        };
        let outgoing = handle(database, token, &incoming);
        let response = Response::from_string(outgoing.body)
            .with_status_code(StatusCode(outgoing.status))
            .with_header(json_header.clone());
        request.respond(response).ok();
    }
    Ok(())
}

fn read_body(request: &mut tiny_http::Request) -> String {
    let mut body = String::new();
    IoRead::read_to_string(&mut request.as_reader(), &mut body).ok();
    body
}

fn extract_token(headers: &[Header]) -> Option<String> {
    headers
        .iter()
        .find(|header| {
            header
                .field
                .as_str()
                .as_str()
                .eq_ignore_ascii_case("authorization")
        })
        .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
}

fn method_name(method: &Method) -> String {
    match method {
        Method::Get => "GET".to_owned(),
        Method::Post => "POST".to_owned(),
        other => format!("{other}").to_ascii_uppercase(),
    }
}

pub(super) fn error(status: u16, code: &'static str) -> Outgoing {
    json(status, serde_json::json!({"error": code}))
}

pub(super) fn json(status: u16, body: impl serde::Serialize) -> Outgoing {
    let body =
        serde_json::to_string(&body).unwrap_or_else(|_| "{\"error\":\"internal\"}".to_owned());
    Outgoing { status, body }
}
