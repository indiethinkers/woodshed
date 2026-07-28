use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const SECRETS_FILE: &str = "secrets.json";
const CURRENT_VERSION: u8 = 1;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SECRET_BYTES: usize = 64 * 1024;

static FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CredentialId(String);

impl CredentialId {
    pub fn gmail(email: &str) -> Self {
        Self(format!("gmail:{}", email.trim().to_ascii_lowercase()))
    }

    pub fn agent() -> Self {
        Self("agent:default".to_string())
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SecretsFile {
    version: u8,
    credentials: BTreeMap<String, String>,
}

impl Default for SecretsFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            credentials: BTreeMap::new(),
        }
    }
}

/// Prompt-free credential custody for integrations whose explicit storage
/// policy is the user's private app-data directory.
///
/// The interface intentionally does not expose paths or serialization. Callers
/// identify a credential, then resolve, save, or forget it. Filesystem
/// ownership and full-disk encryption provide at-rest protection; the file is
/// not presented as cryptographically encrypted storage.
pub struct CredentialBroker {
    root: PathBuf,
}

impl CredentialBroker {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("resolve app data directory: {e}"))?;
        Ok(Self::new(root))
    }

    pub fn resolve(&self, id: &CredentialId) -> Result<Option<String>, String> {
        let _guard = file_lock().lock().unwrap_or_else(|e| e.into_inner());
        let secrets = self.read_unlocked()?;
        Ok(secrets.credentials.get(&id.0).cloned())
    }

    pub fn save(&self, id: &CredentialId, secret: &str) -> Result<(), String> {
        if id.0.ends_with(':') {
            return Err("credential identifier is empty".to_string());
        }
        if secret.is_empty() {
            return Err("credential is empty".to_string());
        }
        if secret.len() > MAX_SECRET_BYTES {
            return Err(format!(
                "credential exceeds {} byte limit",
                MAX_SECRET_BYTES
            ));
        }

        let _guard = file_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mut secrets = self.read_unlocked()?;
        secrets.credentials.insert(id.0.clone(), secret.to_string());
        self.write_unlocked(&secrets)?;

        let stored = self.read_unlocked()?;
        if stored.credentials.get(&id.0).map(String::as_str) != Some(secret) {
            return Err("verify stored credential failed".to_string());
        }
        Ok(())
    }

    pub fn forget(&self, id: &CredentialId) -> Result<(), String> {
        let _guard = file_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mut secrets = self.read_unlocked()?;
        if secrets.credentials.remove(&id.0).is_some() {
            self.write_unlocked(&secrets)?;
        }
        Ok(())
    }

    fn path(&self) -> PathBuf {
        self.root.join(SECRETS_FILE)
    }

    fn read_unlocked(&self) -> Result<SecretsFile, String> {
        let path = self.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SecretsFile::default())
            }
            Err(error) => return Err(format!("inspect credential store: {error}")),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("credential store is not a regular file".to_string());
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(format!(
                "credential store exceeds {} byte limit",
                MAX_FILE_BYTES
            ));
        }

        set_owner_only(&path)?;

        let file = fs::File::open(&path).map_err(|e| format!("open credential store: {e}"))?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read credential store: {e}"))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(format!(
                "credential store exceeds {} byte limit",
                MAX_FILE_BYTES
            ));
        }
        let secrets: SecretsFile =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse credential store: {e}"))?;
        if secrets.version != CURRENT_VERSION {
            return Err(format!(
                "unsupported credential store version {}",
                secrets.version
            ));
        }
        Ok(secrets)
    }

    fn write_unlocked(&self, secrets: &SecretsFile) -> Result<(), String> {
        fs::create_dir_all(&self.root)
            .map_err(|e| format!("create credential store directory: {e}"))?;
        let bytes = serde_json::to_vec_pretty(secrets)
            .map_err(|e| format!("encode credential store: {e}"))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(format!(
                "credential store exceeds {} byte limit",
                MAX_FILE_BYTES
            ));
        }

        let temp_path = self
            .root
            .join(format!(".secrets-{}.tmp", ulid::Ulid::new()));
        let write_result = (|| -> Result<(), String> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temp_path)
                .map_err(|e| format!("create credential store temp file: {e}"))?;
            file.write_all(&bytes)
                .map_err(|e| format!("write credential store: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("sync credential store: {e}"))?;
            drop(file);
            fs::rename(&temp_path, self.path())
                .map_err(|e| format!("replace credential store: {e}"))?;
            set_owner_only(&self.path())?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        write_result
    }
}

