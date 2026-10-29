use super::*;

#[test]
fn remote_observation_preserves_client_platform_path_without_resolving_it() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let client_path = if cfg!(windows) {
        "/client/project"
    } else {
        "C:\\client\\project"
    };
    let mut input = request(remember(None), descriptor("foreign platform", None));
    input["targets"][0]["canonical_path"] = json!(client_path);
    // When
    let (status, body) = server::dispatch("POST", "/v1/receipt", true, &input.to_string(), &path);
    // Then
    assert_eq!(status, 200, "{body}");
    let receipt: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        receipt["repository_context"][REPO]["locations"][0]["canonical_path"],
        client_path
    );
}

#[test]
fn direct_remote_metadata_reads_include_only_the_selected_repository_context() {
    for (route, input) in [
        ("/v1/domains/list", json!({"repository":REPO,"all":true})),
        (
            "/v1/operations/status",
            json!({"repository":REPO,"operation_id":"00000000-0000-0000-0000-000000000799","request_fingerprint":"0".repeat(64)}),
        ),
    ] {
        // Given
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("core.db");
        execute(
            &path,
            &request(remember(None), descriptor("known context", None)),
        );
        // When
        let (status, body) = server::dispatch("POST", route, true, &input.to_string(), &path);
        // Then
        assert_eq!(status, 200, "{body}");
        let response: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            response["repository_context"][REPO]["identity"]["display_name"],
            "known context"
        );
        assert_eq!(response["repository_context"].as_object().unwrap().len(), 1);
    }
}

#[test]
fn mismatched_package_refuses_mutation_before_receipt_request() {
    // Given
    let listener = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.server_addr());
    let handle = std::thread::spawn(move || {
        let received = listener.recv().unwrap();
        let path = received.url().to_owned();
        let body = json!({"format_version":1,"package_version":"0.0.0","capabilities":memocap::inspection::CAPABILITIES});
        received
            .respond(tiny_http::Response::from_string(body.to_string()))
            .unwrap();
        path
    });
    let input = serde_json::from_value(request(remember(None), descriptor("never", None))).unwrap();
    // When
    let result = memocap::remote::execute_receipt(&address, "token", &input);
    // Then
    assert!(result.is_err());
    assert_eq!(handle.join().unwrap(), "/v1/capabilities");
}

#[test]
fn direct_remote_handler_commits_current_target_and_returns_context() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let input = json!({"repository":REPO,"placement":REPO,"content":"direct remote","type":"note","tags":"","force":true,"id":null,"topic_key":null,"target":request(remember(None),descriptor("direct known",None))["targets"][0]});
    // When
    let (status, body) = server::dispatch(
        "POST",
        "/v1/memories/remember",
        true,
        &input.to_string(),
        &path,
    );
    // Then
    assert_eq!(status, 200, "{body}");
    let response: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        response["repository_context"][REPO]["identity"]["display_name"],
        "direct known"
    );
    assert_eq!(
        response["repository_context"][REPO]["identity"]["origin"],
        "client_reported"
    );
    assert_eq!(
        response["repository_context"][REPO]["locations"][0]["source"],
        "client_reported"
    );
}
