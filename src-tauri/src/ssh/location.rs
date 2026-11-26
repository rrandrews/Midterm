//! Uniform addressing for local paths and remote SSH paths.
//!
//! Local paths stay plain absolute strings (`/Users/me/project`), keeping full
//! compatibility with existing layouts, plugins, and tests. Remote paths use a
//! canonical `ssh://<remote_id>/<posix_path>` form so local and remote files
//! never collide in caches, open-pane deduplication, watchers, or persisted
//! state.

use std::path::PathBuf;

pub const SSH_SCHEME: &str = "ssh://";

/// Either a local file-system path or an absolute POSIX path on a registered
/// SSH remote.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Location {
    Local(PathBuf),
    Remote {
        remote_id: String,
        /// Absolute POSIX path on the remote host (always starts with `/`,
        /// no trailing `/` unless it is `"/"`).
        path: String,
    },
}

impl Location {
    /// Parses a path string from the frontend into a local or remote location.
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.contains('\0') {
            return Err("path contains a NUL byte".into());
        }
        let Some(rest) = raw.strip_prefix(SSH_SCHEME) else {
            return Ok(Self::Local(PathBuf::from(raw)));
        };
        let Some(slash) = rest.find('/') else {
            return Err(format!("invalid remote path (missing path component): {raw}"));
        };
        let remote_id = &rest[..slash];
        validate_remote_id(remote_id)?;
        let path = normalize_remote_path(&rest[slash..]);
        Ok(Self::Remote {
            remote_id: remote_id.to_string(),
            path,
        })
    }

    /// Formats a remote POSIX path into its canonical `ssh://<id><path>` string.
    pub fn format_remote(remote_id: &str, posix_path: &str) -> String {
        let normalized = normalize_remote_path(posix_path);
        format!("{SSH_SCHEME}{remote_id}{normalized}")
    }
}

/// Validates a remote connection id: URL-safe, non-empty, no slashes or path
/// traversal segments.
pub fn validate_remote_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err(format!("invalid remote id length: {id:?}"));
    }
    if id == "." || id == ".." {
        return Err(format!("invalid remote id: {id:?}"));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'@'))
    {
        return Err(format!("invalid characters in remote id: {id:?}"));
    }
    Ok(())
}

/// Normalizes a remote POSIX path: ensures leading `/` and strips trailing `/`
/// except for `"/"` itself. Does not collapse `..` (symlinks on the remote may
/// give `..` non-lexical semantics).
pub fn normalize_remote_path(path: &str) -> String {
    let mut s = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_local_and_remote_locations() {
        assert_eq!(
            Location::parse("/Users/me/file.txt").unwrap(),
            Location::Local(PathBuf::from("/Users/me/file.txt"))
        );
        assert_eq!(
            Location::parse("ssh://prod-1a2b/home/me/app").unwrap(),
            Location::Remote {
                remote_id: "prod-1a2b".into(),
                path: "/home/me/app".into(),
            }
        );
        assert_eq!(
            Location::parse("ssh://prod-1a2b/").unwrap(),
            Location::Remote {
                remote_id: "prod-1a2b".into(),
                path: "/".into(),
            }
        );
        assert_eq!(
            Location::parse("ssh://prod-1a2b/home/me/").unwrap(),
            Location::Remote {
                remote_id: "prod-1a2b".into(),
                path: "/home/me".into(),
            }
        );
    }

    #[test]
    fn rejects_invalid_remote_locations() {
        assert!(Location::parse("ssh://prod-1a2b").is_err());
        assert!(Location::parse("ssh:///home/me").is_err());
        assert!(Location::parse("ssh://../etc/passwd").is_err());
        assert!(Location::parse("ssh://bad id/home").is_err());
        assert!(Location::parse("ssh://ok/path\0bad").is_err());
        assert!(Location::parse("/local\0bad").is_err());
    }

    #[test]
    fn formats_remote_locations() {
        assert_eq!(
            Location::format_remote("box-1234", "/srv/app/"),
            "ssh://box-1234/srv/app"
        );
        assert_eq!(Location::format_remote("box-1234", "/"), "ssh://box-1234/");
        assert_eq!(
            Location::format_remote("box-1234", "rel"),
            "ssh://box-1234/rel"
        );
    }
}
