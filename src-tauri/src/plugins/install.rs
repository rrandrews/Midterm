//! Installed plugins: listing, importing (from a folder or a `.zip`) and
//! removing, all within one plugins directory.
//!
//! An import is staged: the plugin is copied or extracted into a hidden
//! temporary folder inside the plugins directory, validated there, and only
//! then renamed into place, so a failed import leaves nothing behind and a
//! half-copied plugin is never visible. Folders whose names start with `.`
//! are staging leftovers and never listed (no plugin id starts with `.`).

use std::fs::{self, File};
use std::io::{self, Read, Seek};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::manifest::{self, Manifest};

/// A skill file's content is cut off after this many bytes.
pub const SKILL_LIMIT: u64 = 256 * 1024;
/// An import may not be larger than this in total (bytes, uncompressed).
pub const IMPORT_SIZE_LIMIT: u64 = 64 * 1024 * 1024;
/// An import may not have more files and folders than this.
pub const IMPORT_ENTRY_LIMIT: usize = 10_000;

/// Error of the plugin commands, as `PluginError` in the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The plugin (manifest, archive or id) is not acceptable.
    Invalid,
    /// A plugin with this id is installed; retry with `replace`.
    Exists,
    NotFound,
    Io,
}

impl PluginError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
    pub fn io(context: &str, e: io::Error) -> Self {
        Self::new(ErrorKind::Io, format!("{context}: {e}"))
    }
}

/// A folder in the plugins directory, as `PluginInfo` in the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// The folder name (the manifest's id when the manifest is valid).
    pub id: String,
    pub dir: String,
    pub manifest: Option<Manifest>,
    pub skills: Vec<SkillFile>,
    /// Why the plugin cannot be loaded; `manifest` is `null` when set.
    pub error: Option<String>,
}

/// A skill file listed in a manifest, read so that guidance-only skills can
/// be shown before (or without) loading the plugin's module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillFile {
    /// As written in the manifest.
    pub path: String,
    /// Up to [`SKILL_LIMIT`] bytes, as UTF-8 (invalid bytes replaced).
    pub content: String,
}

/// Describes the plugin folder `dir`, whose name is `id`.
pub fn info(dir: &Path, id: &str) -> PluginInfo {
    let result = if manifest::is_valid_id_format(id) {
        manifest::load(dir).and_then(|m| {
            if m.id == id {
                Ok(m)
            } else {
                Err(format!("the manifest's id \"{}\" does not match the folder name \"{id}\"", m.id))
            }
        })
    } else {
        Err(format!("\"{id}\" is not a valid plugin folder name"))
    };
    let (manifest, error) = match result {
        Ok(m) => (Some(m), None),
        Err(e) => (None, Some(e)),
    };
    let skills = manifest
        .iter()
        .flat_map(|m| &m.skills)
        .map(|path| SkillFile { path: path.clone(), content: read_capped(&dir.join(path), SKILL_LIMIT) })
        .collect();
    PluginInfo {
        id: id.to_string(),
        dir: dir.to_string_lossy().into_owned(),
        manifest,
        skills,
        error,
    }
}

fn read_capped(path: &Path, limit: u64) -> String {
    let mut bytes = Vec::new();
    if let Ok(file) = File::open(path) {
        let _ = file.take(limit).read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Every plugin folder in `root`, sorted by id. A missing `root` has none.
pub fn list(root: &Path) -> Result<Vec<PluginInfo>, PluginError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(PluginError::io("cannot read the plugins folder", e)),
    };
    let mut plugins: Vec<PluginInfo> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            // Follows symlinks: a linked folder is handy while developing a plugin.
            (!name.starts_with('.') && entry.path().is_dir()).then(|| info(&entry.path(), &name))
        })
        .collect();
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(plugins)
}

