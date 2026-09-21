use memocap::scope::OperationId;

#[test]
fn derived_operation_id_is_stable_and_protocol_valid() {
    // Given
    let fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // When
    let initial = OperationId::from_request_fingerprint(fingerprint);
    let replay = OperationId::from_request_fingerprint(fingerprint);

    // Then
    assert_eq!(initial, replay);
    assert!(initial.as_str().parse::<OperationId>().is_ok());
}

#[test]
fn derived_operation_ids_differ_for_distinct_request_fingerprints() {
    // Given
    let first_fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let changed_fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdee";

    // When
    let first = OperationId::from_request_fingerprint(first_fingerprint);
    let changed = OperationId::from_request_fingerprint(changed_fingerprint);

    // Then
    assert_ne!(first, changed);
}

#[test]
fn derived_operation_id_is_identical_for_parallel_requests() {
    // Given
    let fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // When
    let operation_ids = std::thread::scope(|scope| {
        (0..8)
            .map(|_| scope.spawn(|| OperationId::from_request_fingerprint(fingerprint)))
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });

    // Then
    let first_operation_id = operation_ids.first().unwrap();
    assert!(operation_ids
        .iter()
        .all(|operation_id| operation_id == first_operation_id));
}