fn file_lock() -> &'static Mutex<()> {
    FILE_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("secure credential store permissions: {e}"))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{CredentialBroker, CredentialId, MAX_FILE_BYTES};
    use std::fs;

    #[test]
    fn credentials_round_trip_without_entering_public_config() {
        let temp = tempfile::TempDir::new().unwrap();
        let broker = CredentialBroker::new(temp.path());
        let gmail = CredentialId::gmail("Owner@Example.com");
        let agent = CredentialId::agent();

        broker.save(&gmail, "gmail-secret").unwrap();
        broker.save(&agent, "agent-secret").unwrap();

        assert_eq!(
            broker.resolve(&gmail).unwrap().as_deref(),
            Some("gmail-secret")
        );
        assert_eq!(
            broker.resolve(&agent).unwrap().as_deref(),
            Some("agent-secret")
        );

        let raw = fs::read_to_string(temp.path().join("secrets.json")).unwrap();
        assert!(!raw.contains("Owner@Example.com"));
        assert!(raw.contains("owner@example.com"));
    }

    #[test]
    fn forgetting_one_credential_preserves_the_others() {
        let temp = tempfile::TempDir::new().unwrap();
        let broker = CredentialBroker::new(temp.path());
        let gmail = CredentialId::gmail("owner@example.com");
        let agent = CredentialId::agent();

        broker.save(&gmail, "gmail-secret").unwrap();
        broker.save(&agent, "agent-secret").unwrap();
        broker.forget(&gmail).unwrap();

        assert_eq!(broker.resolve(&gmail).unwrap(), None);
        assert_eq!(
            broker.resolve(&agent).unwrap().as_deref(),
            Some("agent-secret")
        );
    }

    #[cfg(unix)]
    #[test]
    fn credential_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::TempDir::new().unwrap();
        let broker = CredentialBroker::new(temp.path());
        broker
            .save(&CredentialId::gmail("owner@example.com"), "secret")
            .unwrap();

        let mode = fs::metadata(temp.path().join("secrets.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn credential_reads_repair_loose_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::TempDir::new().unwrap();
        let broker = CredentialBroker::new(temp.path());
        let path = temp.path().join("secrets.json");
        let id = CredentialId::gmail("owner@example.com");
        broker.save(&id, "secret").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        assert_eq!(broker.resolve(&id).unwrap().as_deref(), Some("secret"));
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn credential_store_refuses_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::TempDir::new().unwrap();
        let target = temp.path().join("target.json");
        fs::write(&target, r#"{"version":1,"credentials":{}}"#).unwrap();
        symlink(target, temp.path().join("secrets.json")).unwrap();

        let error = CredentialBroker::new(temp.path())
            .resolve(&CredentialId::agent())
            .unwrap_err();
        assert!(error.contains("not a regular file"));
    }

    #[test]
    fn credential_store_rejects_malformed_unsupported_and_oversized_files() {
        for (name, content, expected) in [
            (
                "malformed",
                b"not json".as_slice(),
                "parse credential store",
            ),
            (
                "unsupported",
                br#"{"version":2,"credentials":{}}"#.as_slice(),
                "unsupported credential store version",
            ),
        ] {
            let temp = tempfile::TempDir::new().unwrap();
            fs::write(temp.path().join("secrets.json"), content).unwrap();
            let error = CredentialBroker::new(temp.path())
                .resolve(&CredentialId::agent())
                .unwrap_err();
            assert!(error.contains(expected), "{name}: {error}");
        }

        let temp = tempfile::TempDir::new().unwrap();
        fs::write(
            temp.path().join("secrets.json"),
            vec![b' '; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let error = CredentialBroker::new(temp.path())
            .resolve(&CredentialId::agent())
            .unwrap_err();
        assert!(error.contains("exceeds"));
    }
}
