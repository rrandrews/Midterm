//! Cross-host file and directory copy (`Local ↔ Remote` and `Remote A → Remote B`).
//!
//! Same-host copies stay fast and local to that host (`fs::copy::copy_into` for
//! local, `helper.py`'s `copy_into` for same-remote). When source and
//! destination live on different hosts, this module streams regular files in
//! bounded 512 KiB chunks into privately staged (`0600`/`0700`) temporary
//! targets, publishes atomically under Finder-style free names without replacing
//! existing entries, validates every child name, preserves permissions on open
//! handles, detects cycles/bind-mounts, and rolls back ONLY entries whose device
//! and inode still match what the copy created.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use crate::fs::copy::{CopyError, CopyProgress, PROGRESS_INTERVAL, measure_local_source};
use crate::fs::ops;

use super::SshManager;
use super::client::EntryIdentity;
use super::location::Location;

/// Streaming chunk size for cross-host regular-file copies (512 KiB).
const CHUNK_SIZE: usize = 512 * 1024;
/// Maximum recursion depth for directory trees (guards against pathological cycles).
const MAX_DEPTH: usize = 256;

static STAGE_SEQ: AtomicU64 = AtomicU64::new(1);

enum NodeKind {
    File { mode: u32, size: u64, id: EntryIdentity },
    Dir { mode: u32, id: EntryIdentity },
    Symlink { target: String },
    Special,
}

struct TransferProgress<'a> {
    bytes_transferred: u64,
    total_bytes: Option<u64>,
    files_completed: u64,
    total_files: Option<u64>,
    current_file: Option<String>,
    last_emit: Option<Instant>,
    emit: &'a mut (dyn FnMut(CopyProgress) + Send),
}

impl<'a> TransferProgress<'a> {
    fn new(
        total_bytes: Option<u64>,
        total_files: Option<u64>,
        emit: &'a mut (dyn FnMut(CopyProgress) + Send),
    ) -> Self {
        Self {
            bytes_transferred: 0,
            total_bytes,
            files_completed: 0,
            total_files,
            current_file: None,
            last_emit: None,
            emit,
        }
    }

    fn emit_now(&mut self) {
        self.last_emit = Some(Instant::now());
        (self.emit)(CopyProgress {
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            files_completed: self.files_completed,
            total_files: self.total_files,
            current_file: self.current_file.clone(),
        });
    }

    fn emit_throttled(&mut self) {
        if self.last_emit.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) {
            self.emit_now();
        }
    }

    fn start_file(&mut self, name: String) {
        self.current_file = Some(name);
        self.emit_throttled();
    }

    fn add_bytes(&mut self, n: u64) {
        self.bytes_transferred = self.bytes_transferred.saturating_add(n);
        self.emit_throttled();
    }

    fn finish_file(&mut self) {
        self.files_completed = self.files_completed.saturating_add(1);
        self.emit_throttled();
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), CopyError> {
    if cancel.load(Ordering::Relaxed) {
        Err(CopyError::Cancelled)
    } else {
        Ok(())
    }
}

fn candidate_name(name: &str, is_dir: bool, attempt: u32) -> String {
    if attempt == 1 {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir && i + 1 < name.len() => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    if attempt == 2 {
        format!("{stem} copy{ext}")
    } else {
        format!("{stem} copy {}{ext}", attempt - 1)
    }
}

/// Ensures a single directory-entry name cannot escape its parent on either
/// POSIX or the host platform: rejects empty names, NUL, separators, `.`, `..`,
/// and requires `Path::new(name).components()` to yield exactly one `Normal`
/// component.
pub(crate) fn validate_child_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('\0')
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(format!("refusing invalid entry name '{name}'"));
    }
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(format!("refusing non-local entry name '{name}'")),
    }
}

fn unique_stage_name() -> String {
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0u128, |d| d.as_nanos());
    let pid = std::process::id();
    format!(".midterm-copy-{pid}-{seq}-{nanos:x}")
}

fn join_location(dir: &Location, name: &str) -> Result<Location, String> {
    validate_child_name(name)?;
    Ok(match dir {
        Location::Local(p) => Location::Local(p.join(name)),
        Location::Remote { remote_id, path } => {
            let joined = if path == "/" {
                format!("/{name}")
            } else {
                format!("{}/{name}", path.trim_end_matches('/'))
            };
            Location::Remote {
                remote_id: remote_id.clone(),
                path: joined,
            }
        }
    })
}

