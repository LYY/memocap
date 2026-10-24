pub(super) const CORE: &str = "
CREATE TABLE schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    major INTEGER NOT NULL CHECK (major >= 1),
    minor INTEGER NOT NULL CHECK (minor >= 0)
);
INSERT INTO schema_metadata (singleton, major, minor) VALUES (1, 2, 0);
CREATE TABLE domains (
    domain_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE repository_domain_attachments (
    repository_id TEXT NOT NULL,
    domain_id TEXT NOT NULL REFERENCES domains(domain_id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (repository_id, domain_id),
    UNIQUE (repository_id, position)
);
CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'context',
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    topic_key TEXT NOT NULL DEFAULT '',
    placement_kind TEXT NOT NULL DEFAULT 'universal' CHECK (placement_kind IN ('repository', 'domain', 'universal')),
    repository_id TEXT,
    domain_id TEXT REFERENCES domains(domain_id) ON DELETE RESTRICT,
    CHECK (
        (placement_kind = 'repository' AND repository_id IS NOT NULL AND domain_id IS NULL)
        OR (placement_kind = 'domain' AND repository_id IS NULL AND domain_id IS NOT NULL)
        OR (placement_kind = 'universal' AND repository_id IS NULL AND domain_id IS NULL)
    )
);
CREATE TABLE memory_provenance (
    memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    source_memory_id INTEGER NOT NULL,
    source_placement_kind TEXT NOT NULL CHECK (source_placement_kind IN ('repository', 'domain', 'universal')),
    source_repository_id TEXT,
    source_domain_id TEXT,
    action TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    applicability_note TEXT,
    CHECK (
        (source_placement_kind = 'repository' AND source_repository_id IS NOT NULL AND source_domain_id IS NULL)
        OR (source_placement_kind = 'domain' AND source_repository_id IS NULL AND source_domain_id IS NOT NULL)
        OR (source_placement_kind = 'universal' AND source_repository_id IS NULL AND source_domain_id IS NULL)
    )
);
CREATE TABLE operation_ledger (
    operation_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    mutation TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, tags, content='memories', content_rowid='id'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
";

pub(super) const ACTIVITY: &str = "
CREATE TABLE activity_events (
    sequence INTEGER PRIMARY KEY,
    operation_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('write','recall','injection_prepared','injection_observed')),
    category TEXT NOT NULL CHECK(category IN ('write','read')),
    started_at_ms INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    event_json TEXT NOT NULL,
    UNIQUE(operation_id,phase)
);
CREATE INDEX activity_retention ON activity_events(category,started_at_ms DESC,sequence DESC);
CREATE TABLE repository_metadata (
    repository_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT,
    canonical_path TEXT,
    identity_source TEXT,
    last_seen TEXT NOT NULL,
    last_seen_ms INTEGER NOT NULL
);";
