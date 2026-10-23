use std::{env, path::PathBuf};

use anyhow::{anyhow, Result};

#[derive(Clone, Debug)]
pub struct Paths {
    pub database: PathBuf,
}

impl Paths {
    pub fn discover() -> Result<Self> {
        if let Some(database) = env::var_os("MEMOCAP_DB").filter(|path| !path.is_empty()) {
            return Ok(Self {
                database: PathBuf::from(database),
            });
        }
        let home = env::var_os("MEMOCAP_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
            .ok_or_else(|| anyhow!("无法确定用户目录；请设置 MEMOCAP_HOME"))?;
        let data_dir = env::var_os("MEMOCAP_DATA_DIR")
            .filter(|value| !value.is_empty())
            .map_or_else(|| home.join(".memocap"), PathBuf::from);
        Ok(Self {
            database: data_dir.join("memocap.db"),
        })
    }
}
