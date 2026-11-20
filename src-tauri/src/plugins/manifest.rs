//! `manifest.json` of an imported plugin: parsing and validation.
//!
//! Validation is against the plugin's folder: every path the manifest names
//! must be relative, stay inside the folder (also after resolving symlinks)
//! and name an existing file of the right kind.

use std::fs;
use std::io::Read;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

/// The file every plugin folder has at its root.
pub const MANIFEST_FILE: &str = "manifest.json";
/// The only plugin API version this build of Midterm supports.
pub const API_VERSION: u64 = 1;
/// Pane kinds of built-in plugins (and the app's own name): an imported
/// plugin cannot take these ids.
pub const RESERVED_IDS: &[&str] = &[
    "terminal",
    "block-terminal",
    "explorer",
    "editor",
    "viewer",
    "theme-editor",
    "midterm",
];
/// A manifest larger than this is refused (bytes).
const MANIFEST_LIMIT: u64 = 1024 * 1024;

/// A validated manifest, as `PluginManifest` in the frontend. Optional
/// fields are left out of the JSON when absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u64,
    /// The ES module, relative to the plugin folder (`/`-separated).
    pub main: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// `SKILL.md` files, relative to the plugin folder. Always present.
    pub skills: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

/// `manifest.json` as written; unknown fields are ignored. Fields are
/// loosely typed so that a missing or mistyped one gets a clear message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    id: Option<serde_json::Value>,
    name: Option<serde_json::Value>,
    version: Option<serde_json::Value>,
    api_version: Option<serde_json::Value>,
    main: Option<serde_json::Value>,
    style: Option<serde_json::Value>,
    skills: Option<serde_json::Value>,
    description: Option<serde_json::Value>,
    author: Option<serde_json::Value>,
}

/// Whether `id` has the shape of a plugin id, `^[a-z0-9][a-z0-9-]{0,62}$`
/// (so it is also a safe folder name). Reserved ids pass this check.
pub fn is_valid_id_format(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Checks an id an imported plugin may use: the right shape and not reserved.
pub fn check_id(id: &str) -> Result<(), String> {
    if !is_valid_id_format(id) {
        return Err(format!(
            "invalid id \"{id}\": use 1 to 63 lowercase letters, digits and hyphens, starting with a letter or digit"
        ));
    }
    if RESERVED_IDS.contains(&id) {
        return Err(format!("the id \"{id}\" is reserved for a built-in plugin"));
    }
    Ok(())
}

/// Semver-like: starts with a digit; digits, letters, `.`, `-` and `+` only.
fn is_valid_version(version: &str) -> bool {
    version.len() <= 64
        && version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

/// Reads and validates `<dir>/manifest.json`.
pub fn load(dir: &Path) -> Result<Manifest, String> {
    let path = dir.join(MANIFEST_FILE);
    let file = fs::File::open(&path).map_err(|e| format!("cannot read {MANIFEST_FILE}: {e}"))?;
    let mut text = String::new();
    file.take(MANIFEST_LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("cannot read {MANIFEST_FILE}: {e}"))?;
    if text.len() as u64 > MANIFEST_LIMIT {
        return Err(format!("{MANIFEST_FILE} is too large"));
    }
    parse(&text, dir)
}

/// Parses and validates manifest JSON for the plugin folder `dir`.
pub fn parse(json: &str, dir: &Path) -> Result<Manifest, String> {
    let raw: RawManifest =
        serde_json::from_str(json).map_err(|e| format!("{MANIFEST_FILE} is not valid JSON: {e}"))?;
    let root = dir
        .canonicalize()
        .map_err(|e| format!("cannot open the plugin folder: {e}"))?;

    let id = required_string(raw.id, "id")?;
    check_id(&id)?;
    let name = required_string(raw.name, "name")?;
    let version = required_string(raw.version, "version")?;
    if !is_valid_version(&version) {
        return Err(format!("invalid version \"{version}\": use a semantic version such as 1.0.0"));
    }
    let api_version = match raw.api_version {
        None | Some(serde_json::Value::Null) => return Err("apiVersion is missing".into()),
        Some(value) => match value.as_u64() {
            Some(API_VERSION) => API_VERSION,
            Some(n) => {
                return Err(format!(
                    "apiVersion {n} is not supported: this version of Midterm supports apiVersion {API_VERSION}"
                ));
            }
            None => return Err(format!("apiVersion must be an integer (currently {API_VERSION}), not {value}")),
        },
    };
    let main = required_string(raw.main, "main")?;
    check_file(&root, &main, "main", &["js", "mjs"])?;
    let style = optional_string(raw.style, "style")?;
    if let Some(style) = &style {
        check_file(&root, style, "style", &["css"])?;
    }
    let skills = match raw.skills {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => items
            .into_iter()
            .map(|item| match item {
                serde_json::Value::String(path) => {
                    check_skill(&root, &path)?;
                    Ok(path)
                }
                other => Err(format!("skills must list paths as strings, not {other}")),
            })
            .collect::<Result<_, String>>()?,
        Some(other) => return Err(format!("skills must be an array of paths, not {other}")),
    };
    Ok(Manifest {
        id,
        name,
        version,
        api_version,
        main,
        style,
        skills,
        description: optional_string(raw.description, "description")?,
        author: optional_string(raw.author, "author")?,
    })
}

fn required_string(value: Option<serde_json::Value>, field: &str) -> Result<String, String> {
    match optional_string(value, field)? {
        Some(s) if !s.trim().is_empty() => Ok(s),
        Some(_) => Err(format!("{field} must not be empty")),
        None => Err(format!("{field} is missing")),
    }
}

fn optional_string(value: Option<serde_json::Value>, field: &str) -> Result<Option<String>, String> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s)),
        Some(other) => Err(format!("{field} must be a string, not {other}")),
    }
}

