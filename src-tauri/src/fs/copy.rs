//! Copying a file or directory tree into a directory, for the explorer's
//! copy and paste.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// Copies `from` (a file, a directory tree or a symlink) into the directory
/// `to_dir` and returns the path of the copy. Nothing is ever replaced: if
/// the name is taken, the copy is named as Finder does ("a copy.txt", then
/// "a copy 2.txt", ...; "dir copy"; ".env copy").
///
/// Symlinks are copied as links, not followed, also inside a directory.
/// Permissions are kept. Sockets, FIFOs and devices inside a directory are
/// skipped (as the top-level item they are an error). Every file is created
/// exclusively, so a name that clashes inside a tree (`Report` and `report`
/// from a case-sensitive volume onto a case-insensitive one) is an error.
/// If copying fails midway, what the copy created is removed, one entry at a
/// time, so anything else that appeared there meanwhile stays.
///
/// A directory cannot be copied into itself or into one of its descendants.
pub fn copy_into(from: &Path, to_dir: &Path) -> Result<String, String> {
    let fail = |e: io::Error| format!("cannot copy {} to {}: {e}", from.display(), to_dir.display());
    let meta = fs::symlink_metadata(from).map_err(fail)?;
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("cannot copy {}: no usable name", from.display()))?;
    if !fs::metadata(to_dir).map_err(fail)?.is_dir() {
        return Err(format!("{} is not a directory", to_dir.display()));
    }
    let kind = Kind::of(&meta);
    if kind == Kind::Dir {
        let source = fs::canonicalize(from).map_err(fail)?;
        let target = fs::canonicalize(to_dir).map_err(fail)?;
        if target.starts_with(&source) {
            return Err(format!("cannot copy {} into itself", from.display()));
        }
    }
    if kind == Kind::Special {
        return Err(format!("cannot copy {}: not a file or directory", from.display()));
    }

    // Claiming a free name creates the destination (an empty file, the
    // directory, or the link), so two copies never take the same name.
    let is_dir = kind == Kind::Dir;
    for attempt in 1.. {
        let dest = to_dir.join(candidate_name(name, is_dir, attempt));
        let claimed = match claim(from, &dest, kind) {
            Ok(claimed) => claimed,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(fail(e)),
        };
        let mut created = Created::default();
        let result = match claimed {
            Claimed::File(out) => {
                created.add_file(&dest);
                copy_file(from, out)
            }
            Claimed::Dir => {
                created.add_dir(&dest, meta.permissions());
                copy_dir_contents(from, &dest, &mut created).and_then(|()| created.apply_dir_permissions())
            }
            Claimed::Link => Ok(()),
        };
        if let Err(e) = result {
            created.roll_back();
            return Err(fail(e));
        }
        return dest.to_str().map(str::to_string).ok_or_else(|| format!("{} is not UTF-8", dest.display()));
    }
    unreachable!("the loop only ends by returning")
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Kind {
    File,
    Dir,
    Symlink,
    Special,
}

impl Kind {
    fn of(meta: &fs::Metadata) -> Self {
        let t = meta.file_type();
        if t.is_symlink() {
            Kind::Symlink
        } else if t.is_dir() {
            Kind::Dir
        } else if t.is_file() {
            Kind::File
        } else {
            Kind::Special
        }
    }
}

/// What [`claim`] created.
enum Claimed {
    /// An empty file, open for writing.
    File(fs::File),
    Dir,
    Link,
}

/// Creates the destination for `from` at `dest`, failing with
/// `AlreadyExists` if anything is there: an empty file (filled in
/// afterwards through the returned handle), an empty directory, or the
/// finished symlink.
fn claim(from: &Path, dest: &Path, kind: Kind) -> io::Result<Claimed> {
    match kind {
        Kind::File => create_new(dest).map(Claimed::File),
        Kind::Dir => fs::create_dir(dest).map(|()| Claimed::Dir),
        Kind::Symlink => symlink(&fs::read_link(from)?, dest).map(|()| Claimed::Link),
        Kind::Special => unreachable!("rejected earlier"),
    }
}

/// Creates a file that must not exist yet, open for writing.
fn create_new(path: &Path) -> io::Result<fs::File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Copies the contents of `from` and its permissions through `out`, a file
/// this copy just created, so nothing is reopened by name.
fn copy_file(from: &Path, mut out: fs::File) -> io::Result<()> {
    let mut src = fs::File::open(from)?;
    let meta = src.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    io::copy(&mut src, &mut out)?;
    out.set_permissions(meta.permissions())
}

/// Everything a copy has created, so a failed copy removes exactly that and
/// never something somebody else put there meanwhile.
#[derive(Default)]
struct Created {
    /// In creation order; `true` for a directory.
    entries: Vec<(PathBuf, bool)>,
    /// Directory permissions, applied once everything is copied (a read-only
    /// directory could not be filled, or rolled back, otherwise).
    dir_permissions: Vec<(PathBuf, fs::Permissions)>,
}

