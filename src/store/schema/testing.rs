use super::*;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

#[test]
fn bridge_ddl_and_metadata_roll_back_together_on_authorizer_failure() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(include_str!("../../../tests/fixtures/schema-1.0.sql"))
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
        SchemaVersion { major: 1, minor: 0 }
    );
    assert!(validation::exact_legacy(&connection).unwrap());
    assert!(connection.prepare("SELECT * FROM activity_events").is_err());
}

#[test]
fn concurrent_creators_and_migrators_recheck_after_lock() {
    for initialized in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("contended.db");
        if initialized {
            Connection::open(&path)
                .unwrap()
                .execute_batch(include_str!("../../../tests/fixtures/schema-1.0.sql"))
                .unwrap();
        }
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let results = std::thread::scope(|scope| {
            let handles = (0..4)
                .map(|_| {
                    let barrier = barrier.clone();
                    let path = &path;
                    scope.spawn(move || {
                        barrier.wait();
                        open(path, Duration::from_secs(2)).map(|(_, lifecycle)| lifecycle)
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            results
                .iter()
                .filter(|result| **result != super::super::SchemaLifecycle::Opened)
                .count(),
            1
        );
        assert_eq!(
            version(&Connection::open(path).unwrap()).unwrap(),
            SchemaVersion { major: 2, minor: 0 }
        );
    }
}

#[test]
fn interrupted_activity_ddl_rolls_back_for_fresh_creation_and_bridge() {
    for legacy in [false, true] {
        let mut connection = Connection::open_in_memory().unwrap();
        if legacy {
            connection
                .execute_batch(include_str!("../../../tests/fixtures/schema-1.0.sql"))
                .unwrap();
        }
        let before = structure::objects(&connection).unwrap();
        connection.authorizer(Some(|context: AuthContext<'_>| match context.action {
            AuthAction::CreateTable {
                table_name: "repository_metadata",
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }));

        let failed = prepare(&mut connection);

        assert!(failed.is_err());
        assert_eq!(structure::objects(&connection).unwrap(), before);
    }
}
