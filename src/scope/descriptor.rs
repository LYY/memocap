use super::*;
use crate::repository::{Descriptor, NameSource, Origin};

pub fn descriptor(directory: &Path) -> Result<Option<Descriptor>> {
    let (display_name, name_source, normalized_remote) = match git_common_dir(directory)? {
        Some(common) => match remote_identity(directory)? {
            Some(remote) => {
                let name = remote.split_once('/').map(|(_, path)| path.to_owned());
                (name, NameSource::Remote, Some(remote))
            }
            None => {
                let root = if common.file_name().is_some_and(|name| name == ".git") {
                    common.parent()
                } else {
                    Some(common.as_path())
                };
                (
                    root.and_then(|root| root.file_name())
                        .and_then(|name| name.to_str())
                        .map(str::to_owned),
                    NameSource::GitCommonDirectory,
                    None,
                )
            }
        },
        None => (
            directory
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned),
            NameSource::Directory,
            None,
        ),
    };
    Ok(display_name
        .filter(|name| !name.trim().is_empty())
        .map(|display_name| Descriptor {
            display_name,
            name_source,
            origin: Origin::Local,
            normalized_remote,
        }))
}
