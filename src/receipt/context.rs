use crate::{repository, scope::RepositoryId};
use anyhow::Result;
use std::{collections::HashSet, path::Path};

impl super::Receipt {
    pub fn load_repository_context(&mut self, database: &Path) {
        let mut ids = self
            .targets
            .iter()
            .map(|target| target.repository_id.clone())
            .collect::<HashSet<_>>();
        let mut add = |value: &str| {
            if let Ok(repository) = value.parse::<RepositoryId>() {
                ids.insert(repository);
            }
        };
        for result in &self.results {
            add(&result.memory.placement);
        }
        for placement in &self.searched_placements {
            add(placement);
        }
        if let Some(inventory) = &self.inventory {
            for entry in inventory {
                add(&entry.placement);
            }
        }
        if let Some(events) = &self.events {
            for event in events {
                for repository in &event.event.context.repository_ids {
                    add(repository.as_str());
                }
            }
        }
        if let Some(output) = &self.organization {
            match output {
                crate::organization::Output::Page(page) => {
                    for record in &page.records {
                        add(&record.placement.to_string());
                    }
                }
                crate::organization::Output::Read(read) => {
                    for record in &read.records {
                        add(&record.placement.to_string());
                    }
                }
                crate::organization::Output::Apply(applied) => {
                    for record in &applied.records {
                        add(&record.placement.to_string());
                    }
                    for key in &applied.deleted {
                        add(&key.placement.to_string());
                    }
                }
            }
        }
        for repository in &ids {
            self.repository_context
                .insert(repository.to_string(), repository::Context::default());
        }
        let load = || -> Result<repository::Contexts> {
            if !database.try_exists()? {
                return Ok(repository::Contexts::new());
            }
            let connection = crate::readonly::open(database)?;
            if crate::store::schema::validate(&connection)?.needs_upgrade() {
                return Ok(repository::Contexts::new());
            }
            ids.iter()
                .map(|repository| {
                    Ok((
                        repository.to_string(),
                        repository::context(&connection, repository)?,
                    ))
                })
                .collect()
        };
        match load() {
            Ok(contexts) => self.repository_context.extend(contexts),
            Err(error) => self.warn(format!("repository context unavailable: {error}")),
        }
    }

    pub fn warn(&mut self, warning: String) {
        match &mut self.warning {
            Some(existing) => {
                existing.push_str("; ");
                existing.push_str(&warning);
            }
            None => self.warning = Some(warning),
        }
    }
}