impl Created {
    fn add_file(&mut self, path: &Path) {
        self.entries.push((path.to_path_buf(), false));
    }

    fn add_dir(&mut self, path: &Path, permissions: fs::Permissions) {
        self.entries.push((path.to_path_buf(), true));
        self.dir_permissions.push((path.to_path_buf(), permissions));
    }

    /// Children before their parents.
    fn apply_dir_permissions(&self) -> io::Result<()> {
        for (path, permissions) in self.dir_permissions.iter().rev() {
            fs::set_permissions(path, permissions.clone())?;
        }
        Ok(())
    }

    /// Removes the entries newest first, files and directories one at a
    /// time: a directory that now holds anything else is left in place.
    fn roll_back(&self) {
        for (path, is_dir) in self.entries.iter().rev() {
            let _ = if *is_dir { fs::remove_dir(path) } else { fs::remove_file(path) };
        }
    }
}

#[cfg(unix)]
fn symlink(target: &Path, dest: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, dest)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _dest: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "copying symlinks is not supported here"))
}

/// Copies what is inside `from` into the existing directory `dest`. Every
/// file and directory is created exclusively and recorded in `created`: a
/// name already taken (two source names that are one on this volume, say)
/// is an error, never an overwrite.
fn copy_dir_contents(from: &Path, dest: &Path, created: &mut Created) -> io::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let target = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&path)?;
        match Kind::of(&meta) {
            Kind::File => {
                let out = create_new(&target)?;
                created.add_file(&target);
                copy_file(&path, out)?;
            }
            Kind::Dir => {
                fs::create_dir(&target)?;
                created.add_dir(&target, meta.permissions());
                copy_dir_contents(&path, &target, created)?;
            }
            Kind::Symlink => {
                symlink(&fs::read_link(&path)?, &target)?;
                created.add_file(&target);
            }
            Kind::Special => {}
        }
    }
    Ok(())
}

