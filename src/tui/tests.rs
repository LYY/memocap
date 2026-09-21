use super::*;
use ratatui::{backend::TestBackend, Terminal};
use std::{
    path::PathBuf,
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tiny_http::{Header, Response, Server, StatusCode};

const REMOTE_TOKEN: &str = "tui-remote-token";

fn remote_server(database: PathBuf) -> (String, Receiver<String>, JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let Some(mut request) = server.recv_timeout(Duration::from_millis(50)).unwrap() else {
                continue;
            };
            let token = request
                .headers()
                .iter()
                .find(|header| {
                    header
                        .field
                        .as_str()
                        .as_str()
                        .eq_ignore_ascii_case("authorization")
                })
                .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
                .map(ToOwned::to_owned);
            let mut body = String::new();
            std::io::Read::read_to_string(&mut request.as_reader(), &mut body).unwrap();
            let incoming = crate::server::Incoming {
                method: request.method().to_string().to_ascii_uppercase(),
                path: request.url().to_owned(),
                token,
                body,
            };
            let outgoing = crate::server::handle(&database, REMOTE_TOKEN, &incoming);
            request
                .respond(
                    Response::from_string(outgoing.body)
                        .with_status_code(StatusCode(outgoing.status))
                        .with_header(
                            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                                .unwrap(),
                        ),
                )
                .unwrap();
            sender.send(incoming.path).unwrap();
            return;
        }
    });
    (address, receiver, handle)
}

pub(super) fn repository() -> RepositoryId {
    "repository:0000000000000000000000000000000000000000000000000000000000000000"
        .parse()
        .expect("repository ID should parse")
}

pub(super) fn save(
    connection: &rusqlite::Connection,
    placement: &crate::scope::PlacementId,
    content: &str,
    topic: &str,
) {
    crate::store::remember_at(
        connection,
        placement,
        content,
        "context",
        "",
        crate::store::RememberOptions {
            topic_key: Some(topic),
            force: true,
            overwrite_id: None,
        },
    )
    .expect("fixture memory should save");
}

#[test]
fn menu_exposes_only_status_visible_list_and_exit() {
    assert_eq!(ACTIONS, ["Status", "List visible memories", "Exit"]);
}

#[test]
fn render_presents_opencode_as_the_supported_product() {
    let backend = TestBackend::new(100, 20);
    let mut terminal = Terminal::new(backend).expect("test terminal should initialize");

    terminal
        .draw(|frame| render(frame, &UiState::message(0, "status")))
        .expect("TUI should render");

    let screen = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect::<String>();
    assert!(screen.contains("local-first SQLite memory for OpenCode"));
    assert!(screen.contains("List visible memories"));
    assert!(!screen.contains("four hosts"));
    assert!(!screen.contains("Legacy compatibility"));
}

#[test]
fn status_panel_keeps_repository_id_visible_when_database_path_wraps() {
    let backend = TestBackend::new(80, 20);
    let mut terminal = Terminal::new(backend).expect("test terminal should initialize");
    let message = format!(
        "database: /tmp/{}\nrepository_id: repository:{}",
        "nested/".repeat(16),
        "0".repeat(64)
    );

    terminal
        .draw(|frame| render(frame, &UiState::message(0, &message)))
        .expect("TUI should render");

    let screen = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect::<String>();
    assert!(screen.contains("repository_id:"));
}

#[test]
fn status_panel_shows_visible_stack_totals_in_a_standard_terminal() {
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).expect("test terminal should initialize");
    let message = format!(
        concat!(
            "database: /tmp/{}/memocap.db\n",
            "repository_id: repository:{}\n",
            "schema: 1.0\n",
            "0 repository 3/3\n",
            "1 domain:team/beta 2/1\n",
            "2 domain:team/alpha 2/1\n",
            "3 universal 4/1\n",
            "total addressable/effective: 11/6"
        ),
        "nested/".repeat(12),
        "0".repeat(64)
    );

    terminal
        .draw(|frame| render(frame, &UiState::message(0, &message)))
        .expect("TUI should render");

    let screen = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect::<String>();
    assert!(screen.contains("total addressable/effective: 11/6"));
}

#[test]
fn compact_status_labels_sources_and_totals() {
    let status = crate::store::VisibleStackStatus {
        schema_version: "1.0".to_owned(),
        placements: vec![
            crate::store::PlacementCount {
                placement: "repository:fixture".to_owned(),
                source_order: 0,
                addressable_count: 3,
                effective_count: 3,
            },
            crate::store::PlacementCount {
                placement: "domain:team/beta".to_owned(),
                source_order: 1,
                addressable_count: 2,
                effective_count: 1,
            },
            crate::store::PlacementCount {
                placement: "universal".to_owned(),
                source_order: 2,
                addressable_count: 4,
                effective_count: 2,
            },
        ],
        addressable_total: 9,
        effective_total: 6,
    };

    assert_eq!(
        format_tui_status(&status),
        "schema: 1.0\n0 repository 3/3\n1 domain:team/beta 2/1\n2 universal 4/2\ntotal addressable/effective: 9/6"
    );
}

#[test]
fn visible_memories_action_renders_the_annotated_inventory() {
    // Given
    let directory = tempfile::tempdir().expect("temporary database directory should exist");
    let database = directory.path().join("memocap.db");
    let repository = repository();
    let domain = "engineering/rust".parse().expect("domain should parse");
    let mut connection = crate::store::open(&database).expect("database should open");
    crate::store::create_domain(&mut connection, &domain).expect("domain should register");
    crate::store::attach_domain(&mut connection, &repository, &domain, None)
        .expect("domain should attach");
    save(
        &connection,
        &crate::scope::PlacementId::Repository(repository.clone()),
        "repository fixture",
        "topic",
    );
    save(
        &connection,
        &crate::scope::PlacementId::Domain(domain),
        "domain fixture",
        "topic",
    );
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "universal fixture",
        "topic",
    );

    // When
    let memories = visible_inventory_at(&database, &repository).expect("inventory should load");
    let message = crate::cli::format_memories(&memories);

    // Then
    assert!(message.contains("repository fixture"));
    assert!(message.contains("domain fixture"));
    assert!(message.contains("universal fixture"));
    assert!(message.contains("source_order: 0"));
    assert!(message.contains("source_order: 1"));
    assert!(message.contains("source_order: 2"));
    assert!(message.contains("visibility: shadowed"));
    assert!(message.contains("shadowed_by: source 0"));
}

#[test]
fn remote_inventory_reads_visible_stack_via_v1() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("remote.db");
    let repository = repository();
    let connection = crate::store::open(&database).unwrap();
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "remote universal fixture",
        "topic",
    );
    let (address, requests, server) = remote_server(database);

    let memories = remote_inventory_at(&address, REMOTE_TOKEN, &repository).unwrap();

    server.join().unwrap();
    assert_eq!(
        requests.iter().collect::<Vec<_>>(),
        vec!["/v1/memories/list"]
    );
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].memory.content, "remote universal fixture");
}
