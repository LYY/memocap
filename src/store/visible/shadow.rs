use std::collections::HashMap;

use anyhow::Result;
use rusqlite::Connection;

use crate::scope::PlacementId;

use super::{query, ShadowCause, Visibility, VisibleSource};

pub(super) struct ShadowTopics {
    repository: HashMap<String, ShadowCause>,
    domains: HashMap<String, ShadowCause>,
}

pub(super) fn shadow_topics(
    connection: &Connection,
    sources: &[VisibleSource],
) -> Result<ShadowTopics> {
    let mut repository = HashMap::new();
    let mut domains = HashMap::new();
    for (source_order, source) in sources.iter().enumerate() {
        let cause = |topic_key: String| ShadowCause {
            source_order,
            placement: source.placement().to_string(),
            topic_key,
        };
        match source.placement() {
            PlacementId::Repository(_) => {
                for topic_key in query::source_topics(connection, source.placement())? {
                    repository
                        .entry(topic_key.clone())
                        .or_insert_with(|| cause(topic_key));
                }
            }
            PlacementId::Domain(_) => {
                for topic_key in query::source_topics(connection, source.placement())? {
                    domains
                        .entry(topic_key.clone())
                        .or_insert_with(|| cause(topic_key));
                }
            }
            PlacementId::Universal => {}
        }
    }
    Ok(ShadowTopics {
        repository,
        domains,
    })
}

pub(super) fn visibility_for(
    source: &VisibleSource,
    topic_key: &str,
    topics: &ShadowTopics,
) -> Visibility {
    if topic_key.is_empty() {
        return Visibility::Visible;
    }
    match source.placement() {
        PlacementId::Repository(_) => Visibility::Visible,
        PlacementId::Domain(_) => topics
            .repository
            .get(topic_key)
            .cloned()
            .map_or(Visibility::Visible, Visibility::Shadowed),
        PlacementId::Universal => topics
            .repository
            .get(topic_key)
            .or_else(|| topics.domains.get(topic_key))
            .cloned()
            .map_or(Visibility::Visible, Visibility::Shadowed),
    }
}
