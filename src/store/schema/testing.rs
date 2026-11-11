use super::*;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};

fn prior(connection: &Connection) {
    connection
        .execute_batch(include_str!("../../../tests/fixtures/schema-2.2.sql"))
        .unwrap();
    connection.execute_batch("INSERT INTO activity_events VALUES(801,'opaque','recall','read',0,'original-time',' { \"unknown\": true } ');
        INSERT INTO memories(id,content,created_at,updated_at) VALUES(97,'preserve memory','before','before');").unwrap();
}

#[test]
fn upgrade_ddl_and_metadata_roll_back_together_on_authorizer_failure() {
    let mut connection = Connection::open_in_memory().unwrap();
    prior(&connection);
    let before = structure::objects(&connection).unwrap();
    connection.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Update {
            table_name: "schema_metadata",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }));

    let failed = prepare(&mut connection);

    assert!(failed.is_err());
    assert_eq!(
        version(&connection).unwrap(),
        SchemaVersion { major: 2, minor: 2 }
    );
    assert!(validate(&connection).is_ok());
    assert_eq!(structure::objects(&connection).unwrap(), before);
    assert_preserved_rows(&connection);
    assert!(connection.execute("INSERT INTO activity_events VALUES(1,'review','capture_review','read',0,'before','{}')", []).is_err());
}

fn assert_preserved_rows(connection: &Connection) {
    assert_eq!(
        connection
            .query_row(
                "SELECT sequence,recorded_at,event_json FROM activity_events",
                [],
                |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?
                ))
            )
            .unwrap(),
        (
            801,
            "original-time".into(),
            " { \"unknown\": true } ".into()
        )
    );
    assert_eq!(
        connection
            .query_row("SELECT id,content FROM memories", [], |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?
            )))
            .unwrap(),
        (97, "preserve memory".into())
    );
}

#[test]
fn rebuild_and_final_validation_failures_restore_schema_and_rows() {
    for stage in ["drop", "rename", "index", "final_validation"] {
        let mut connection = Connection::open_in_memory().unwrap();
        prior(&connection);
        let before = structure::objects(&connection).unwrap();
        let mut checks = 0;
        connection.authorizer(Some(move |context: AuthContext<'_>| {
            let denied = match context.action {
                AuthAction::DropTable {
                    table_name: "activity_events",
                } => stage == "drop",
                AuthAction::AlterTable {
                    table_name: "activity_events_v23",
                    ..
                } => stage == "rename",
                AuthAction::CreateIndex {
                    index_name: "activity_retention",
                    ..
                } => stage == "index",
                AuthAction::Pragma {
                    pragma_name: "quick_check",
                    ..
                } => {
                    checks += 1;
                    stage == "final_validation" && checks == 2
                }
                _ => false,
            };
            if denied {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }));

        assert!(prepare(&mut connection).is_err(), "{stage}");

        assert_eq!(
            version(&connection).unwrap(),
            SchemaVersion { major: 2, minor: 2 }
        );
        assert_eq!(structure::objects(&connection).unwrap(), before, "{stage}");
        assert_preserved_rows(&connection);
    }
}

#[test]
fn concurrent_creators_and_migrators_recheck_after_lock() {
    for initialized in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("contended.db");
        let anchor = Connection::open(&path).unwrap();
        anchor.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        if initialized {
            prior(&anchor);
        }
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let connections = (0..4)
            .map(|_| {
                let connection = Connection::open(&path).unwrap();
                connection.busy_timeout(Duration::from_secs(2)).unwrap();
                connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
                let mut barrier = Some(barrier.clone());
                connection.authorizer(Some(move |context: AuthContext<'_>| {
                    if let AuthAction::Transaction {
                        operation: TransactionOperation::Begin,
                    } = context.action
                    {
                        if let Some(barrier) = barrier.take() {
                            barrier.wait();
                        }
                    }
                    Authorization::Allow
                }));
                connection
            })
            .collect::<Vec<_>>();
        let results = std::thread::scope(|scope| {
            let handles = connections
                .into_iter()
                .map(|mut connection| scope.spawn(move || prepare(&mut connection)))
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    **result
                        == if initialized {
                            super::super::SchemaLifecycle::Upgraded
                        } else {
                            super::super::SchemaLifecycle::Created
                        }
                })
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == super::super::SchemaLifecycle::Opened)
                .count(),
            3
        );
        assert_eq!(
            version(&anchor).unwrap(),
            SchemaVersion { major: 2, minor: 3 }
        );
        if initialized {
            assert_preserved_rows(&anchor);
        }
    }
}

#[test]
fn interrupted_ddl_rolls_back_for_fresh_creation_and_upgrade() {
    for legacy in [false, true] {
        let mut connection = Connection::open_in_memory().unwrap();
        if legacy {
            prior(&connection);
        }
        let before = structure::objects(&connection).unwrap();
        connection.authorizer(Some(|context: AuthContext<'_>| match context.action {
            AuthAction::CreateTable {
                table_name: "activity_events" | "activity_events_v23",
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }));

        let failed = prepare(&mut connection);

        assert!(failed.is_err());
        assert_eq!(structure::objects(&connection).unwrap(), before);
    }
}
