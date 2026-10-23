use memocap::{
    scope::{PlacementId, RepositoryId},
    store::{self, MatchMode, RecallOptions, RecallTarget},
};

fn repository(digit: char) -> RepositoryId {
    format!("repository:{}", digit.to_string().repeat(64))
        .parse()
        .unwrap()
}

fn save(connection: &rusqlite::Connection, placement: &PlacementId, content: (&str, &str)) -> i64 {
    store::remember_at(
        connection,
        placement,
        content.0,
        "note",
        "",
        store::RememberOptions {
            topic_key: Some(content.1),
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap()
}

fn options() -> RecallOptions<'static> {
    RecallOptions {
        query: "fruit",
        kind: None,
        match_mode: MatchMode::All,
        limit: 20,
        max_chars: None,
    }
}

#[test]
fn aggregate_preserves_applicability_after_shadowing_and_orders_by_target_before_source() {
    let directory = tempfile::tempdir().unwrap();
    let mut connection = store::open(&directory.path().join("memory.db")).unwrap();
    let a = repository('a');
    let b = repository('b');
    let domain = "shared/fruit".parse().unwrap();
    store::create_domain(&mut connection, &domain).unwrap();
    for repository in [&a, &b] {
        store::attach_domain(&mut connection, repository, &domain, None).unwrap();
    }
    let override_id = save(
        &connection,
        &PlacementId::Repository(a.clone()),
        ("fruit override", "policy"),
    );
    let domain_id = save(
        &connection,
        &PlacementId::Domain(domain),
        ("fruit domain", ""),
    );
    let universal_id = save(
        &connection,
        &PlacementId::Universal,
        ("fruit universal", "policy"),
    );
    let b_id = save(
        &connection,
        &PlacementId::Repository(b.clone()),
        ("fruit beta", ""),
    );
    let targets = [&a, &b]
        .into_iter()
        .map(|repository| RecallTarget {
            repository: repository.clone(),
            sources: store::visible_sources(&connection, repository).unwrap(),
        })
        .collect::<Vec<_>>();

    let recalled = store::recall_targets(&connection, &targets, options()).unwrap();

    assert_eq!(
        recalled
            .iter()
            .map(|entry| entry.memory.id)
            .collect::<Vec<_>>(),
        vec![override_id, domain_id, b_id, universal_id]
    );
    assert_eq!(
        recalled[1]
            .applicability
            .iter()
            .map(|target| (
                target.repository.as_str(),
                target.target_order,
                target.source_order
            ))
            .collect::<Vec<_>>(),
        vec![(a.as_str(), 0, 1), (b.as_str(), 1, 1)]
    );
    assert_eq!(
        recalled[3]
            .applicability
            .iter()
            .map(|target| target.repository.as_str())
            .collect::<Vec<_>>(),
        vec![b.as_str()]
    );
}

#[test]
fn final_budget_counts_shared_records_once_and_retains_later_applicability() {
    let directory = tempfile::tempdir().unwrap();
    let mut connection = store::open(&directory.path().join("memory.db")).unwrap();
    let a = repository('a');
    let b = repository('b');
    let domain = "shared/fruit".parse().unwrap();
    store::create_domain(&mut connection, &domain).unwrap();
    for repository in [&a, &b] {
        store::attach_domain(&mut connection, repository, &domain, None).unwrap();
    }
    let shared = save(&connection, &PlacementId::Domain(domain), ("fruit 中", ""));
    let beta = save(
        &connection,
        &PlacementId::Repository(b.clone()),
        ("fruit 文", ""),
    );
    let targets = [&a, &b]
        .into_iter()
        .map(|repository| RecallTarget {
            repository: repository.clone(),
            sources: store::visible_sources(&connection, repository).unwrap(),
        })
        .collect::<Vec<_>>();

    let recalled = store::recall_targets(
        &connection,
        &targets,
        RecallOptions {
            limit: 2,
            max_chars: Some(14),
            ..options()
        },
    )
    .unwrap();
    let limited = store::recall_targets(
        &connection,
        &targets,
        RecallOptions {
            limit: 1,
            max_chars: Some(0),
            ..options()
        },
    )
    .unwrap();
    let empty = store::recall_targets(
        &connection,
        &targets,
        RecallOptions {
            limit: 0,
            ..options()
        },
    )
    .unwrap();

    assert_eq!(
        recalled
            .iter()
            .map(|entry| entry.memory.id)
            .collect::<Vec<_>>(),
        vec![shared, beta]
    );
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].memory.id, shared);
    assert_eq!(limited[0].applicability.len(), 2);
    assert!(empty.is_empty());
}

#[test]
fn quoted_fts_terms_cannot_turn_user_text_into_boolean_operators() {
    let directory = tempfile::tempdir().unwrap();
    let connection = store::open(&directory.path().join("memory.db")).unwrap();
    let repository = repository('a');
    let placement = PlacementId::Repository(repository.clone());
    let apple = save(&connection, &placement, ("apple", ""));
    save(&connection, &placement, ("pear", ""));
    let sources = store::visible_sources(&connection, &repository).unwrap();

    let literal = store::recall_visible_with_options(
        &connection,
        &sources,
        RecallOptions {
            query: "apple OR pear",
            ..options()
        },
    )
    .unwrap();
    let any = store::recall_visible_with_options(
        &connection,
        &sources,
        RecallOptions {
            query: "\"apple\" missing",
            match_mode: MatchMode::Any,
            kind: Some("note"),
            ..options()
        },
    )
    .unwrap();
    let empty = store::recall_visible_with_options(
        &connection,
        &sources,
        RecallOptions {
            query: "\"\"   ",
            ..options()
        },
    )
    .unwrap();

    assert!(literal.is_empty());
    assert_eq!(
        any.iter().map(|entry| entry.memory.id).collect::<Vec<_>>(),
        vec![apple]
    );
    assert!(empty.is_empty());
}
