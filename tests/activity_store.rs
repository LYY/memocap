use memocap::activity::*;
use memocap::scope::{OperationId, RepositoryId};
use rusqlite::Connection;

#[path = "../src/activity/testing/lifecycle.rs"]
mod lifecycle;
#[path = "../src/activity/testing/retention.rs"]
mod retention;

fn repository(seed: char) -> RepositoryId {
    format!("repository:{}", seed.to_string().repeat(64))
        .parse()
        .unwrap()
}

fn event(seed: &str) -> ActivityEvent {
    ActivityEvent {
        operation_id: OperationId::from_request_fingerprint(seed),
        related_operation_id: None,
        started_at: chrono::Utc::now().to_rfc3339(),
        elapsed_ms: 12,
        context: ActivityContext {
            repository_ids: vec![repository('a')],
            session_id: Some("session-a".into()),
            message_id: Some("message-a".into()),
            ..ActivityContext::default()
        },
        detail: ActivityDetail::Write(WriteActivity {
            action: WriteAction::Remember,
            status: WriteStatus::Inserted,
            memory_ids: vec![7],
            placements: vec!["universal".parse().unwrap()],
        }),
        receipt: None,
    }
}

#[test]
fn missing_auxiliary_initializes_without_creating_core() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("memocap.db");

    let activity = ActivityStore::open(&core).unwrap();

    assert_eq!(
        activity.path(),
        directory.path().join("memocap.db.activity.sqlite")
    );
    assert!(activity_path(&core).is_file());
    assert!(!core.exists());
    assert!(activity.list(&ActivityQuery::default()).unwrap().is_empty());
}

#[test]
fn metadata_retry_is_idempotent_across_reopen_and_conflict_is_visible() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let original = event("retry");
    ActivityStore::open(&core)
        .unwrap()
        .record(&original)
        .unwrap();

    let mut reopened = ActivityStore::open(&core).unwrap();
    assert_eq!(
        reopened.record(&original).unwrap(),
        RecordOutcome::Duplicate
    );
    let mut conflicting = original.clone();
    conflicting.context.actor = "other".into();
    assert!(matches!(
        reopened.record(&conflicting),
        Err(ActivityError::Conflict)
    ));

    assert_eq!(reopened.show(&original.operation_id).unwrap().len(), 1);
    assert_eq!(
        reopened.show(&original.operation_id).unwrap()[0].event,
        original
    );
}

#[test]
fn operation_show_preserves_recall_and_both_injection_stages() {
    let directory = tempfile::tempdir().unwrap();
    let mut activity = ActivityStore::open(&directory.path().join("db")).unwrap();
    let mut recalled = event("recall");
    recalled.detail = ActivityDetail::Recall(RecallActivity {
        status: RecallStatus::Ok,
        searched_placements: vec!["universal".parse().unwrap()],
        query_terms: vec!["sqlite".into(), "事务".into()],
        matched_ids: vec![7, 9],
        returned_ids: vec![7],
    });
    recalled.receipt = Some(ReceiptDetails {
        truncated: true,
        result_limit: Some(1),
        ..Default::default()
    });
    let injected = InjectionActivity {
        status: InjectionStatus::Ok,
        injected_ids: vec![7],
        cache_hit: false,
    };
    let mut prepared = recalled.clone();
    prepared.detail = ActivityDetail::InjectionPrepared(injected.clone());
    let mut observed = recalled.clone();
    observed.detail = ActivityDetail::InjectionObserved(injected);

    for stage in [&recalled, &prepared, &observed] {
        activity.record(stage).unwrap();
    }

    let stages = activity.show(&recalled.operation_id).unwrap();
    assert_eq!(
        stages.iter().map(|stage| &stage.event).collect::<Vec<_>>(),
        [&recalled, &prepared, &observed]
    );
    let serialized = serde_json::to_value(&stages).unwrap();
    assert_eq!(serialized[0]["detail"]["phase"], "recall");
    assert_eq!(serialized[2]["detail"]["phase"], "injection_observed");
    assert!(activity
        .list(&ActivityQuery {
            writes_only: true,
            ..Default::default()
        })
        .unwrap()
        .is_empty());
}

