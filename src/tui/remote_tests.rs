use super::{
    paging, remote_inventory_at,
    remote_test_support::{partial_remote_server, remote_server, REMOTE_TOKEN},
    tests::{repository, save},
    visible_inventory_at, InventoryPage,
};

#[test]
fn remote_inventory_reads_visible_stack_via_v1() {
    let directory = tempfile::tempdir().expect("temporary database directory should exist");
    let database = directory.path().join("remote.db");
    let repository = repository();
    let connection = crate::store::open(&database).expect("database should open");
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "remote universal fixture",
        "topic",
    );
    let (address, requests, server) = remote_server(database, 2);

    let memories = remote_inventory_at(&address, REMOTE_TOKEN, &repository)
        .expect("remote inventory should load");

    server.join().expect("remote server should stop");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path)
            .collect::<Vec<_>>(),
        vec!["/v1/status".to_owned(), "/v1/memories/list".to_owned()]
    );
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].memory.content, "remote universal fixture");
}

#[test]
fn remote_inventory_matches_complete_local_inventory_and_reaches_final_shadowed_record() {
    let directory = tempfile::tempdir().expect("temporary database directory should exist");
    let database = directory.path().join("remote.db");
    let repository = repository();
    let domain = "team/remote-tui".parse().expect("domain should parse");
    let mut connection = crate::store::open(&database).expect("database should open");
    crate::store::create_domain(&mut connection, &domain).expect("domain should register");
    crate::store::attach_domain(&mut connection, &repository, &domain, None)
        .expect("domain should attach");
    let repository_placement = crate::scope::PlacementId::Repository(repository.clone());
    for index in 0..101 {
        save(
            &connection,
            &repository_placement,
            &format!("repository record {index}"),
            "",
        );
    }
    save(
        &connection,
        &repository_placement,
        "repository shadow",
        "shared-topic",
    );
    save(
        &connection,
        &crate::scope::PlacementId::Domain(domain),
        "domain shadow",
        "shared-topic",
    );
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "universal final shadow",
        "shared-topic",
    );
    let local = visible_inventory_at(&database, &repository).expect("local inventory should load");
    let (address, requests, server) = remote_server(database, 2);

    let remote = remote_inventory_at(&address, REMOTE_TOKEN, &repository)
        .expect("remote inventory should load");

    server.join().expect("remote server should stop");
    let requests = requests.iter().collect::<Vec<_>>();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/v1/status", "/v1/memories/list"]
    );
    let status_body: serde_json::Value =
        serde_json::from_str(&requests[0].body).expect("remote status body should be JSON");
    assert_eq!(
        status_body["repository"].as_str(),
        Some(repository.as_str())
    );
    let list_body: serde_json::Value =
        serde_json::from_str(&requests[1].body).expect("remote list body should be JSON");
    assert_eq!(list_body["limit"].as_i64(), Some(104));
    assert_eq!(remote, local);

    let mut page = InventoryPage::new(remote);
    for _ in 0..local.len() {
        page.forward(paging::INVENTORY_PAGE_STEP);
    }
    assert_eq!(page.position(), local.len());
    let final_entry = crate::cli::format_memories(page.current());
    assert!(final_entry.contains("universal final shadow"));
    assert!(final_entry.contains("source_order: 2"));
    assert!(final_entry.contains("visibility: shadowed"));
    assert!(final_entry.contains("shadowed_by: source 0"));
}

#[test]
fn remote_inventory_rejects_partial_list_response_after_reading_status() {
    let repository = repository();
    let (address, requests, server) = partial_remote_server();

    let error = remote_inventory_at(&address, REMOTE_TOKEN, &repository)
        .expect_err("partial remote list response should fail");

    server.join().expect("partial remote server should stop");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path)
            .collect::<Vec<_>>(),
        vec!["/v1/status".to_owned(), "/v1/memories/list".to_owned()]
    );
    assert!(format!("{error:#}").contains("remote inventory response count does not match status"));
}

#[test]
fn remote_inventory_stops_after_status_error() {
    let directory = tempfile::tempdir().expect("temporary database directory should exist");
    let database = directory.path().join("remote.db");
    let repository = repository();
    let (address, requests, server) = remote_server(database, 1);

    remote_inventory_at(&address, "wrong-token", &repository)
        .expect_err("remote status error should fail inventory loading");

    server.join().expect("remote server should stop");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path)
            .collect::<Vec<_>>(),
        vec!["/v1/status".to_owned()]
    );
}

#[test]
fn remote_inventory_returns_error_when_remote_is_unavailable() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("temporary loopback listener should bind");
    let address = format!(
        "http://{}",
        listener.local_addr().expect("listener should have address")
    );
    drop(listener);

    let result = remote_inventory_at(&address, REMOTE_TOKEN, &repository());

    assert!(result.is_err());
}