/// Installs the plugin at `source` (a folder, or a `.zip` file) into
/// `root`. Fails with [`ErrorKind::Exists`] if its id is installed, unless
/// `replace`, which swaps the installed copy for the new one.
pub fn import(root: &Path, source: &Path, replace: bool) -> Result<PluginInfo, PluginError> {
    fs::create_dir_all(root).map_err(|e| PluginError::io("cannot create the plugins folder", e))?;
    let meta = fs::metadata(source)
        .map_err(|e| PluginError::new(ErrorKind::NotFound, format!("cannot open {}: {e}", source.display())))?;
    let staging = tempfile::Builder::new()
        .prefix(".import-")
        .tempdir_in(root)
        .map_err(|e| PluginError::io("cannot create a staging folder", e))?;
    let unpacked = staging.path().join("unpacked");
    fs::create_dir(&unpacked).map_err(|e| PluginError::io("cannot create a staging folder", e))?;

    let plugin_root = if meta.is_dir() {
        let mut budget = Budget::default();
        copy_tree(source, &unpacked, &mut budget)?;
        unpacked.clone()
    } else {
        let file = File::open(source).map_err(|e| PluginError::io("cannot open the archive", e))?;
        extract_zip(file, &unpacked)?;
        find_manifest_root(&unpacked)?
    };

    let manifest = manifest::load(&plugin_root).map_err(PluginError::invalid)?;
    let dest = root.join(&manifest.id);
    install_dir(&plugin_root, &dest, staging.path(), replace)?;
    Ok(info(&dest, &manifest.id))
}

/// Moves the staged plugin `from` to `dest`; with `replace`, an existing
/// `dest` is first moved into `staging` (deleted with it) and put back if
/// the move fails.
fn install_dir(from: &Path, dest: &Path, staging: &Path, replace: bool) -> Result<(), PluginError> {
    let exists = || {
        let id = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        PluginError::new(ErrorKind::Exists, format!("a plugin with the id \"{id}\" is already installed"))
    };
    let installed = fs::symlink_metadata(dest).is_ok();
    if installed && !replace {
        return Err(exists());
    }
    let fail = |e| PluginError::io("cannot install the plugin", e);
    if !installed {
        return match crate::fs::ops::rename_no_replace(from, dest) {
            Some(Ok(())) => Ok(()),
            Some(Err(e)) if e.kind() == io::ErrorKind::AlreadyExists => Err(exists()),
            Some(Err(e)) => Err(fail(e)),
            None => fs::rename(from, dest).map_err(fail),
        };
    }
    let old = staging.join("previous");
    fs::rename(dest, &old).map_err(|e| PluginError::io("cannot move the installed plugin aside", e))?;
    if let Err(e) = fs::rename(from, dest) {
        let _ = fs::rename(&old, dest);
        return Err(fail(e));
    }
    Ok(())
}

/// Removes the installed plugin `id` from `root`.
pub fn remove(root: &Path, id: &str) -> Result<(), PluginError> {
    if !manifest::is_valid_id_format(id) {
        return Err(PluginError::invalid(format!("\"{id}\" is not a valid plugin id")));
    }
    let dir = root.join(id);
    let meta = fs::symlink_metadata(&dir)
        .map_err(|_| PluginError::new(ErrorKind::NotFound, format!("no plugin \"{id}\" is installed")))?;
    if meta.is_symlink() {
        // A linked development folder: unlink it, never delete its target.
        return fs::remove_file(&dir).map_err(|e| PluginError::io("cannot remove the plugin", e));
    }
    if !meta.is_dir() {
        return Err(PluginError::new(ErrorKind::NotFound, format!("no plugin \"{id}\" is installed")));
    }
    // Moved aside first so a partly deleted plugin is never listed.
    let trash = tempfile::Builder::new()
        .prefix(".remove-")
        .tempdir_in(root)
        .map_err(|e| PluginError::io("cannot remove the plugin", e))?;
    fs::rename(&dir, trash.path().join(id)).map_err(|e| PluginError::io("cannot remove the plugin", e))?;
    trash.close().map_err(|e| PluginError::io("cannot delete the plugin's files", e))
}

/// What an import may still use up.
struct Budget {
    bytes: u64,
    entries: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self { bytes: IMPORT_SIZE_LIMIT, entries: IMPORT_ENTRY_LIMIT }
    }
}

impl Budget {
    fn take_entry(&mut self) -> Result<(), PluginError> {
        self.entries = self
            .entries
            .checked_sub(1)
            .ok_or_else(|| PluginError::invalid(format!("the plugin has more than {IMPORT_ENTRY_LIMIT} files")))?;
        Ok(())
    }

