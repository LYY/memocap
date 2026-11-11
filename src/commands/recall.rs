use anyhow::Result;
use memocap::{
    discovery::{Discovery, Origins},
    scope::{DomainId, PlacementId},
};

pub(super) fn discovery(
    mut placements: Vec<PlacementId>,
    domain: Option<DomainId>,
    universal: bool,
) -> Result<Discovery> {
    if let Some(domain) = domain {
        placements.push(PlacementId::Domain(domain));
    }
    if universal {
        placements.push(PlacementId::Universal);
    }
    if placements.is_empty() {
        Ok(Discovery::Library)
    } else {
        Ok(Discovery::Origins {
            placements: Origins::try_from(placements)?,
        })
    }
}
