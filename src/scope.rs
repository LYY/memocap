use std::{
    fmt,
    path::{Path, PathBuf},
    process::{Command, Output},
    str::FromStr,
};

use anyhow::{anyhow, bail, Result};
use sha2::{Digest, Sha256};
use url::Url;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

const REPOSITORY_PREFIX: &str = "repository:";
const REPOSITORY_HASH_DOMAIN: &[u8] = b"memocap\0repository\0v1\0";
const LEGACY_SCOPE_PREFIX: &str = "scope:v1:";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RepositoryId(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepositoryIdParseError;

impl fmt::Display for RepositoryIdParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid repository ID")
    }
}

impl std::error::Error for RepositoryIdParseError {}

impl RepositoryId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RepositoryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for RepositoryId {
    type Err = RepositoryIdParseError;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        let Some(hash) = value.strip_prefix(REPOSITORY_PREFIX) else {
            return Err(RepositoryIdParseError);
        };
        if hash.len() != 64 || !hash.bytes().all(is_lowercase_hex) {
            return Err(RepositoryIdParseError);
        }
        Ok(Self(value.to_owned()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DomainId(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DomainIdParseError;

impl fmt::Display for DomainIdParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid domain ID")
    }
}

impl std::error::Error for DomainIdParseError {}

impl DomainId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DomainId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for DomainId {
    type Err = DomainIdParseError;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        if value.is_empty()
            || matches!(value, "." | ".." | "global" | "universal" | "repository")
            || value.starts_with(REPOSITORY_PREFIX)
            || value.starts_with(LEGACY_SCOPE_PREFIX)
            || value.split('/').any(|segment| !is_domain_segment(segment))
        {
            return Err(DomainIdParseError);
        }
        Ok(Self(value.to_owned()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PlacementId {
    Repository(RepositoryId),
    Domain(DomainId),
    Universal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlacementIdParseError;

impl fmt::Display for PlacementIdParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid placement ID")
    }
}

impl std::error::Error for PlacementIdParseError {}

impl fmt::Display for PlacementId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Repository(repository) => repository.fmt(formatter),
            Self::Domain(domain) => write!(formatter, "domain:{domain}"),
            Self::Universal => formatter.write_str("universal"),
        }
    }
}

impl FromStr for PlacementId {
    type Err = PlacementIdParseError;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        if value == "universal" {
            return Ok(Self::Universal);
        }
        if let Ok(repository) = value.parse::<RepositoryId>() {
            return Ok(Self::Repository(repository));
        }
        let Some(domain) = value.strip_prefix("domain:") else {
            return Err(PlacementIdParseError);
        };
        domain
            .parse::<DomainId>()
            .map(Self::Domain)
            .map_err(|_| PlacementIdParseError)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OperationId(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperationIdParseError;

impl fmt::Display for OperationIdParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid operation ID")
    }
}

impl std::error::Error for OperationIdParseError {}

impl OperationId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn from_request_fingerprint(fingerprint: &str) -> Self {
        let digest = Sha256::digest(fingerprint);
        let first = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
        let second = u16::from_be_bytes([digest[4], digest[5]]);
        let third = u16::from_be_bytes([digest[6], digest[7]]);
        let fourth = u16::from_be_bytes([digest[8], digest[9]]);
        let fifth = u64::from_be_bytes([
            0, 0, digest[10], digest[11], digest[12], digest[13], digest[14], digest[15],
        ]);
        Self(format!(
            "{first:08x}-{second:04x}-{third:04x}-{fourth:04x}-{fifth:012x}"
        ))
    }
}

