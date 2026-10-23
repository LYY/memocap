use crate::{activity::RepositoryHint, scope::PlacementId, store};
use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlacementInventory {
    pub placement: String,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_hint: Option<RepositoryHint>,
}

pub fn placements(connection: &Connection) -> Result<Vec<PlacementInventory>> {
    let mut statement = connection.prepare(
        "SELECT placement, count FROM (
         SELECT 'repository:' || substr(repository_id,12) AS placement, count(*) AS count
           FROM memories WHERE placement_kind='repository' GROUP BY repository_id
         UNION SELECT repository_id, 0 FROM repository_domain_attachments
           WHERE repository_id NOT IN (SELECT repository_id FROM memories WHERE placement_kind='repository')
         UNION SELECT 'domain:' || d.domain_id, count(m.id) FROM domains d
           LEFT JOIN memories m ON m.domain_id=d.domain_id AND m.placement_kind='domain' GROUP BY d.domain_id
         UNION SELECT 'universal', count(*) FROM memories WHERE placement_kind='universal') ORDER BY placement")?;
    let rows = statement.query_map([], |row| {
        Ok(PlacementInventory {
            placement: row.get(0)?,
            count: row.get(1)?,
            repository_hint: None,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn exact(
    connection: &Connection,
    placement: &PlacementId,
) -> Result<Vec<store::InventoryMemory>> {
    if let PlacementId::Domain(domain) = placement {
        anyhow::ensure!(
            store::domains(connection)?.contains(domain),
            "domain {domain} does not exist"
        );
    }
    store::visible_inventory(
        connection,
        &[store::single_visible_source(placement.clone())],
    )
}
