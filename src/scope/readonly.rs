use super::*;

pub fn resolve_readonly(path: &Path) -> Result<ResolvedScope> {
    let directory = canonical_path(path)?;
    if !directory.is_dir() {
        bail!("scope target must be a directory");
    }
    let Some(common_dir) = git_common_dir(&directory)? else {
        return directory_scope(&directory);
    };
    match read_config_repository(&directory)? {
        ConfigRepository::GitUnavailable => directory_scope(&directory),
        ConfigRepository::Value(repository)
        | ConfigRepository::ValueWithLegacyScope(repository) => {
            Ok(resolved_repository(repository, ResolutionSource::GitConfig))
        }
        ConfigRepository::Unset | ConfigRepository::LegacyScope => {
            let (repository, source) = derived_repository(&directory, &common_dir)?;
            Ok(resolved_repository(repository, source))
        }
    }
}

pub(super) fn derived_repository(
    directory: &Path,
    common_dir: &Path,
) -> Result<(RepositoryId, ResolutionSource)> {
    match remote_identity(directory)? {
        Some(identity) => Ok((
            repository_from_identity("remote", &identity),
            ResolutionSource::Remote,
        )),
        None => Ok((
            repository_from_path("git-common-dir", common_dir)?,
            ResolutionSource::GitCommonDir,
        )),
    }
}