fn format_location(loc: &Location) -> String {
    match loc {
        Location::Local(p) => p.to_string_lossy().into_owned(),
        Location::Remote { remote_id, path } => Location::format_remote(remote_id, path),
    }
}

fn base_name(loc: &Location) -> Result<String, String> {
    let name = match loc {
        Location::Local(p) => p
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
            .ok_or_else(|| format!("cannot copy {}: no usable UTF-8 name", p.display()))?,
        Location::Remote { path, .. } => {
            let trimmed = path.trim_end_matches('/');
            let name = trimmed.rsplit('/').next().unwrap_or("");
            if name.is_empty() {
                return Err(format!("cannot copy {path}: no usable name"));
            }
            name.to_string()
        }
    };
    validate_child_name(&name)?;
    Ok(name)
}

#[cfg(unix)]
fn local_identity(meta: &fs::Metadata) -> Option<EntryIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(EntryIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
    })
}

#[cfg(not(unix))]
fn local_identity(_meta: &fs::Metadata) -> Option<EntryIdentity> {
    None
}

async fn inspect_source(ssh: &SshManager, loc: &Location) -> Result<NodeKind, String> {
    match loc {
        Location::Local(path) => {
            let p = path.clone();
            tokio::task::spawn_blocking(move || {
                let meta = fs::symlink_metadata(&p)
                    .map_err(|e| format!("cannot inspect {}: {e}", p.display()))?;
                let ft = meta.file_type();
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    meta.permissions().mode() & 0o777
                };
                #[cfg(not(unix))]
                let mode = 0o644;
                if ft.is_symlink() {
                    let target = fs::read_link(&p)
                        .map_err(|e| format!("cannot readlink {}: {e}", p.display()))?;
                    let target_s = target
                        .to_str()
                        .ok_or_else(|| format!("cannot copy symlink {} with non-UTF-8 target", p.display()))?;
                    Ok(NodeKind::Symlink {
                        target: target_s.to_string(),
                    })
                } else if ft.is_dir() {
                    let id = local_identity(&meta).unwrap_or(EntryIdentity { dev: 0, ino: 0 });
                    Ok(NodeKind::Dir { mode, id })
                } else if ft.is_file() {
                    let id = local_identity(&meta).unwrap_or(EntryIdentity { dev: 0, ino: 0 });
                    Ok(NodeKind::File {
                        mode,
                        size: meta.len(),
                        id,
                    })
                } else {
                    Ok(NodeKind::Special)
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Location::Remote { remote_id, path } => {
            let client = ssh.client(remote_id).await?;
            let meta = client
                .lstat_meta(path)
                .await?
                .ok_or_else(|| format!("cannot copy {path}: not found"))?;
            match meta.kind.as_str() {
                "symlink" => Ok(NodeKind::Symlink {
                    target: client.readlink(path).await?,
                }),
                "dir" => Ok(NodeKind::Dir {
                    mode: meta.mode & 0o777,
                    id: EntryIdentity {
                        dev: meta.dev,
                        ino: meta.ino,
                    },
                }),
                "file" => Ok(NodeKind::File {
                    mode: meta.mode & 0o777,
                    size: meta.size,
                    id: EntryIdentity {
                        dev: meta.dev,
                        ino: meta.ino,
                    },
                }),
                _ => Ok(NodeKind::Special),
            }
        }
    }
}

async fn ensure_dest_is_dir(ssh: &SshManager, loc: &Location) -> Result<(), String> {
    match loc {
        Location::Local(p) => {
            let p = p.clone();
            tokio::task::spawn_blocking(move || {
                if fs::metadata(&p).is_ok_and(|m| m.is_dir()) {
                    Ok(())
                } else {
                    Err(format!("{} is not a directory", p.display()))
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Location::Remote { remote_id, path } => {
            let client = ssh.client(remote_id).await?;
            match client.stat(path).await? {
                Some(entry) if entry.kind == crate::fs::list::EntryKind::Dir => Ok(()),
                _ => Err(format!("{path} is not a directory")),
            }
        }
    }
}

async fn list_source_children(ssh: &SshManager, loc: &Location) -> Result<Vec<String>, String> {
    match loc {
        Location::Local(p) => {
            let p = p.clone();
            tokio::task::spawn_blocking(move || {
                let rd = fs::read_dir(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
                let mut names = Vec::new();
                for entry in rd {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                        return Err(format!(
                            "cannot copy {}: directory contains a non-UTF-8 filename",
                            p.display()
                        ));
                    };
                    validate_child_name(&name)?;
                    names.push(name);
                }
                Ok(names)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Location::Remote { remote_id, path } => {
            let client = ssh.client(remote_id).await?;
            let names = client.list_copy_children(path).await?;
            for name in &names {
                validate_child_name(name)?;
            }
            Ok(names)
        }
    }
}

enum CreateOutcome {
    Created(Option<EntryIdentity>),
    Exists,
}

async fn create_private_dir(ssh: &SshManager, loc: &Location) -> Result<CreateOutcome, String> {
    match loc {
        Location::Local(p) => {
            let p = p.clone();
            tokio::task::spawn_blocking(move || {
                let mut builder = fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                match builder.create(&p) {
                    Ok(()) => {
                        let id = fs::symlink_metadata(&p).ok().and_then(|m| local_identity(&m));
                        Ok(CreateOutcome::Created(id))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(CreateOutcome::Exists),
                    Err(e) => Err(format!("cannot create {}: {e}", p.display())),
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Location::Remote { remote_id, path } => {
            let client = ssh.client(remote_id).await?;
            match client.mkdir_private(path).await {
                Ok(id) => Ok(CreateOutcome::Created(Some(id))),
                Err(e) if e == "EEXIST" || e.contains("File exists") => Ok(CreateOutcome::Exists),
                Err(e) => Err(e),
            }
        }
    }
}

async fn create_dest_symlink(
    ssh: &SshManager,
    loc: &Location,
    target: &str,
) -> Result<CreateOutcome, String> {
    match loc {
        Location::Local(p) => {
            let p = p.clone();
            let t = PathBuf::from(target);
            tokio::task::spawn_blocking(move || {
                #[cfg(unix)]
                match std::os::unix::fs::symlink(&t, &p) {
                    Ok(()) => {
                        let id = fs::symlink_metadata(&p).ok().and_then(|m| local_identity(&m));
                        Ok(CreateOutcome::Created(id))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(CreateOutcome::Exists),
                    Err(e) => Err(format!("cannot symlink {}: {e}", p.display())),
                }
                #[cfg(not(unix))]
                {
                    let _ = (p, t);
                    Err("symlinks unsupported on this platform".into())
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Location::Remote { remote_id, path } => {
            let client = ssh.client(remote_id).await?;
            match client.symlink_new(target, path).await {
                Ok(id) => Ok(CreateOutcome::Created(Some(id))),
                Err(e) if e == "EEXIST" || e.contains("File exists") => Ok(CreateOutcome::Exists),
                Err(e) => Err(e),
            }
        }
    }
}

async fn set_dest_mode(ssh: &SshManager, loc: &Location, mode: u32) -> Result<(), String> {
    let masked = mode & 0o777;
    match loc {
        Location::Local(p) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let p = p.clone();
                tokio::task::spawn_blocking(move || {
                    fs::set_permissions(&p, fs::Permissions::from_mode(masked))
                        .map_err(|e| format!("cannot set permissions on {}: {e}", p.display()))
                })
                .await
                .map_err(|e| e.to_string())?
            }
            #[cfg(not(unix))]
            {
                let _ = (p, masked);
                Ok(())
            }
        }
        Location::Remote { remote_id, path } => {
            let client = ssh.client(remote_id).await?;
            client.chmod(path, masked).await
        }
    }
}

enum RenameOutcome {
    Renamed,
    Exists,
}

async fn rename_no_replace(
    ssh: &SshManager,
    from: &Location,
    to: &Location,
    is_dir: bool,
) -> Result<RenameOutcome, String> {
    match (from, to) {
        (Location::Local(a), Location::Local(b)) => {
            let (a, b) = (a.clone(), b.clone());
            tokio::task::spawn_blocking(move || match ops::rename_no_replace(&a, &b) {
                Some(Ok(())) => Ok(RenameOutcome::Renamed),
                Some(Err(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    Ok(RenameOutcome::Exists)
                }
                Some(Err(e)) => Err(format!("cannot publish {}: {e}", b.display())),
                None => {
                    if !is_dir {
                        // Atomic no-replace publication for regular files via hard_link + unlink.
                        match fs::hard_link(&a, &b) {
                            Ok(()) => {
                                let _ = fs::remove_file(&a);
                                return Ok(RenameOutcome::Renamed);
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                                return Ok(RenameOutcome::Exists);
                            }
                            Err(_) => {}
                        }
                    }
                    Err(format!(
                        "cannot safely publish {}: atomic non-replacing rename is not supported on this filesystem",
                        b.display()
                    ))
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        (
            Location::Remote { remote_id: r1, path: a },
            Location::Remote { remote_id: r2, path: b },
        ) if r1 == r2 => {
            let client = ssh.client(r1).await?;
            match client.rename_no_replace(a, b).await {
                Ok(()) => Ok(RenameOutcome::Renamed),
                Err(e) if e == "EEXIST" || e.contains("File exists") => Ok(RenameOutcome::Exists),
                Err(e) => Err(e),
            }
        }
        _ => Err("internal error: rename_no_replace requires same host".into()),
    }
}

/// Streams a regular file from `src` to a freshly created private (`0600`) file
/// at `dst` in bounded 512 KiB chunks, applying `mode & 0o777` via the open
/// handle before closing. Records the created file in `created` immediately
/// upon exclusive creation so failure at any point rolls it back cleanly.
#[allow(clippy::too_many_arguments)]
async fn stream_file_to_new(
    ssh: &SshManager,
    src: &Location,
    dst: &Location,
    mode: u32,
    expected_src_id: EntryIdentity,
    created: &mut Vec<(Location, bool, Option<EntryIdentity>)>,
    cancel: &AtomicBool,
    progress: &mut TransferProgress<'_>,
) -> Result<CreateOutcome, CopyError> {
    check_cancel(cancel)?;
    let masked = mode & 0o777;
    match (src, dst) {
        // Local -> Remote
        (Location::Local(src_path), Location::Remote { remote_id, path: dst_path }) => {
            // Open the local source FIRST without following symlinks and
            // nonblocking, verifying its (dev, ino) matches what inspect_source
            // saw, so a concurrent swap to a symlink or FIFO cannot leak files
            // outside the tree or block the worker.
            let open_path = src_path.clone();
            let mut file = tokio::task::spawn_blocking(move || {
                let mut opts = OpenOptions::new();
                opts.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                }
                let f = opts
                    .open(&open_path)
                    .map_err(|e| format!("cannot open {}: {e}", open_path.display()))?;
                let meta = f
                    .metadata()
                    .map_err(|e| format!("cannot inspect {}: {e}", open_path.display()))?;
                if !meta.is_file() {
                    return Err(format!("cannot copy {}: not a regular file", open_path.display()));
                }
                if let Some(actual_id) = local_identity(&meta)
                    && actual_id != expected_src_id
                {
                    return Err(format!(
                        "cannot copy {}: source file changed during copy",
                        open_path.display()
                    ));
                }
                Ok::<File, String>(f)
            })
            .await
            .map_err(|e| CopyError::Failed(e.to_string()))?
            .map_err(CopyError::Failed)?;

            let client = ssh.client(remote_id).await.map_err(CopyError::Failed)?;
            let wh = match client.transfer_open_write(dst_path).await {
                Ok(w) => w,
                Err(e) if e == "EEXIST" || e.contains("File exists") => {
                    return Ok(CreateOutcome::Exists);
                }
                Err(e) => return Err(CopyError::Failed(e)),
            };
            let id = EntryIdentity { dev: wh.dev, ino: wh.ino };
            created.push((dst.clone(), false, Some(id)));

            loop {
                if cancel.load(Ordering::Relaxed) {
                    client.transfer_close(wh.handle).await;
                    return Err(CopyError::Cancelled);
                }
                let read_res = tokio::task::spawn_blocking(move || {
                    let mut buf = vec![0u8; CHUNK_SIZE];
                    match file.read(&mut buf) {
                        Ok(n) => {
                            buf.truncate(n);
                            Ok((file, buf))
                        }
                        Err(e) => Err(format!("read failed: {e}")),
                    }
                })
                .await
                .map_err(|e| CopyError::Failed(e.to_string()))?;

                let (f_back, chunk) = match read_res {
                    Ok(pair) => pair,
                    Err(e) => {
                        client.transfer_close(wh.handle).await;
                        return Err(CopyError::Failed(e));
                    }
                };
                file = f_back;
                if chunk.is_empty() {
                    break;
                }
                if let Err(e) = client.transfer_write(wh.handle, &chunk).await {
                    client.transfer_close(wh.handle).await;
                    return Err(CopyError::Failed(e));
                }
                progress.add_bytes(chunk.len() as u64);
            }
            if let Err(e) = client.transfer_finish_write(wh.handle, masked).await {
                client.transfer_close(wh.handle).await;
                return Err(CopyError::Failed(e));
            }
            Ok(CreateOutcome::Created(Some(id)))
        }

        // Remote -> Local
        (Location::Remote { remote_id, path: src_path }, Location::Local(dst_path)) => {
            let create_path = dst_path.clone();
            let local_open = tokio::task::spawn_blocking(move || {
                let mut opts = OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                match opts.open(&create_path) {
                    Ok(f) => {
                        let id = f.metadata().ok().and_then(|m| local_identity(&m));
                        Ok(Some((f, id)))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
                    Err(e) => Err(format!("cannot create {}: {e}", create_path.display())),
                }
            })
            .await
            .map_err(|e| CopyError::Failed(e.to_string()))?
            .map_err(CopyError::Failed)?;

            let Some((mut out_file, id)) = local_open else {
                return Ok(CreateOutcome::Exists);
            };
            created.push((dst.clone(), false, id));

            let client = ssh.client(remote_id).await.map_err(CopyError::Failed)?;
            let rhandle = client.transfer_open_read(src_path).await.map_err(CopyError::Failed)?;

            let stream_res: Result<File, CopyError> = async {
                loop {
                    check_cancel(cancel)?;
                    let chunk = client
                        .transfer_read(rhandle, CHUNK_SIZE)
                        .await
                        .map_err(CopyError::Failed)?;
                    if chunk.is_empty() {
                        break;
                    }
                    let chunk_len = chunk.len() as u64;
                    out_file = tokio::task::spawn_blocking(move || {
                        out_file
                            .write_all(&chunk)
                            .map_err(|e| format!("write failed: {e}"))?;
                        Ok::<File, String>(out_file)
                    })
                    .await
                    .map_err(|e| CopyError::Failed(e.to_string()))?
                    .map_err(CopyError::Failed)?;
                    progress.add_bytes(chunk_len);
                }
                Ok(out_file)
            }
            .await;

            client.transfer_close(rhandle).await;
            let out_file = stream_res?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::task::spawn_blocking(move || {
                    out_file
                        .set_permissions(fs::Permissions::from_mode(masked))
                        .map_err(|e| format!("cannot set file permissions: {e}"))
                })
                .await
                .map_err(|e| CopyError::Failed(e.to_string()))?
                .map_err(CopyError::Failed)?;
            }
            #[cfg(not(unix))]
            drop(out_file);

            Ok(CreateOutcome::Created(id))
        }

        // Remote A -> Remote B
        (
            Location::Remote { remote_id: src_rid, path: src_path },
            Location::Remote { remote_id: dst_rid, path: dst_path },
        ) => {
            let src_client = ssh.client(src_rid).await.map_err(CopyError::Failed)?;
            let dst_client = ssh.client(dst_rid).await.map_err(CopyError::Failed)?;
            let wh = match dst_client.transfer_open_write(dst_path).await {
                Ok(w) => w,
                Err(e) if e == "EEXIST" || e.contains("File exists") => {
                    return Ok(CreateOutcome::Exists);
                }
                Err(e) => return Err(CopyError::Failed(e)),
            };
            let id = EntryIdentity { dev: wh.dev, ino: wh.ino };
            created.push((dst.clone(), false, Some(id)));

            let rhandle = match src_client.transfer_open_read(src_path).await {
                Ok(h) => h,
                Err(e) => {
                    dst_client.transfer_close(wh.handle).await;
                    return Err(CopyError::Failed(e));
                }
            };

            let stream_res: Result<(), CopyError> = async {
                loop {
                    check_cancel(cancel)?;
                    let chunk = src_client
                        .transfer_read(rhandle, CHUNK_SIZE)
                        .await
                        .map_err(CopyError::Failed)?;
                    if chunk.is_empty() {
                        break;
                    }
                    dst_client
                        .transfer_write(wh.handle, &chunk)
                        .await
                        .map_err(CopyError::Failed)?;
                    progress.add_bytes(chunk.len() as u64);
                }
                Ok(())
            }
            .await;

            src_client.transfer_close(rhandle).await;
            if let Err(e) = stream_res {
                dst_client.transfer_close(wh.handle).await;
                return Err(e);
            }
            if let Err(e) = dst_client.transfer_finish_write(wh.handle, masked).await {
                dst_client.transfer_close(wh.handle).await;
                return Err(CopyError::Failed(e));
            }
            Ok(CreateOutcome::Created(Some(id)))
        }

        (Location::Local(_), Location::Local(_)) => Err(CopyError::Failed(
            "internal error: same-host local copy should use fs::copy".into(),
        )),
    }
}

async fn rollback(ssh: &SshManager, created: &[(Location, bool, Option<EntryIdentity>)]) {
    for (loc, is_dir, expected_id) in created.iter().rev() {
        match loc {
            Location::Local(p) => {
                let p = p.clone();
                let is_dir = *is_dir;
                let expected = *expected_id;
                let _ = tokio::task::spawn_blocking(move || {
                    if let Some(exp) = expected {
                        let Ok(meta) = fs::symlink_metadata(&p) else {
                            return;
                        };
                        if local_identity(&meta) != Some(exp) {
                            return;
                        }
                    }
                    let _ = if is_dir { fs::remove_dir(&p) } else { fs::remove_file(&p) };
                })
                .await;
            }
            Location::Remote { remote_id, path } => {
                if let Ok(client) = ssh.client(remote_id).await {
                    client.remove_single(path, *is_dir, *expected_id).await;
                }
            }
        }
    }
}

async fn publish_staged(
    ssh: &SshManager,
    stage: &Location,
    to_dir: &Location,
    name: &str,
    is_dir: bool,
    cancel: &AtomicBool,
) -> Result<String, CopyError> {
    for attempt in 1u32.. {
        check_cancel(cancel)?;
        let dest = join_location(to_dir, &candidate_name(name, is_dir, attempt))
            .map_err(CopyError::Failed)?;
        match rename_no_replace(ssh, stage, &dest, is_dir)
            .await
            .map_err(CopyError::Failed)?
        {
            RenameOutcome::Renamed => return Ok(format_location(&dest)),
            RenameOutcome::Exists => continue,
        }
    }
    unreachable!()
}

/// Copies `from` into `to_dir` when they reside on different hosts (Local ↔
/// Remote or Remote A → Remote B). Returns the canonical path string of the
/// new copy.
pub async fn copy_cross_host(
    ssh: &SshManager,
    from: &Location,
    to_dir: &Location,
) -> Result<String, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    copy_cross_host_with_progress(ssh, from, to_dir, &cancel, &mut |_| {})
        .await
        .map_err(CopyError::into_string)
}

/// Like [`copy_cross_host`], reporting chunk-level progress and honoring `cancel`.
pub async fn copy_cross_host_with_progress(
    ssh: &SshManager,
    from: &Location,
    to_dir: &Location,
    cancel: &Arc<AtomicBool>,
    on_progress: &mut (dyn FnMut(CopyProgress) + Send),
) -> Result<String, CopyError> {
    check_cancel(cancel)?;
    let name = base_name(from).map_err(CopyError::Failed)?;
    ensure_dest_is_dir(ssh, to_dir)
        .await
        .map_err(CopyError::Failed)?;
    let top = inspect_source(ssh, from)
        .await
        .map_err(CopyError::Failed)?;

    match top {
        NodeKind::Special => Err(CopyError::Failed(format!(
            "cannot copy {}: not a file or directory",
            format_location(from)
        ))),
        NodeKind::Symlink { target } => {
            let mut progress = TransferProgress::new(Some(0), Some(1), on_progress);
            progress.start_file(name.clone());
            for attempt in 1u32.. {
                check_cancel(cancel)?;
                let dest = join_location(to_dir, &candidate_name(&name, false, attempt))
                    .map_err(CopyError::Failed)?;
                match create_dest_symlink(ssh, &dest, &target)
                    .await
                    .map_err(CopyError::Failed)?
                {
                    CreateOutcome::Exists => continue,
                    CreateOutcome::Created(_) => {
                        progress.finish_file();
                        progress.emit_now();
                        return Ok(format_location(&dest));
                    }
                }
            }
            unreachable!()
        }
        NodeKind::File { mode, size, id: src_id } => {
            let mut progress = TransferProgress::new(Some(size), Some(1), on_progress);
            progress.start_file(name.clone());
            let mut created = Vec::new();
            let stage = loop {
                check_cancel(cancel)?;
                let candidate =
                    join_location(to_dir, &unique_stage_name()).map_err(CopyError::Failed)?;
                match stream_file_to_new(
                    ssh,
                    from,
                    &candidate,
                    mode,
                    src_id,
                    &mut created,
                    cancel,
                    &mut progress,
                )
                .await
                {
                    Ok(CreateOutcome::Exists) => continue,
                    Ok(CreateOutcome::Created(_)) => break candidate,
                    Err(e) => {
                        rollback(ssh, &created).await;
                        return Err(e);
                    }
                }
            };
            match publish_staged(ssh, &stage, to_dir, &name, false, cancel).await {
                Ok(dest_str) => {
                    progress.finish_file();
                    progress.emit_now();
                    Ok(dest_str)
                }
                Err(e) => {
                    rollback(ssh, &created).await;
                    Err(e)
                }
            }
        }
        NodeKind::Dir { mode, id: src_root_id } => {
            let (total_bytes, total_files) = match from {
                Location::Local(p) => {
                    let path = p.clone();
                    let cancel_flag = cancel.clone();
                    // Measure total size up front for local uploads so progress is determinate.
                    let measured = tokio::task::spawn_blocking(move || {
                        measure_local_source(&path, &cancel_flag)
                    })
                    .await
                    .ok()
                    .flatten();
                    check_cancel(cancel)?;
                    match measured {
                        Some((b, f)) => (Some(b), Some(f)),
                        None => (None, None),
                    }
                }
                Location::Remote { .. } => (None, None),
            };
            let mut progress = TransferProgress::new(total_bytes, total_files, on_progress);
            progress.start_file(name.clone());

            let mut created = Vec::new();
            let mut dir_modes = Vec::new();
            let (stage_name, stage) = loop {
                check_cancel(cancel)?;
                let sname = unique_stage_name();
                let candidate = join_location(to_dir, &sname).map_err(CopyError::Failed)?;
                match create_private_dir(ssh, &candidate)
                    .await
                    .map_err(CopyError::Failed)?
                {
                    CreateOutcome::Exists => continue,
                    CreateOutcome::Created(id) => {
                        created.push((candidate.clone(), true, id));
                        dir_modes.push((candidate.clone(), mode));
                        break (sname, candidate);
                    }
                }
            };

            let mut active_src_dirs = HashSet::new();
            active_src_dirs.insert(src_root_id);

            let copy_res = copy_tree_contents(
                ssh,
                from,
                &stage,
                &stage_name,
                0,
                &mut active_src_dirs,
                &mut created,
                &mut dir_modes,
                cancel,
                &mut progress,
            )
            .await;

            if let Err(e) = copy_res {
                rollback(ssh, &created).await;
                return Err(e);
            }

            // Apply directory modes bottom-up before publishing, restoring writable
            // mode if aborted so rollback can remove staged children cleanly.
            let mut applied_dirs: Vec<Location> = Vec::new();
            for (d, m) in dir_modes.into_iter().rev() {
                if let Err(e) = check_cancel(cancel) {
                    for locked in applied_dirs.iter().rev() {
                        let _ = set_dest_mode(ssh, locked, 0o700).await;
                    }
                    rollback(ssh, &created).await;
                    return Err(e);
                }
                if let Err(e) = set_dest_mode(ssh, &d, m).await {
                    for locked in applied_dirs.iter().rev() {
                        let _ = set_dest_mode(ssh, locked, 0o700).await;
                    }
                    rollback(ssh, &created).await;
                    return Err(CopyError::Failed(e));
                }
                applied_dirs.push(d);
            }

            match publish_staged(ssh, &stage, to_dir, &name, true, cancel).await {
                Ok(dest_str) => {
                    progress.emit_now();
                    Ok(dest_str)
                }
                Err(e) => {
                    for locked in applied_dirs.iter().rev() {
                        let _ = set_dest_mode(ssh, locked, 0o700).await;
                    }
                    rollback(ssh, &created).await;
                    Err(e)
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn copy_tree_contents<'a, 'b>(
    ssh: &'a SshManager,
    src_dir: &'a Location,
    dst_dir: &'a Location,
    stage_name: &'a str,
    depth: usize,
    active_src_dirs: &'a mut HashSet<EntryIdentity>,
    created: &'a mut Vec<(Location, bool, Option<EntryIdentity>)>,
    dir_modes: &'a mut Vec<(Location, u32)>,
    cancel: &'a AtomicBool,
    progress: &'a mut TransferProgress<'b>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), CopyError>> + Send + 'a>> {
    Box::pin(async move {
        check_cancel(cancel)?;
        if depth >= MAX_DEPTH {
            return Err(CopyError::Failed(
                "cannot copy directory: maximum nesting depth exceeded".into(),
            ));
        }
        let names = list_source_children(ssh, src_dir)
            .await
            .map_err(CopyError::Failed)?;
        for name in names {
            check_cancel(cancel)?;
            if name == stage_name {
                return Err(CopyError::Failed(format!(
                    "cannot copy {} into itself",
                    format_location(src_dir)
                )));
            }
            let child_src = join_location(src_dir, &name).map_err(CopyError::Failed)?;
            let child_dst = join_location(dst_dir, &name).map_err(CopyError::Failed)?;
            match inspect_source(ssh, &child_src)
                .await
                .map_err(CopyError::Failed)?
            {
                NodeKind::File { mode, id: src_id, .. } => {
                    progress.start_file(name);
                    match stream_file_to_new(
                        ssh,
                        &child_src,
                        &child_dst,
                        mode,
                        src_id,
                        created,
                        cancel,
                        progress,
                    )
                    .await?
                    {
                        CreateOutcome::Created(_) => progress.finish_file(),
                        CreateOutcome::Exists => {
                            return Err(CopyError::Failed(format!(
                                "{} already exists",
                                format_location(&child_dst)
                            )));
                        }
                    }
                }
                NodeKind::Dir { mode, id } => {
                    if !active_src_dirs.insert(id) {
                        return Err(CopyError::Failed(format!(
                            "cannot copy {}: detected directory cycle",
                            format_location(&child_src)
                        )));
                    }
                    let create_res = create_private_dir(ssh, &child_dst)
                        .await
                        .map_err(CopyError::Failed);
                    let nested_res = match create_res {
                        Ok(CreateOutcome::Created(dst_id)) => {
                            created.push((child_dst.clone(), true, dst_id));
                            dir_modes.push((child_dst.clone(), mode));
                            copy_tree_contents(
                                ssh,
                                &child_src,
                                &child_dst,
                                stage_name,
                                depth + 1,
                                active_src_dirs,
                                created,
                                dir_modes,
                                cancel,
                                progress,
                            )
                            .await
                        }
                        Ok(CreateOutcome::Exists) => Err(CopyError::Failed(format!(
                            "{} already exists",
                            format_location(&child_dst)
                        ))),
                        Err(e) => Err(e),
                    };
                    active_src_dirs.remove(&id);
                    nested_res?;
                }
                NodeKind::Symlink { target } => {
                    progress.start_file(name);
                    match create_dest_symlink(ssh, &child_dst, &target)
                        .await
                        .map_err(CopyError::Failed)?
                    {
                        CreateOutcome::Created(dst_id) => {
                            created.push((child_dst, false, dst_id));
                            progress.finish_file();
                        }
                        CreateOutcome::Exists => {
                            return Err(CopyError::Failed(format!(
                                "{} already exists",
                                format_location(&child_dst)
                            )));
                        }
                    }
                }
                NodeKind::Special => {}
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_child_names_strictly() {
        assert!(validate_child_name("normal.txt").is_ok());
        assert!(validate_child_name(".env").is_ok());
        assert!(validate_child_name("name with spaces").is_ok());
        assert!(validate_child_name("").is_err());
        assert!(validate_child_name(".").is_err());
        assert!(validate_child_name("..").is_err());
        assert!(validate_child_name("/etc/passwd").is_err());
        assert!(validate_child_name("../escape").is_err());
        assert!(validate_child_name("sub/dir").is_err());
        assert!(validate_child_name("sub\\dir").is_err());
        assert!(validate_child_name("bad\0name").is_err());
    }
}