impl fmt::Display for OperationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for OperationId {
    type Err = OperationIdParseError;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        if !is_canonical_uuid(value) {
            return Err(OperationIdParseError);
        }
        Ok(Self(value.to_owned()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ScopeId(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeIdParseError;

impl fmt::Display for ScopeIdParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid opaque scope ID")
    }
}

impl std::error::Error for ScopeIdParseError {}

impl ScopeId {
    #[must_use]
    pub fn global() -> Self {
        Self("global".to_owned())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_global(&self) -> bool {
        self.0 == "global"
    }

    fn from_repository(repository: RepositoryId) -> Self {
        Self(repository.0)
    }
}

impl fmt::Display for ScopeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ScopeId {
    type Err = ScopeIdParseError;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        if value == "global" {
            return Ok(Self::global());
        }
        value
            .parse::<RepositoryId>()
            .map(Self::from_repository)
            .map_err(|_| ScopeIdParseError)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionSource {
    GitConfig,
    Remote,
    GitCommonDir,
    Directory,
}

impl ResolutionSource {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::GitConfig => "git-config",
            Self::Remote => "remote",
            Self::GitCommonDir => "git-common-dir",
            Self::Directory => "directory",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedScope {
    scope: ScopeId,
    repository: RepositoryId,
    source: ResolutionSource,
}

impl ResolvedScope {
    #[must_use]
    pub fn scope(&self) -> &ScopeId {
        &self.scope
    }

    #[must_use]
    pub fn repository(&self) -> &RepositoryId {
        &self.repository
    }

    #[must_use]
    pub const fn source(&self) -> ResolutionSource {
        self.source
    }
}

enum ConfigRepository {
    GitUnavailable,
    Unset,
    LegacyScope,
    Value(RepositoryId),
    ValueWithLegacyScope(RepositoryId),
}

pub fn resolve(cwd: &Path) -> Result<ResolvedScope> {
    let cwd = canonical_path(cwd)?;
    let Some(common_dir) = git_common_dir(&cwd)? else {
        return directory_scope(&cwd);
    };
    match read_config_repository(&cwd)? {
        ConfigRepository::GitUnavailable => directory_scope(&cwd),
        ConfigRepository::Unset => derive_scope(&cwd, &common_dir, false),
        ConfigRepository::LegacyScope => derive_scope(&cwd, &common_dir, true),
        ConfigRepository::Value(repository) => {
            Ok(resolved_repository(repository, ResolutionSource::GitConfig))
        }
        ConfigRepository::ValueWithLegacyScope(repository) => {
            remove_legacy_scope_config(&cwd)?;
            Ok(resolved_repository(repository, ResolutionSource::GitConfig))
        }
    }
}

fn derive_scope(cwd: &Path, common_dir: &Path, remove_legacy_scope: bool) -> Result<ResolvedScope> {
    let (repository, source) = match remote_identity(cwd)? {
        Some(identity) => (
            repository_from_identity("remote", &identity),
            ResolutionSource::Remote,
        ),
        None => (
            repository_from_path("git-common-dir", common_dir)?,
            ResolutionSource::GitCommonDir,
        ),
    };
    persist_repository(cwd, &repository)?;
    if remove_legacy_scope {
        remove_legacy_scope_config(cwd)?;
    }
    Ok(resolved_repository(repository, source))
}

fn directory_scope(cwd: &Path) -> Result<ResolvedScope> {
    Ok(resolved_repository(
        repository_from_path("directory", cwd)?,
        ResolutionSource::Directory,
    ))
}

fn resolved_repository(repository: RepositoryId, source: ResolutionSource) -> ResolvedScope {
    ResolvedScope {
        scope: ScopeId::from_repository(repository.clone()),
        repository,
        source,
    }
}

fn read_config_repository(cwd: &Path) -> Result<ConfigRepository> {
    let repository = match read_local_config(cwd, "memocap.repository-id")? {
        ConfigValue::GitUnavailable => return Ok(ConfigRepository::GitUnavailable),
        ConfigValue::Value(value) => Some(
            value
                .parse::<RepositoryId>()
                .map_err(|_| anyhow!("local repository ID configuration is invalid"))?,
        ),
        ConfigValue::Unset => None,
    };
    match read_local_config(cwd, "memocap.scope-id")? {
        ConfigValue::GitUnavailable => Ok(ConfigRepository::GitUnavailable),
        ConfigValue::Value(value) if is_legacy_scope_id(&value) => match repository {
            Some(repository) => Ok(ConfigRepository::ValueWithLegacyScope(repository)),
            None => Ok(ConfigRepository::LegacyScope),
        },
        ConfigValue::Unset | ConfigValue::Value(_) => match repository {
            Some(repository) => Ok(ConfigRepository::Value(repository)),
            None => Ok(ConfigRepository::Unset),
        },
    }
}

enum ConfigValue {
    GitUnavailable,
    Unset,
    Value(String),
}

fn read_local_config(cwd: &Path, key: &str) -> Result<ConfigValue> {
    let Some(output) = git(cwd, &["config", "--local", "--get", key])? else {
        return Ok(ConfigValue::GitUnavailable);
    };
    match output.status.code() {
        Some(0) => Ok(ConfigValue::Value(
            remove_terminal_newline(&output_text(output)?).to_owned(),
        )),
        Some(1) => Ok(ConfigValue::Unset),
        _ => bail!("local repository configuration could not be read"),
    }
}

fn persist_repository(cwd: &Path, repository: &RepositoryId) -> Result<()> {
    let Some(output) = git(
        cwd,
        &[
            "config",
            "--local",
            "memocap.repository-id",
            repository.as_str(),
        ],
    )?
    else {
        bail!("local repository ID configuration could not be written");
    };
    if !output.status.success() {
        bail!("local repository ID configuration could not be written");
    }
    match read_local_config(cwd, "memocap.repository-id")? {
        ConfigValue::Value(stored) if stored == repository.as_str() => Ok(()),
        ConfigValue::GitUnavailable | ConfigValue::Unset | ConfigValue::Value(_) => {
            bail!("local repository ID configuration read-back failed")
        }
    }
}

fn remove_legacy_scope_config(cwd: &Path) -> Result<()> {
    let Some(output) = git(
        cwd,
        &["config", "--local", "--unset-all", "memocap.scope-id"],
    )?
    else {
        bail!("local legacy scope configuration could not be removed");
    };
    if !output.status.success() {
        bail!("local legacy scope configuration could not be removed");
    }
    Ok(())
}

fn git_common_dir(cwd: &Path) -> Result<Option<PathBuf>> {
    let Some(output) = git(cwd, &["rev-parse", "--git-common-dir"])? else {
        return Ok(None);
    };
    if !output.status.success() {
        return Ok(None);
    }
    let output = output_text(output)?;
    let path = PathBuf::from(remove_terminal_newline(&output));
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    canonical_path(&path).map(Some)
}

fn remote_identity(cwd: &Path) -> Result<Option<String>> {
    let Some(output) = git(
        cwd,
        &["config", "--local", "--get-regexp", r"^remote\..*\.url$"],
    )?
    else {
        return Ok(None);
    };
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
        bail!("repository remotes could not be read");
    }
    let remotes = output_text(output)?;
    let mut values = remotes.lines().filter(|value| !value.is_empty());
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Ok(None);
    }
    let Some((_, remote)) = value.split_once(char::is_whitespace) else {
        return Ok(None);
    };
    Ok(canonicalize_remote(remote))
}

fn canonicalize_remote(remote: &str) -> Option<String> {
    canonicalize_url_remote(remote).or_else(|| canonicalize_scp_remote(remote))
}

fn canonicalize_url_remote(remote: &str) -> Option<String> {
    let url = Url::parse(remote).ok()?;
    let scheme = url.scheme();
    if !matches!(scheme, "http" | "https" | "ssh" | "git") {
        return None;
    }
    let port = match (scheme, url.port()) {
        ("http", Some(80)) | ("https", Some(443)) | ("ssh", Some(22)) | ("git", Some(9418)) => None,
        (_, port) => port,
    };
    canonicalize_remote_parts(url.host_str()?, url.path(), port)
}

fn canonicalize_scp_remote(remote: &str) -> Option<String> {
    if remote.contains("://") {
        return None;
    }
    let (host, path) = remote.split_once(':')?;
    let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
    if host.is_empty() || host.contains('/') || host.contains('\\') {
        return None;
    }
    canonicalize_remote_parts(host, path, None)
}

fn canonicalize_remote_parts(host: &str, path: &str, port: Option<u16>) -> Option<String> {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if path.is_empty()
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let host = match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    Some(format!("{host}/{path}"))
}

#[cfg(unix)]
fn repository_from_path(kind: &str, path: &Path) -> Result<RepositoryId> {
    Ok(repository_from_bytes(kind, path.as_os_str().as_bytes()))
}

#[cfg(not(unix))]
fn repository_from_path(kind: &str, path: &Path) -> Result<RepositoryId> {
    let identity = path
        .to_str()
        .ok_or_else(|| anyhow!("repository path is not valid UTF-8"))?;
    Ok(repository_from_identity(kind, identity))
}

fn repository_from_identity(kind: &str, identity: &str) -> RepositoryId {
    repository_from_bytes(kind, identity.as_bytes())
}

fn repository_from_bytes(kind: &str, identity: &[u8]) -> RepositoryId {
    let mut digest = Sha256::new();
    digest.update(REPOSITORY_HASH_DOMAIN);
    digest.update(kind);
    digest.update(b"\0");
    digest.update(identity);
    RepositoryId(format!("{REPOSITORY_PREFIX}{:x}", digest.finalize()))
}

fn git(cwd: &Path, arguments: &[&str]) -> Result<Option<Output>> {
    match Command::new("git")
        .args(arguments)
        .current_dir(cwd)
        .output()
    {
        Ok(output) => Ok(Some(output)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!("git command could not be executed"),
    }
}

fn canonical_path(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .map_err(|_| anyhow!("scope directory could not be canonicalized"))
}

fn output_text(output: Output) -> Result<String> {
    String::from_utf8(output.stdout).map_err(|_| anyhow!("git output is not valid UTF-8"))
}

fn remove_terminal_newline(value: &str) -> &str {
    match value.strip_suffix("\r\n") {
        Some(value) => value,
        None => match value.strip_suffix('\n') {
            Some(value) => value,
            None => value,
        },
    }
}

const fn is_lowercase_hex(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'a'..=b'f')
}

fn is_domain_segment(segment: &str) -> bool {
    let mut bytes = segment.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    is_lowercase_alphanumeric(first)
        && bytes.all(|byte| is_lowercase_alphanumeric(byte) || matches!(byte, b'.' | b'_' | b'-'))
}

const fn is_lowercase_alphanumeric(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'a'..=b'z')
}

fn is_legacy_scope_id(value: &str) -> bool {
    value
        .strip_prefix(LEGACY_SCOPE_PREFIX)
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(is_lowercase_hex))
}

fn is_canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23) && byte == b'-'
                || !matches!(index, 8 | 13 | 18 | 23) && is_lowercase_hex(byte)
        })
}

#[cfg(all(test, unix))]
mod tests {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt, path::Path};

    use super::repository_from_path;

    #[test]
    fn distinguishes_non_utf8_paths_with_same_lossy_form() {
        // Given
        let left = Path::new(OsStr::from_bytes(b"same-\x80"));
        let right = Path::new(OsStr::from_bytes(b"same-\x81"));
        assert_ne!(left, right);
        assert_eq!(left.to_string_lossy(), right.to_string_lossy());

        // When
        let left_scope = repository_from_path("directory", left).unwrap();
        let right_scope = repository_from_path("directory", right).unwrap();

        // Then
        assert_ne!(left_scope, right_scope);
    }
}