    /// Copies at most the remaining budget from `reader` to a new file `to`.
    fn copy(&mut self, reader: &mut impl Read, to: &Path) -> Result<(), PluginError> {
        let mut out = File::create_new(to).map_err(|e| PluginError::io("cannot write the plugin", e))?;
        let copied = io::copy(&mut reader.take(self.bytes + 1), &mut out)
            .map_err(|e| PluginError::io("cannot copy the plugin", e))?;
        self.bytes = self.bytes.checked_sub(copied).ok_or_else(too_large)?;
        Ok(())
    }
}

fn too_large() -> PluginError {
    PluginError::invalid(format!("the plugin is larger than {} MiB", IMPORT_SIZE_LIMIT / (1024 * 1024)))
}

/// Folders skipped when importing from a folder.
const SKIPPED_DIRS: &[&str] = &[".git"];

/// Copies the folder `from` into the existing folder `to`. Symlinks are
/// refused: following one could copy files from outside the plugin.
fn copy_tree(from: &Path, to: &Path, budget: &mut Budget) -> Result<(), PluginError> {
    let entries = fs::read_dir(from).map_err(|e| PluginError::io(&format!("cannot read {}", from.display()), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| PluginError::io("cannot read the plugin folder", e))?;
        let name = entry.file_name();
        let kind = entry.file_type().map_err(|e| PluginError::io("cannot read the plugin folder", e))?;
        let (src, dst) = (entry.path(), to.join(&name));
        if kind.is_symlink() {
            return Err(PluginError::invalid(format!(
                "the plugin folder contains a symbolic link ({}); copy the files instead",
                src.display()
            )));
        }
        budget.take_entry()?;
        if kind.is_dir() {
            if SKIPPED_DIRS.iter().any(|d| name == *d) {
                continue;
            }
            fs::create_dir(&dst).map_err(|e| PluginError::io("cannot write the plugin", e))?;
            copy_tree(&src, &dst, budget)?;
        } else if kind.is_file() {
            let mut file = File::open(&src).map_err(|e| PluginError::io(&format!("cannot read {}", src.display()), e))?;
            budget.copy(&mut file, &dst)?;
        }
    }
    Ok(())
}

/// Top-level archive entries that are packaging noise, not plugin files
/// (macOS Finder's resource forks and folder settings).
fn is_archive_noise(rel: &str) -> bool {
    rel == "__MACOSX" || rel.starts_with("__MACOSX/") || rel.rsplit('/').next() == Some(".DS_Store")
}

/// Extracts a zip archive into the existing folder `to`, refusing entries
/// that are symlinks or whose paths are absolute or contain `..` (zip
/// slip), and archives over the size or entry limits. Sizes are enforced
/// on the bytes actually written, not just the sizes the archive claims.
fn extract_zip(reader: impl Read + Seek, to: &Path) -> Result<(), PluginError> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| PluginError::invalid(format!("not a valid zip archive: {e}")))?;
    if archive.len() > IMPORT_ENTRY_LIMIT {
        return Err(PluginError::invalid(format!("the archive has more than {IMPORT_ENTRY_LIMIT} entries")));
    }
    let mut budget = Budget::default();
    let mut claimed: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| PluginError::invalid(format!("cannot read the archive: {e}")))?;
        let name = entry
            .name()
            .map_err(|e| PluginError::invalid(format!("cannot read the archive: {e}")))?
            .into_owned();
        let rel = name.strip_suffix('/').unwrap_or(&name);
        if !manifest::is_plain_relative(rel) || entry.enclosed_name().is_none() {
            return Err(PluginError::invalid(format!("the archive contains an unsafe path: {name}")));
        }
        if entry.is_symlink() {
            return Err(PluginError::invalid(format!("the archive contains a symbolic link: {name}")));
        }
        if is_archive_noise(rel) {
            continue;
        }
        claimed = claimed.saturating_add(entry.size());
        if claimed > IMPORT_SIZE_LIMIT {
            return Err(too_large());
        }
        budget.take_entry()?;
        let dst = to.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&dst).map_err(|e| PluginError::io("cannot extract the archive", e))?;
            continue;
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| PluginError::io("cannot extract the archive", e))?;
        }
        budget.copy(&mut entry, &dst)?;
    }
    Ok(())
}