/// Whether `rel` is a plain relative path: `/`-separated normal components
/// only (no absolute path, drive, `.`, `..`, backslash or empty segment).
pub fn is_plain_relative(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains(['\\', '\0', ':'])
        && rel.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
        && Path::new(rel).components().all(|c| matches!(c, Component::Normal(_)))
}

/// Checks that `rel` names an existing file inside the canonical folder
/// `root`, with one of `extensions` (lowercase, compared ignoring case).
fn check_file(root: &Path, rel: &str, field: &str, extensions: &[&str]) -> Result<(), String> {
    if !is_plain_relative(rel) {
        return Err(format!(
            "{field} \"{rel}\" must be a relative path inside the plugin folder (no \"..\", no leading \"/\")"
        ));
    }
    let ext_ok = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| extensions.iter().any(|x| e.eq_ignore_ascii_case(x)));
    if !ext_ok {
        let list = extensions.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(" or ");
        return Err(format!("{field} \"{rel}\" must be a {list} file"));
    }
    let resolved = root
        .join(rel)
        .canonicalize()
        .map_err(|_| format!("{field} \"{rel}\" does not exist"))?;
    if !resolved.starts_with(root) {
        return Err(format!("{field} \"{rel}\" points outside the plugin folder"));
    }
    if !resolved.is_file() {
        return Err(format!("{field} \"{rel}\" is not a file"));
    }
    Ok(())
}

