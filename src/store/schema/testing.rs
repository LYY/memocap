use super::*;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};

#[test]
fn upgrade_ddl_and_metadata_roll_back_together_on_authorizer_failure() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(include_str!("../../../tests/fixtures/schema-2.0.sql"))
        .unwrap();
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
        SchemaVersion { major: 2, minor: 0 }
    );
    assert!(validate(&connection).is_ok());
    assert!(connection
        .prepare("SELECT organized_at FROM memories")
        .is_err());
}

#[test]
fn concurrent_creators_and_migrators_recheck_after_lock() {
    for initialized in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("contended.db");
        let anchor = Connection::open(&path).unwrap();
        anchor.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        if initialized {
            anchor
                .execute_batch(include_str!("../../../tests/fixtures/schema-2.0.sql"))
                .unwrap();
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
            SchemaVersion { major: 2, minor: 1 }
        );
    }
}

#[test]
fn interrupted_ddl_rolls_back_for_fresh_creation_and_upgrade() {
    for legacy in [false, true] {
        let mut connection = Connection::open_in_memory().unwrap();
        if legacy {
            connection
                .execute_batch(include_str!("../../../tests/fixtures/schema-2.0.sql"))
                .unwrap();
        }
        let before = structure::objects(&connection).unwrap();
        connection.authorizer(Some(|context: AuthContext<'_>| match context.action {
            AuthAction::CreateTable {
                table_name: "repository_metadata",
            } => Authorization::Deny,
            AuthAction::AlterTable {
                table_name: "memories",
                ..
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }));

        let failed = prepare(&mut connection);

        assert!(failed.is_err());
        assert_eq!(structure::objects(&connection).unwrap(), before);
    }
}
