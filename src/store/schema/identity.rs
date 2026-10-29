pub(super) const SQL: &str = "
CREATE TABLE repository_identities (
    repository_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    name_source TEXT NOT NULL,
    origin TEXT NOT NULL,
    normalized_remote TEXT,
    recorded_at TEXT NOT NULL
);
CREATE TABLE repository_locations (
    repository_id TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (repository_id, canonical_path)
);
";