fn check_skill(root: &Path, rel: &str) -> Result<(), String> {
    check_file(root, rel, "skill", &["md"])?;
    if Path::new(rel).file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return Err(format!("skill \"{rel}\" must be a file named SKILL.md (skills/<id>/SKILL.md)"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A plugin folder with `main.js`, `style.css` and one skill.
    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.js"), "export default {}").unwrap();
        fs::write(dir.path().join("style.css"), "").unwrap();
        fs::create_dir_all(dir.path().join("skills/hello")).unwrap();
        fs::write(dir.path().join("skills/hello/SKILL.md"), "# Hello").unwrap();
        dir
    }

    fn base() -> serde_json::Value {
        json!({ "id": "hello", "name": "Hello", "version": "1.0.0", "apiVersion": 1, "main": "main.js" })
    }

    fn check(value: serde_json::Value) -> Result<Manifest, String> {
        let dir = folder();
        parse(&value.to_string(), dir.path())
    }

    fn with(key: &str, value: serde_json::Value) -> serde_json::Value {
        let mut m = base();
        m[key] = value;
        m
    }

    #[test]
    fn accepts_a_full_manifest_and_ignores_unknown_fields() {
        let mut m = base();
        m["style"] = json!("style.css");
        m["skills"] = json!(["skills/hello/SKILL.md"]);
        m["description"] = json!("Says hello");
        m["author"] = json!("Someone");
        m["homepage"] = json!("https://example.com");
        let manifest = check(m).unwrap();
        assert_eq!(manifest.id, "hello");
        assert_eq!(manifest.style.as_deref(), Some("style.css"));
        assert_eq!(manifest.skills, vec!["skills/hello/SKILL.md"]);
        let out = serde_json::to_value(&manifest).unwrap();
        assert_eq!(out["apiVersion"], 1);
        assert!(out.get("homepage").is_none());
    }

    #[test]
    fn minimal_manifest_serializes_without_optional_fields() {
        let out = serde_json::to_value(check(base()).unwrap()).unwrap();
        assert!(out.get("style").is_none());
        assert_eq!(out["skills"], json!([]));
    }

    #[test]
    fn ids() {
        for good in ["a", "0", "my-plugin", "x1-2-3", &"a".repeat(63)] {
            assert!(check(with("id", json!(good))).is_ok(), "{good}");
        }
        for bad in ["", "-a", "My", "a_b", "a.b", "a/b", "..", "ä", &"a".repeat(64)] {
            assert!(check(with("id", json!(bad))).is_err(), "{bad}");
        }
        for reserved in RESERVED_IDS {
            let err = check(with("id", json!(reserved))).unwrap_err();
            assert!(err.contains("reserved"), "{err}");
        }
        assert!(check(with("id", json!(5))).is_err());
    }

    #[test]
    fn required_fields() {
        for key in ["id", "name", "version", "apiVersion", "main"] {
            let mut m = base();
            m.as_object_mut().unwrap().remove(key);
            let err = check(m).unwrap_err();
            assert!(err.contains(key), "{key}: {err}");
        }
        assert!(check(with("name", json!("  "))).is_err());
        assert!(check(with("version", json!(""))).is_err());
        assert!(check(json!([1])).is_err());
        assert!(parse("{", folder().path()).is_err());
    }

    #[test]
    fn versions() {
        for good in ["1", "0.1.0", "1.2.3-beta.1+build5"] {
            assert!(check(with("version", json!(good))).is_ok(), "{good}");
        }
        for bad in ["v1", "1 0", "latest"] {
            assert!(check(with("version", json!(bad))).is_err(), "{bad}");
        }
        assert!(check(with("version", json!(1))).is_err());
    }

    #[test]
    fn api_version() {
        let err = check(with("apiVersion", json!(2))).unwrap_err();
        assert!(err.contains("apiVersion 2 is not supported"), "{err}");
        assert!(check(with("apiVersion", json!(0))).is_err());
        assert!(check(with("apiVersion", json!("1"))).is_err());
        assert!(check(with("apiVersion", json!(1.5))).is_err());
        assert!(check(with("apiVersion", json!(-1))).is_err());
    }

    #[test]
    fn main_and_style_paths() {
        let dir = folder();
        fs::create_dir(dir.path().join("dist")).unwrap();
        fs::write(dir.path().join("dist/index.mjs"), "").unwrap();
        let mut m = with("main", json!("dist/index.mjs"));
        assert!(parse(&m.to_string(), dir.path()).is_ok());
        m["main"] = json!("dist/../main.js");
        assert!(parse(&m.to_string(), dir.path()).is_err());

        for bad in ["/etc/passwd.js", "../main.js", "./main.js", "missing.js", "style.css", "", "a\\main.js", "C:main.js"] {
            assert!(check(with("main", json!(bad))).is_err(), "{bad}");
        }
        for bad in ["../style.css", "main.js", "nope.css", "/style.css"] {
            assert!(check(with("style", json!(bad))).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_directory_is_not_a_file() {
        let dir = folder();
        fs::create_dir(dir.path().join("dir.js")).unwrap();
        assert!(parse(&with("main", json!("dir.js")).to_string(), dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_escaping_the_folder_are_refused() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("evil.js"), "").unwrap();
        let dir = folder();
        std::os::unix::fs::symlink(outside.path().join("evil.js"), dir.path().join("link.js")).unwrap();
        let err = parse(&with("main", json!("link.js")).to_string(), dir.path()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        // A symlink within the folder is fine.
        std::os::unix::fs::symlink(dir.path().join("main.js"), dir.path().join("inner.js")).unwrap();
        assert!(parse(&with("main", json!("inner.js")).to_string(), dir.path()).is_ok());
    }

    #[test]
    fn skills_paths() {
        assert!(check(with("skills", json!([]))).is_ok());
        for bad in [
            json!("skills/hello/SKILL.md"),
            json!([1]),
            json!(["../SKILL.md"]),
            json!(["/skills/hello/SKILL.md"]),
            json!(["skills/missing/SKILL.md"]),
            json!(["main.js"]),
        ] {
            assert!(check(with("skills", bad.clone())).is_err(), "{bad}");
        }
        let dir = folder();
        fs::write(dir.path().join("skills/hello/notes.md"), "").unwrap();
        let m = with("skills", json!(["skills/hello/notes.md"]));
        assert!(parse(&m.to_string(), dir.path()).unwrap_err().contains("SKILL.md"));
    }

    #[test]
    fn plain_relative_paths() {
        assert!(is_plain_relative("a/b.js"));
        for bad in ["", "/a", "a//b", "a/", "./a", "a/../b", "..", "a\\b", "C:/a"] {
            assert!(!is_plain_relative(bad), "{bad}");
        }
    }
}