#[test]
fn list_filters_writes_by_repo_session_operation_and_pages_deterministically() {
    let directory = tempfile::tempdir().unwrap();
    let mut activity = ActivityStore::open(&directory.path().join("db")).unwrap();
    let first = event("first");
    let mut second = event("second");
    second.started_at = first.started_at.clone();
    second.context.repository_ids.push(repository('b'));
    second.context.session_id = Some("session-b".into());
    for entry in [&first, &second] {
        activity.record(entry).unwrap();
    }
    let target = repository('b');

    let by_repo = activity
        .list(&ActivityQuery {
            writes_only: true,
            repository: Some(&target),
            ..Default::default()
        })
        .unwrap();
    let by_session = activity
        .list(&ActivityQuery {
            session_id: Some("session-a"),
            ..Default::default()
        })
        .unwrap();
    let by_operation = activity
        .list(&ActivityQuery {
            operation_id: Some(&second.operation_id),
            ..Default::default()
        })
        .unwrap();
    let page = activity
        .list(&ActivityQuery {
            limit: 1,
            offset: 1,
            ..Default::default()
        })
        .unwrap();

    assert_eq!(by_repo[0].event, second);
    assert_eq!(by_session[0].event, first);
    assert_eq!(by_operation.len(), 1);
    assert_eq!(page[0].event, first);
    assert!(activity
        .list(&ActivityQuery {
            repository: Some(&target),
            session_id: Some("session-a"),
            ..Default::default()
        })
        .unwrap()
        .is_empty());
}

#[test]
fn repository_hints_remain_optional_and_reject_stale_observations() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let mut activity = ActivityStore::open(&core).unwrap();
    let hint = RepositoryHint {
        repository_id: repository('a'),
        display_name: Some("new name".into()),
        canonical_path: Some(directory.path().join("historical/path")),
        identity_source: Some("git-common-dir".into()),
        last_seen: "2026-10-23T12:00:00Z".into(),
    };
    assert_eq!(activity.repository_hint(&hint.repository_id).unwrap(), None);
    activity.update_repository_hint(&hint).unwrap();
    let mut stale = hint.clone();
    stale.last_seen = "2026-10-22T12:00:00Z".into();
    stale.display_name = Some("stale name".into());

    activity.update_repository_hint(&stale).unwrap();

    assert_eq!(
        ActivityStore::open(&core)
            .unwrap()
            .repository_hint(&hint.repository_id)
            .unwrap(),
        Some(hint)
    );
    assert_eq!(activity.repository_hint(&repository('b')).unwrap(), None);
}

#[test]
fn newer_partial_hint_keeps_known_display_fields() {
    let directory = tempfile::tempdir().unwrap();
    let mut activity = ActivityStore::open(&directory.path().join("db")).unwrap();
    let mut hint = RepositoryHint {
        repository_id: repository('a'),
        display_name: Some("known".into()),
        canonical_path: None,
        identity_source: None,
        last_seen: "2026-10-22T12:00:00Z".into(),
    };
    activity.update_repository_hint(&hint).unwrap();
    let mut partial = hint.clone();
    partial.display_name = None;
    partial.last_seen = "2026-10-23T12:00:00Z".into();

    activity.update_repository_hint(&partial).unwrap();

    hint.last_seen = partial.last_seen;
    assert_eq!(
        activity.repository_hint(&hint.repository_id).unwrap(),
        Some(hint)
    );
}

#[test]
fn invalid_external_metadata_cannot_enter_the_event_store() {
    let directory = tempfile::tempdir().unwrap();
    let mut activity = ActivityStore::open(&directory.path().join("db")).unwrap();
    let mut invalid = event("invalid");
    invalid.started_at = "not-a-time".into();

    assert!(matches!(
        activity.record(&invalid),
        Err(ActivityError::InvalidInput(_))
    ));

    assert!(activity.show(&invalid.operation_id).unwrap().is_empty());
    let payload = serde_json::json!({"status":"ok","searched_placements":[],"query_terms":[],"matched_ids":[],"returned_ids":[],"memory_content":"forbidden copy"});
    assert!(serde_json::from_value::<RecallActivity>(payload).is_err());
}
