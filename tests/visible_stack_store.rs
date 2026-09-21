use memocap::{
    scope::{DomainId, PlacementId, RepositoryId},
    store::{self, Visibility},
};

fn repository() -> RepositoryId {
    "repository:0000000000000000000000000000000000000000000000000000000000000000"
        .parse()
        .unwrap()
}

fn domain(value: &str) -> DomainId {
    value.parse().unwrap()
}

fn save(
    connection: &rusqlite::Connection,
    placement: &PlacementId,
    content: &str,
    topic: &str,
) -> i64 {
    store::remember_at(
        connection,
        placement,
        content,
        "context",
        "",
        store::RememberOptions {
            topic_key: Some(topic),
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap()
}

#[test]
fn visible_stack_orders_tiers_shadows_lower_topics_and_reports_counts() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let repository = repository();
    let first_domain = domain("engineering/rust");
    let second_domain = domain("engineering/sqlite");
    for domain in [&first_domain, &second_domain] {
        store::create_domain(&mut connection, domain).unwrap();
        store::attach_domain(&mut connection, &repository, domain, None).unwrap();
    }
    let repository_id = save(
        &connection,
        &PlacementId::Repository(repository.clone()),
        "alpha repository weak result",
        "RÜST STATUS",
    );
    let first_shadowed = save(
        &connection,
        &PlacementId::Domain(first_domain.clone()),
        "alpha first domain hidden result",
        "rüst status",
    );
    let first_visible = save(
        &connection,
        &PlacementId::Domain(first_domain.clone()),
        "alpha first domain collision result",
        "collision",
    );
    let second_visible = save(
        &connection,
        &PlacementId::Domain(second_domain.clone()),
        "alpha second domain collision result",
        "collision",
    );
    let universal_repository_shadowed = save(
        &connection,
        &PlacementId::Universal,
        "alpha universal repository topic result",
        "rüst status",
    );
    let universal_domain_shadowed = save(
        &connection,
        &PlacementId::Universal,
        "alpha universal domain topic result",
        "collision",
    );
    let universal_visible = save(
        &connection,
        &PlacementId::Universal,
        "alpha alpha alpha universal strong unkeyed result",
        "  ",
    );
    let sources = store::visible_sources(&connection, &repository).unwrap();

    // When
    let recalled = store::recall_visible(&connection, &sources, "alpha", 20, None, None).unwrap();
    let limited = store::recall_visible(&connection, &sources, "alpha", 1, None, Some(0)).unwrap();
    let inventory = store::list_inventory(&connection, &sources, 20).unwrap();
    let status = store::visible_status(&connection, &sources).unwrap();

    // Then
    assert_eq!(
        recalled
            .iter()
            .map(|entry| entry.memory.id)
            .collect::<Vec<_>>(),
        vec![
            repository_id,
            first_visible,
            second_visible,
            universal_visible
        ]
    );
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].memory.id, repository_id);
    assert!(matches!(
        inventory
            .iter()
            .find(|entry| entry.memory.id == first_shadowed)
            .unwrap()
            .visibility,
        Visibility::Shadowed(ref cause)
            if cause.source_order == 0 && cause.placement == repository.to_string()
    ));
    assert!(matches!(
        inventory
            .iter()
            .find(|entry| entry.memory.id == universal_repository_shadowed)
            .unwrap()
            .visibility,
        Visibility::Shadowed(ref cause)
            if cause.source_order == 0 && cause.placement == repository.to_string()
    ));
    assert!(matches!(
        inventory
            .iter()
            .find(|entry| entry.memory.id == universal_domain_shadowed)
            .unwrap()
            .visibility,
        Visibility::Shadowed(ref cause)
            if cause.source_order == 1 && cause.placement == "domain:engineering/rust"
    ));
    assert_eq!(status.schema_version, "1.0");
    assert_eq!(status.addressable_total, 7);
    assert_eq!(status.effective_total, 4);
    assert_eq!(
        status
            .placements
            .iter()
            .map(|count| (
                count.source_order,
                count.addressable_count,
                count.effective_count
            ))
            .collect::<Vec<_>>(),
        vec![(0, 1, 1), (1, 2, 1), (2, 1, 1), (3, 3, 1)]
    );
}

#[test]
fn deleting_more_specific_topics_restores_lower_visible_records() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let repository = repository();
    let domain = domain("engineering/rust");
    store::create_domain(&mut connection, &domain).unwrap();
    store::attach_domain(&mut connection, &repository, &domain, None).unwrap();
    let repository_id = save(
        &connection,
        &PlacementId::Repository(repository.clone()),
        "release repository result",
        "release",
    );
    let domain_id = save(
        &connection,
        &PlacementId::Domain(domain.clone()),
        "release domain result",
        "release",
    );
    let universal_id = save(
        &connection,
        &PlacementId::Universal,
        "release universal result",
        "release",
    );
    let sources = store::visible_sources(&connection, &repository).unwrap();

    // When
    let before = store::recall_visible(&connection, &sources, "release", 20, None, None).unwrap();
    store::forget_at(
        &connection,
        &PlacementId::Repository(repository.clone()),
        repository_id,
    )
    .unwrap();
    let after_repository_delete =
        store::recall_visible(&connection, &sources, "release", 20, None, None).unwrap();
    store::forget_at(&connection, &PlacementId::Domain(domain), domain_id).unwrap();
    let after_domain_delete =
        store::recall_visible(&connection, &sources, "release", 20, None, None).unwrap();

    // Then
    assert_eq!(before[0].memory.id, repository_id);
    assert_eq!(after_repository_delete[0].memory.id, domain_id);
    assert_eq!(after_domain_delete[0].memory.id, universal_id);
}

#[test]
fn recall_keeps_bm25_order_within_each_source_tier() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let repository = repository();
    let weak = save(
        &connection,
        &PlacementId::Repository(repository.clone()),
        "alpha weak repository result",
        "",
    );
    let strong = save(
        &connection,
        &PlacementId::Repository(repository.clone()),
        "alpha alpha alpha alpha alpha strong repository result",
        "",
    );
    let sources = store::visible_sources(&connection, &repository).unwrap();

    // When
    let recalled = store::recall_visible(&connection, &sources, "alpha", 20, None, None).unwrap();

    // Then
    assert_eq!(
        recalled
            .iter()
            .map(|entry| entry.memory.id)
            .collect::<Vec<_>>(),
        vec![strong, weak]
    );
    assert!(recalled.iter().all(|entry| entry.source_order == 0));
}
