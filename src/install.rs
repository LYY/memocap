use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

use crate::{agents, agents_block, paths::Paths};

#[derive(Debug)]
pub struct InstallStatus {
    pub binary: PathBuf,
    pub database: PathBuf,
    pub agents_path: PathBuf,
    pub configured: bool,
}

#[must_use]
pub fn global_agents_path(paths: &Paths) -> PathBuf {
    paths.codex_home.join("AGENTS.md")
}

pub fn project_agents_path() -> Result<PathBuf> {
    Ok(env::current_dir()?.join("AGENTS.md"))
}

pub fn install(global: bool) -> Result<InstallStatus> {
    let paths = Paths::discover()?;
    let source = env::current_exe().context("无法定位当前 memocap 可执行文件")?;
    if source != paths.installed_binary {
        copy_binary(&source, &paths.installed_binary)?;
    }
    let agents_path = if global {
        global_agents_path(&paths)
    } else {
        project_agents_path()?
    };
    agents::apply(
        &agents_path,
        &agents_block(&display_binary(&paths.installed_binary)),
    )?;
    Ok(InstallStatus {
        configured: true,
        binary: paths.installed_binary,
        database: paths.database,
        agents_path,
    })
}

pub fn uninstall(global: bool) -> Result<bool> {
    let paths = Paths::discover()?;
    let agents_path = if global {
        global_agents_path(&paths)
    } else {
        project_agents_path()?
    };
    agents::remove(&agents_path)
}

pub fn status(global: bool) -> Result<InstallStatus> {
    let paths = Paths::discover()?;
    let agents_path = if global {
        global_agents_path(&paths)
    } else {
        project_agents_path()?
    };
    Ok(InstallStatus {
        configured: agents::contains_managed_block(&agents_path)?,
        binary: paths.installed_binary,
        database: paths.database,
        agents_path,
    })
}

fn copy_binary(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination.parent().context("安装路径没有父目录")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(".memocap-install.tmp");
    fs::copy(source, &temporary).with_context(|| format!("复制 {} 失败", source.display()))?;
    // Windows cannot rename over an existing .exe. Removing only our known
    // destination makes repeated install/update work on all supported systems.
    if destination.exists() {
        fs::remove_file(destination)
            .with_context(|| format!("替换旧程序失败：{}", destination.display()))?;
    }
    fs::rename(&temporary, destination)
        .with_context(|| format!("安装到 {} 失败", destination.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(destination)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(destination, permissions)?;
    }
    Ok(())
}

fn display_binary(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_config_is_under_codex_home() {
        let paths = Paths {
            home: PathBuf::from("/home/test"),
            codex_home: PathBuf::from("/home/test/.codex"),
            data_dir: PathBuf::from("/home/test/.memocap"),
            database: PathBuf::from("/home/test/.memocap/memocap.db"),
            installed_binary: PathBuf::from("/home/test/.codex/bin/memocap"),
        };
        assert_eq!(
            global_agents_path(&paths),
            PathBuf::from("/home/test/.codex/AGENTS.md")
        );
    }
}
