use std::{
    fmt,
    path::{Path, PathBuf},
    process::{Command, Output},
    str::FromStr,
};

use anyhow::{anyhow, bail, Result};
use sha2::{Digest, Sha256};
use url::Url;

const SCOPE_PREFIX: &str = "scope:v1:";
const HASH_DOMAIN: &[u8] = b"memocap\0scope\0v1\0";

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
        let Some(hash) = value.strip_prefix(SCOPE_PREFIX) else {
            return Err(ScopeIdParseError);
        };
        if hash.len() != 64 || !hash.bytes().all(is_lowercase_hex) {
            return Err(ScopeIdParseError);
        }
        Ok(Self(value.to_owned()))
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
    source: ResolutionSource,
}

impl ResolvedScope {
    #[must_use]
    pub fn scope(&self) -> &ScopeId {
        &self.scope
    }

    #[must_use]
    pub const fn source(&self) -> ResolutionSource {
        self.source
    }
}

enum ConfigScope {
    GitUnavailable,
    Unset,
    Value(ScopeId),
}

pub fn resolve(cwd: &Path) -> Result<ResolvedScope> {
    let cwd = canonical_path(cwd)?;
    let Some(common_dir) = git_common_dir(&cwd)? else {
        return directory_scope(&cwd);
    };
    match read_config_scope(&cwd)? {
        ConfigScope::GitUnavailable => directory_scope(&cwd),
        ConfigScope::Unset => derive_scope(&cwd, &common_dir),
        ConfigScope::Value(scope) => Ok(ResolvedScope {
            scope,
            source: ResolutionSource::GitConfig,
        }),
    }
}

fn derive_scope(cwd: &Path, common_dir: &Path) -> Result<ResolvedScope> {
    let (scope, source) = match remote_identity(cwd)? {
        Some(identity) => (
            scope_from_identity("remote", &identity),
            ResolutionSource::Remote,
        ),
        None => (
            scope_from_path("git-common-dir", common_dir),
            ResolutionSource::GitCommonDir,
        ),
    };
    persist_scope(cwd, &scope)?;
    Ok(ResolvedScope { scope, source })
}

fn directory_scope(cwd: &Path) -> Result<ResolvedScope> {
    Ok(ResolvedScope {
        scope: scope_from_path("directory", cwd),
        source: ResolutionSource::Directory,
    })
}

fn read_config_scope(cwd: &Path) -> Result<ConfigScope> {
    let Some(output) = git(cwd, &["config", "--local", "--get", "memocap.scope-id"])? else {
        return Ok(ConfigScope::GitUnavailable);
    };
    match output.status.code() {
        Some(0) => {
            let scope = ScopeId::from_str(remove_terminal_newline(&output_text(output)?))
                .map_err(|_| anyhow!("local repository scope configuration is invalid"))?;
            if scope.is_global() {
                bail!("local repository scope configuration is invalid");
            }
            Ok(ConfigScope::Value(scope))
        }
        Some(1) => Ok(ConfigScope::Unset),
        _ => bail!("local repository scope configuration could not be read"),
    }
}

fn persist_scope(cwd: &Path, scope: &ScopeId) -> Result<()> {
    let Some(output) = git(
        cwd,
        &["config", "--local", "memocap.scope-id", scope.as_str()],
    )?
    else {
        bail!("local repository scope configuration could not be written");
    };
    if !output.status.success() {
        bail!("local repository scope configuration could not be written");
    }
    match read_config_scope(cwd)? {
        ConfigScope::Value(stored) if stored.as_str() == scope.as_str() => Ok(()),
        ConfigScope::GitUnavailable | ConfigScope::Unset | ConfigScope::Value(_) => {
            bail!("local repository scope configuration read-back failed")
        }
    }
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

fn scope_from_path(kind: &str, path: &Path) -> ScopeId {
    scope_from_identity(kind, &path.to_string_lossy())
}

fn scope_from_identity(kind: &str, identity: &str) -> ScopeId {
    let mut digest = Sha256::new();
    digest.update(HASH_DOMAIN);
    digest.update(kind);
    digest.update(b"\0");
    digest.update(identity.as_bytes());
    ScopeId(format!("{SCOPE_PREFIX}{:x}", digest.finalize()))
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
