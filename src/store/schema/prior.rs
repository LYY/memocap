pub(super) const EVENTS: &str = "
CREATE TABLE activity_events (
    sequence INTEGER PRIMARY KEY,
    operation_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('write','recall','injection_prepared','injection_observed')),
    category TEXT NOT NULL CHECK(category IN ('write','read')),
    started_at_ms INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    event_json TEXT NOT NULL,
    UNIQUE(operation_id,phase)
);";
