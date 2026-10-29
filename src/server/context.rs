use super::Outgoing;
use crate::{receipt::Target, repository, scope::RepositoryId};

pub(super) fn attach(
    connection: &rusqlite::Connection,
    repository: &RepositoryId,
    mut outgoing: Outgoing,
) -> Outgoing {
    if outgoing.status != 200 {
        return outgoing;
    }
    let Ok(mut body) = serde_json::from_str::<serde_json::Value>(&outgoing.body) else {
        return outgoing;
    };
    let context = match repository::context(connection, repository) {
        Ok(context) => context,
        Err(error) => {
            body["warning"] = serde_json::json!(format!("repository context unavailable: {error}"));
            repository::Context::default()
        }
    };
    body["repository_context"] = serde_json::json!({ repository.as_str(): context });
    outgoing.body = body.to_string();
    outgoing
}

pub(super) fn observe(
    connection: &rusqlite::Connection,
    target: Option<&Target>,
    mut outgoing: Outgoing,
) -> Outgoing {
    if let Some(target) = target {
        if let Err(error) =
            repository::observe(connection, target, repository::Origin::ClientReported)
        {
            if let Ok(mut body) = serde_json::from_str::<serde_json::Value>(&outgoing.body) {
                body["warning"] = serde_json::json!(format!(
                    "core committed; repository location unavailable: {error}"
                ));
                outgoing.body = body.to_string();
            }
        }
    }
    outgoing
}