/// The name for the `attempt`th try (1 is the original name): "a.txt",
/// "a copy.txt", "a copy 2.txt", ... The extension is the part after the
/// last dot, unless the dot starts the name (".env copy") or the item is a
/// directory.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        out.sort();
        out
    }

    #[test]
    fn copies_a_file_keeping_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("f.txt"), "hello").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(a.join("f.txt"), fs::Permissions::from_mode(0o750)).unwrap();
        }
        let copy = copy_into(&a.join("f.txt"), &b).unwrap();
        assert_eq!(PathBuf::from(&copy), b.join("f.txt"));
        assert_eq!(fs::read_to_string(&copy).unwrap(), "hello");
        assert!(a.join("f.txt").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o750);
        }
    }

    #[test]
    fn copies_a_nested_directory() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("proj");
        fs::create_dir_all(src.join("sub/deep")).unwrap();
        fs::create_dir_all(src.join("empty")).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("sub/deep/b.txt"), "b").unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let copy = PathBuf::from(copy_into(&src, &dest).unwrap());
        assert_eq!(copy, dest.join("proj"));
        assert_eq!(fs::read_to_string(copy.join("a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(copy.join("sub/deep/b.txt")).unwrap(), "b");
        assert!(copy.join("empty").is_dir());
        assert!(src.join("sub/deep/b.txt").exists());
    }

    #[test]
    fn names_clashing_copies_like_finder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "1").unwrap();
        fs::write(root.join("Makefile"), "2").unwrap();
        fs::write(root.join(".env"), "3").unwrap();
        fs::create_dir(root.join("dir.d")).unwrap();

        assert_eq!(copy_into(&root.join("a.txt"), root).unwrap(), root.join("a copy.txt").to_str().unwrap());
        assert_eq!(copy_into(&root.join("a.txt"), root).unwrap(), root.join("a copy 2.txt").to_str().unwrap());
        // Copying a copy: its own name gets the suffix.
        assert_eq!(copy_into(&root.join("a copy.txt"), root).unwrap(), root.join("a copy copy.txt").to_str().unwrap());
        assert_eq!(copy_into(&root.join("Makefile"), root).unwrap(), root.join("Makefile copy").to_str().unwrap());
        assert_eq!(copy_into(&root.join(".env"), root).unwrap(), root.join(".env copy").to_str().unwrap());
        assert_eq!(copy_into(&root.join(".env"), root).unwrap(), root.join(".env copy 2").to_str().unwrap());
        assert_eq!(copy_into(&root.join("dir.d"), root).unwrap(), root.join("dir.d copy").to_str().unwrap());
        assert_eq!(copy_into(&root.join("dir.d"), root).unwrap(), root.join("dir.d copy 2").to_str().unwrap());
        assert_eq!(fs::read_to_string(root.join("a copy 2.txt")).unwrap(), "1");
    }

    #[test]
    fn candidate_names() {
        assert_eq!(candidate_name("a.tar.gz", false, 2), "a.tar copy.gz");
        assert_eq!(candidate_name("a.", false, 2), "a. copy");
        assert_eq!(candidate_name("a.txt", false, 4), "a copy 3.txt");
        assert_eq!(candidate_name("v1.2", true, 3), "v1.2 copy 2");
    }

    #[test]
    fn rejects_copying_a_directory_into_itself() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("inner")).unwrap();
        fs::write(src.join("f"), "x").unwrap();
        assert!(copy_into(&src, &src).is_err());
        assert!(copy_into(&src, &src.join("inner")).is_err());
        // A sibling whose name merely starts the same is fine.
        let other = dir.path().join("src2");
        fs::create_dir(&other).unwrap();
        assert!(copy_into(&src, &other).is_ok());
        // Copying into the parent makes "src copy".
        let copy = copy_into(&src, dir.path()).unwrap();
        assert_eq!(PathBuf::from(copy), dir.path().join("src copy"));
        assert_eq!(names(&src), vec!["f", "inner"]);
    }

    #[test]
    fn rejects_bad_arguments() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f"), "").unwrap();
        assert!(copy_into(&dir.path().join("missing"), dir.path()).is_err());
        assert!(copy_into(&dir.path().join("f"), &dir.path().join("f")).is_err());
        assert!(copy_into(&dir.path().join("f"), &dir.path().join("nodir")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn copies_symlinks_as_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let src = root.join("src");
        fs::create_dir_all(src.join("real")).unwrap();
        fs::write(src.join("real/f"), "x").unwrap();
        std::os::unix::fs::symlink("real", src.join("dirlink")).unwrap();
        std::os::unix::fs::symlink("missing", src.join("broken")).unwrap();
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();

        let copy = PathBuf::from(copy_into(&src, &dest).unwrap());
        for link in ["dirlink", "broken"] {
            assert!(fs::symlink_metadata(copy.join(link)).unwrap().file_type().is_symlink());
        }
        assert_eq!(fs::read_link(copy.join("dirlink")).unwrap(), Path::new("real"));
        assert_eq!(fs::read_link(copy.join("broken")).unwrap(), Path::new("missing"));

        // A link at the top level is copied as a link too, even a dangling one.
        let top = PathBuf::from(copy_into(&src.join("dirlink"), &dest).unwrap());
        assert!(fs::symlink_metadata(&top).unwrap().file_type().is_symlink());
        let top = PathBuf::from(copy_into(&src.join("broken"), &dest).unwrap());
        assert_eq!(fs::read_link(top).unwrap(), Path::new("missing"));
    }

    #[test]
    fn a_clash_inside_a_tree_is_an_error_and_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a"), "a").unwrap();
        fs::write(src.join("clash"), "from source").unwrap();
        fs::write(src.join("sub/x"), "x").unwrap();
        let target = dir.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("clash"), "foreign").unwrap();

        let mut created = Created::default();
        let err = copy_dir_contents(&src, &target, &mut created).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(target.join("clash")).unwrap(), "foreign");
        assert!(!created.entries.iter().any(|(p, _)| p == &target.join("clash")));
        created.roll_back();
        assert_eq!(names(&target), vec!["clash"]);
        assert_eq!(fs::read_to_string(target.join("clash")).unwrap(), "foreign");
    }

    #[test]
    fn rolling_back_leaves_foreign_files_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let (made, sub) = (dir.path().join("made"), dir.path().join("made/sub"));
        fs::create_dir_all(&sub).unwrap();
        fs::write(made.join("a"), "a").unwrap();
        fs::write(sub.join("b"), "b").unwrap();
        fs::write(sub.join("foreign"), "keep").unwrap();
        let mut created = Created::default();
        created.add_dir(&made, fs::metadata(&made).unwrap().permissions());
        created.add_file(&made.join("a"));
        created.add_dir(&sub, fs::metadata(&sub).unwrap().permissions());
        created.add_file(&sub.join("b"));
        created.roll_back();
        assert_eq!(names(&made), vec!["sub"]);
        assert_eq!(names(&sub), vec!["foreign"]);
        assert_eq!(fs::read_to_string(sub.join("foreign")).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn removes_a_partial_copy_on_failure() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a"), "a").unwrap();
        fs::write(src.join("unreadable"), "b").unwrap();
        fs::set_permissions(src.join("unreadable"), fs::Permissions::from_mode(0o000)).unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let result = copy_into(&src, &dest);
        fs::set_permissions(src.join("unreadable"), fs::Permissions::from_mode(0o644)).unwrap();
        // Running as root, the file is readable and the copy succeeds.
        if result.is_err() {
            assert!(names(&dest).is_empty(), "partial copy left behind: {:?}", names(&dest));
        }
    }
}