/// The folder holding `manifest.json` in an extracted archive: its root,
/// or its single top-level folder.
fn find_manifest_root(unpacked: &Path) -> Result<PathBuf, PluginError> {
    if unpacked.join(manifest::MANIFEST_FILE).is_file() {
        return Ok(unpacked.to_path_buf());
    }
    let read = |e| PluginError::io("cannot read the extracted archive", e);
    let entries: Vec<_> = fs::read_dir(unpacked).map_err(read)?.collect::<Result<_, _>>().map_err(read)?;
    if let [only] = entries.as_slice()
        && only.file_type().map_err(read)?.is_dir()
        && only.path().join(manifest::MANIFEST_FILE).is_file()
    {
        return Ok(only.path());
    }
    Err(PluginError::invalid(format!(
        "no {} at the archive's root or in its single top-level folder",
        manifest::MANIFEST_FILE
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    const MAIN: &str = "export default {}";

    fn manifest_json(id: &str, version: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"Hello","version":"{version}","apiVersion":1,"main":"main.js","skills":["skills/greet/SKILL.md"]}}"#
        )
    }

    /// A plugin folder ready to import.
    fn source(id: &str, version: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("manifest.json"), manifest_json(id, version)).unwrap();
        fs::write(dir.path().join("main.js"), MAIN).unwrap();
        fs::create_dir_all(dir.path().join("skills/greet")).unwrap();
        fs::write(dir.path().join("skills/greet/SKILL.md"), "---\ntitle: Greet\n---\nSay hi.").unwrap();
        dir
    }

    /// Writes a zip with `files` (name, content) to a file in `dir`.
    fn zip_file(dir: &Path, files: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join("plugin.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        for (name, content) in files {
            if name.ends_with('/') {
                zip.add_directory(*name, options).unwrap();
            } else {
                zip.start_file(*name, options).unwrap();
                zip.write_all(content).unwrap();
            }
        }
        zip.finish().unwrap();
        path
    }

    fn plugin_files<'a>(prefix: &str, manifest: &'a str) -> Vec<(String, &'a [u8])> {
        vec![
            (format!("{prefix}manifest.json"), manifest.as_bytes()),
            (format!("{prefix}main.js"), MAIN.as_bytes()),
            (format!("{prefix}skills/greet/SKILL.md"), b"Say hi."),
        ]
    }

    fn zip_plugin(dir: &Path, prefix: &str, extra: &[(&str, &[u8])]) -> PathBuf {
        let manifest = manifest_json("hello", "1.0.0");
        let owned = plugin_files(prefix, &manifest);
        let mut files: Vec<(&str, &[u8])> = owned.iter().map(|(n, c)| (n.as_str(), *c)).collect();
        files.extend_from_slice(extra);
        zip_file(dir, &files)
    }

    /// No staging folders are left behind in `root`.
    fn assert_clean(root: &Path) {
        let leftovers: Vec<_> = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn imports_a_folder_and_lists_it() {
        let root = tempfile::tempdir().unwrap();
        let src = source("hello", "1.0.0");
        fs::create_dir(src.path().join(".git")).unwrap();
        fs::write(src.path().join(".git/HEAD"), "x").unwrap();
        let info = import(root.path(), src.path(), false).unwrap();
        assert_eq!(info.id, "hello");
        assert_eq!(info.error, None);
        assert_eq!(info.manifest.as_ref().unwrap().version, "1.0.0");
        assert_eq!(info.skills.len(), 1);
        assert!(info.skills[0].content.contains("Say hi."));
        assert!(root.path().join("hello/main.js").is_file());
        assert!(!root.path().join("hello/.git").exists());
        assert_eq!(list(root.path()).unwrap(), vec![info]);
        assert_clean(root.path());
        // The source is untouched.
        assert!(src.path().join("manifest.json").is_file());
    }

    #[test]
    fn refuses_an_invalid_folder_and_leaves_nothing() {
        let root = tempfile::tempdir().unwrap();
        let src = source("terminal", "1.0.0");
        let err = import(root.path(), src.path(), false).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(list(root.path()).unwrap().is_empty());
        assert_clean(root.path());
        let missing = import(root.path(), &root.path().join("nope"), false).unwrap_err();
        assert_eq!(missing.kind, ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_folder_with_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let src = source("hello", "1.0.0");
        std::os::unix::fs::symlink("/etc/hosts", src.path().join("hosts")).unwrap();
        let err = import(root.path(), src.path(), false).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_clean(root.path());
    }

    #[test]
    fn replace_semantics() {
        let root = tempfile::tempdir().unwrap();
        import(root.path(), source("hello", "1.0.0").path(), false).unwrap();
        fs::write(root.path().join("hello/old-only.txt"), "").unwrap();

        let err = import(root.path(), source("hello", "2.0.0").path(), false).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Exists);
        assert_eq!(list(root.path()).unwrap()[0].manifest.as_ref().unwrap().version, "1.0.0");

        let info = import(root.path(), source("hello", "2.0.0").path(), true).unwrap();
        assert_eq!(info.manifest.unwrap().version, "2.0.0");
        assert!(!root.path().join("hello/old-only.txt").exists());
        assert_clean(root.path());

        // `replace` with nothing installed is a plain install.
        import(root.path(), source("other", "1.0.0").path(), true).unwrap();
        assert_eq!(list(root.path()).unwrap().len(), 2);
    }

    #[test]
    fn imports_a_zip_with_the_manifest_at_the_root() {
        let root = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let zip = zip_plugin(tmp.path(), "", &[("assets/", b""), ("assets/a.png", b"png")]);
        let info = import(root.path(), &zip, false).unwrap();
        assert_eq!(info.error, None);
        assert!(root.path().join("hello/assets/a.png").is_file());
        assert_clean(root.path());
    }

    #[test]
    fn imports_a_zip_with_a_single_top_level_folder() {
        let root = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let zip = zip_plugin(
            tmp.path(),
            "hello-1.0.0/",
            &[("__MACOSX/hello-1.0.0/._main.js", b"junk"), ("hello-1.0.0/.DS_Store", b"junk")],
        );
        let info = import(root.path(), &zip, false).unwrap();
        assert_eq!(info.id, "hello");
        assert!(root.path().join("hello/main.js").is_file());
        assert!(!root.path().join("hello/.DS_Store").exists());
        assert_clean(root.path());
    }

    #[test]
    fn refuses_a_zip_without_a_manifest_where_expected() {
        let root = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let zip = zip_plugin(tmp.path(), "a/b/", &[]);
        assert_eq!(import(root.path(), &zip, false).unwrap_err().kind, ErrorKind::Invalid);
        let zip = zip_plugin(tmp.path(), "a/", &[("other/x.txt", b"")]);
        assert_eq!(import(root.path(), &zip, false).unwrap_err().kind, ErrorKind::Invalid);
        assert_clean(root.path());
    }

    #[test]
    fn refuses_a_file_that_is_not_a_zip() {
        let root = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("x.zip");
        fs::write(&path, "not a zip").unwrap();
        assert_eq!(import(root.path(), &path, false).unwrap_err().kind, ErrorKind::Invalid);
        assert_clean(root.path());
    }

    #[test]
    fn refuses_zip_slip() {
        for bad in ["../evil.js", "/abs/evil.js", "a/../../evil.js", "a\\..\\evil.js", "C:/evil.js"] {
            let root = tempfile::tempdir().unwrap();
            let tmp = tempfile::tempdir().unwrap();
            let zip = zip_plugin(tmp.path(), "", &[(bad, b"x")]);
            let err = import(root.path(), &zip, false).unwrap_err();
            assert_eq!(err.kind, ErrorKind::Invalid, "{bad}");
            assert!(err.message.contains("unsafe path"), "{bad}: {}", err.message);
            assert!(!tmp.path().join("evil.js").exists());
            assert!(!root.path().join("evil.js").exists());
            assert_clean(root.path());
        }
    }

    #[test]
    fn refuses_symlinks_in_a_zip() {
        let root = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plugin.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest_json("hello", "1.0.0").as_bytes()).unwrap();
        zip.add_symlink("main.js", "/etc/hosts", options).unwrap();
        zip.finish().unwrap();
        let err = import(root.path(), &path, false).unwrap_err();
        assert!(err.message.contains("symbolic link"), "{}", err.message);
        assert_clean(root.path());
    }

    #[test]
    fn refuses_a_zip_that_is_too_large() {
        let root = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        // Compresses to almost nothing: a zip bomb in miniature.
        let big = vec![0u8; IMPORT_SIZE_LIMIT as usize + 1];
        let path = tmp.path().join("plugin.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest_json("hello", "1.0.0").as_bytes()).unwrap();
        zip.start_file("big.bin", options).unwrap();
        zip.write_all(&big).unwrap();
        zip.finish().unwrap();
        let err = import(root.path(), &path, false).unwrap_err();
        assert!(err.message.contains("larger than"), "{}", err.message);
        assert_clean(root.path());
    }

    #[test]
    fn the_budget_counts_bytes_actually_written() {
        let tmp = tempfile::tempdir().unwrap();
        let mut budget = Budget { bytes: 4, entries: 1 };
        assert!(budget.copy(&mut Cursor::new(b"12345"), &tmp.path().join("a")).is_err());
        let mut budget = Budget { bytes: 5, entries: 1 };
        budget.copy(&mut Cursor::new(b"12345"), &tmp.path().join("b")).unwrap();
        assert_eq!(budget.bytes, 0);
        budget.take_entry().unwrap();
        assert!(budget.take_entry().is_err());
    }

    #[test]
    fn lists_broken_plugins_with_their_errors() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("broken")).unwrap();
        fs::write(root.path().join("broken/manifest.json"), "{").unwrap();
        fs::create_dir(root.path().join("Bad_Name")).unwrap();
        fs::create_dir(root.path().join(".import-x")).unwrap();
        fs::write(root.path().join("file.txt"), "").unwrap();
        let src = source("mismatch", "1.0.0");
        fs::rename(src.path(), root.path().join("renamed")).unwrap();

        let plugins = list(root.path()).unwrap();
        let ids: Vec<_> = plugins.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["Bad_Name", "broken", "renamed"]);
        for p in &plugins {
            assert!(p.manifest.is_none() && p.error.is_some(), "{p:?}");
            assert!(p.skills.is_empty());
        }
        assert!(plugins[2].error.as_ref().unwrap().contains("does not match"));
        let json = serde_json::to_value(&plugins[1]).unwrap();
        assert_eq!(json["manifest"], serde_json::Value::Null);
        assert!(json["error"].is_string());
        assert!(list(&root.path().join("missing")).unwrap().is_empty());
    }

    #[test]
    fn skill_content_is_capped() {
        let root = tempfile::tempdir().unwrap();
        let src = source("hello", "1.0.0");
        fs::write(src.path().join("skills/greet/SKILL.md"), "x".repeat(SKILL_LIMIT as usize + 10)).unwrap();
        let info = import(root.path(), src.path(), false).unwrap();
        assert_eq!(info.skills[0].content.len(), SKILL_LIMIT as usize);
    }

    #[test]
    fn removes_plugins() {
        let root = tempfile::tempdir().unwrap();
        import(root.path(), source("hello", "1.0.0").path(), false).unwrap();
        remove(root.path(), "hello").unwrap();
        assert!(list(root.path()).unwrap().is_empty());
        assert_clean(root.path());
        assert_eq!(remove(root.path(), "hello").unwrap_err().kind, ErrorKind::NotFound);
        for bad in ["..", "", "a/b", ".import-x", "/etc"] {
            assert_eq!(remove(root.path(), bad).unwrap_err().kind, ErrorKind::Invalid, "{bad}");
        }
        fs::write(root.path().join("file"), "").unwrap();
        assert_eq!(remove(root.path(), "file").unwrap_err().kind, ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn removing_a_linked_plugin_keeps_its_target() {
        let root = tempfile::tempdir().unwrap();
        let src = source("linked", "1.0.0");
        std::os::unix::fs::symlink(src.path(), root.path().join("linked")).unwrap();
        assert_eq!(list(root.path()).unwrap()[0].error, None);
        remove(root.path(), "linked").unwrap();
        assert!(src.path().join("manifest.json").is_file());
        assert!(list(root.path()).unwrap().is_empty());
    }

    #[test]
    fn error_json_shape() {
        let json = serde_json::to_value(PluginError::new(ErrorKind::NotFound, "x")).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "notFound", "message": "x" }));
    }
}
