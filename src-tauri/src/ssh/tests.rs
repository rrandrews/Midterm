//! End-to-end integration tests for the SSH remote backend against an
//! ephemeral unprivileged localhost `sshd` and real OpenSSH ControlMaster
//! multiplexing.

use std::fs;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use crate::fs::file::{BYTES_LIMIT, TEXT_LIMIT, TextFile, WriteExpect, WriteResult};
use crate::fs::git::GitCode;
use crate::fs::list::EntryKind;
use crate::fs::search::{TextSearchEvent, TextSearchOptions};

use super::SshManager;
use super::location::Location;
use super::registry::{RegisterSshConnection, SshStatus};
use super::transfer::copy_cross_host;

/// Ephemeral localhost `sshd` + live OpenSSH ControlMaster socket.
struct TestSshd {
    _tmp: tempfile::TempDir,
    sshd: Child,
    control_path: PathBuf,
    port: u16,
    user_key: PathBuf,
    remote_id: String,
    ssh_args: Vec<String>,
}

impl TestSshd {
    fn start(ssh: &SshManager) -> Option<Self> {
        let sshd_bin = ["/usr/sbin/sshd", "/usr/bin/sshd"]
            .into_iter()
            .find(|p| Path::new(p).is_file())?;

        // Keep tmp dir short (under /tmp) so ControlPath stays well under macOS 104-byte sun_path.
        let tmp = tempfile::Builder::new()
            .prefix("mt-t-")
            .tempdir_in("/tmp")
            .ok()?;
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).ok()?;

        let host_key = tmp.path().join("hk");
        let user_key = tmp.path().join("uk");
        for key in [&host_key, &user_key] {
            let status = Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(key)
                .status()
                .ok()?;
            assert!(status.success(), "ssh-keygen failed");
        }
        let pub_key = fs::read_to_string(user_key.with_extension("pub")).ok()?;
        let auth_keys = tmp.path().join("ak");
        fs::write(&auth_keys, pub_key).ok()?;
        fs::set_permissions(&auth_keys, fs::Permissions::from_mode(0o600)).ok()?;

        let listener = TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        drop(listener);

        let cfg_path = tmp.path().join("sshd_config");
        let cfg = format!(
            "Port {port}\n\
             ListenAddress 127.0.0.1\n\
             HostKey {}\n\
             AuthorizedKeysFile {}\n\
             StrictModes no\n\
             UsePAM no\n\
             PasswordAuthentication no\n\
             KbdInteractiveAuthentication no\n\
             PubkeyAuthentication yes\n\
             PidFile {}\n",
            host_key.display(),
            auth_keys.display(),
            tmp.path().join("sshd.pid").display()
        );
        fs::write(&cfg_path, cfg).ok()?;

        let sshd = Command::new(sshd_bin)
            .args(["-D", "-e", "-f"])
            .arg(&cfg_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        // Wait until sshd listens.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }

        let sock_dir = ssh.socket_dir().expect("socket dir");
        let remote_id = format!("testbox-{}-{port}", std::process::id());
        let control_path = sock_dir.join(super::socket_filename_for(&remote_id));
        let _ = fs::remove_file(&control_path);

        // Full args used directly by test harness to establish initial ControlMaster.
        let master_args = vec![
            "-F".into(),
            "/dev/null".into(),
            "-o".into(),
            "StrictHostKeyChecking=no".into(),
            "-o".into(),
            "UserKnownHostsFile=/dev/null".into(),
            "-i".into(),
            user_key.to_string_lossy().into_owned(),
            "-p".into(),
            port.to_string(),
            "127.0.0.1".into(),
        ];

        // Allowlisted safe args registered with SshManager.
        let ssh_args = vec![
            "-i".into(),
            user_key.to_string_lossy().into_owned(),
            "-p".into(),
            port.to_string(),
            "127.0.0.1".into(),
        ];

        // Start a ControlMaster background connection.
        let out = Command::new("ssh")
            .args(["-o", "ControlMaster=auto"])
            .arg("-o")
            .arg(format!("ControlPath={}", control_path.display()))
            .args(["-o", "ControlPersist=60s", "-o", "BatchMode=yes", "-N", "-f"])
            .args(&master_args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .ok()?;
        assert!(
            out.status.success(),
            "ssh ControlMaster failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        Some(Self {
            _tmp: tmp,
            sshd,
            control_path,
            port,
            user_key,
            remote_id,
            ssh_args,
        })
    }

    async fn register(&self, ssh: &SshManager) {
        let info = ssh
            .register(RegisterSshConnection {
                id: self.remote_id.clone(),
                label: "testbox".into(),
                host: "127.0.0.1".into(),
                user: std::env::var("USER").unwrap_or_else(|_| "me".into()),
                port: self.port,
                control_path: self.control_path.to_string_lossy().into_owned(),
                owned_socket: true,
                ssh_args: self.ssh_args.clone(),
            })
            .await
            .expect("register failed");
        assert_eq!(info.id, self.remote_id);
        let _ = &self.user_key;
    }
}

impl Drop for TestSshd {
    fn drop(&mut self) {
        let _ = Command::new("ssh")
            .args(["-F", "/dev/null", "-S"])
            .arg(&self.control_path)
            .args(["-O", "exit", "placeholder"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.sshd.kill();
        let _ = self.sshd.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_to_end_remote_fs_git_search_watch_complete_and_cross_copy() {
    let ssh = SshManager::default();
    let Some(env) = TestSshd::start(&ssh) else {
        eprintln!("skipping SSH integration test: sshd unavailable");
        return;
    };
    env.register(&ssh).await;
    let rid = &env.remote_id;

    // Create a workspace fixture directory on the "remote" (localhost).
    let work = tempfile::tempdir().unwrap();
    let root = work.path();
    let root_s = root.to_string_lossy().into_owned();

    // 1. list_dir + .gitignore + .ignore + symlinks + sorting
    let mut git_opts = git2::RepositoryInitOptions::new();
    git_opts.initial_head("main");
    let repo = git2::Repository::init_opts(root, &git_opts).unwrap();
    fs::write(root.join(".gitignore"), "*.ignored\nbuild/\n").unwrap();
    fs::write(root.join(".ignore"), "skipme.txt\n").unwrap();
    fs::create_dir_all(root.join("build")).unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/app.ts"), "const greeting = 'héllo 😀 target';\n").unwrap();
    fs::write(root.join("README.md"), "# Hello\nfindme here\n").unwrap();
    fs::write(root.join("junk.ignored"), "findme ignored\n").unwrap();
    fs::write(root.join("skipme.txt"), "findme dot-ignored\n").unwrap();
    fs::write(root.join(".env"), "SECRET=1\n").unwrap();
    std::os::unix::fs::symlink(root.join("src"), root.join("src-link")).unwrap();
    std::os::unix::fs::symlink(root.join("nowhere"), root.join("broken-link")).unwrap();

    let visible = ssh.list_dir(rid, &root_s, false).await.unwrap();
    let names: Vec<&str> = visible.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["src", "src-link", "broken-link", "README.md"]);
    assert_eq!(
        visible[0].path,
        Location::format_remote(rid, &root.join("src").to_string_lossy())
    );
    assert!(visible.iter().find(|e| e.name == "src-link").unwrap().symlink);
    assert_eq!(visible.iter().find(|e| e.name == "src-link").unwrap().kind, EntryKind::Dir);
    assert_eq!(visible.iter().find(|e| e.name == "broken-link").unwrap().kind, EntryKind::File);

    let all = ssh.list_dir(rid, &root_s, true).await.unwrap();
    assert!(all.iter().find(|e| e.name == ".git").unwrap().ignored);
    assert!(all.iter().find(|e| e.name == "build").unwrap().ignored);
    assert!(all.iter().find(|e| e.name == "junk.ignored").unwrap().ignored);
    assert!(all.iter().find(|e| e.name == "skipme.txt").unwrap().ignored);
    assert!(all.iter().find(|e| e.name == ".env").unwrap().hidden);
    assert!(!all.iter().find(|e| e.name == ".env").unwrap().ignored);

    // 2. stat
    let st = ssh.stat(rid, &root.join("README.md").to_string_lossy()).await.unwrap().unwrap();
    assert_eq!(st.name, "README.md");
    assert_eq!(st.kind, EntryKind::File);
    assert_eq!(
        ssh.stat(rid, &root.join("does-not-exist").to_string_lossy()).await.unwrap(),
        None
    );

    // 3. create, rename (no-replace + case-only), copy_into (Finder names + self-copy guard), delete
    let created_file = root.join("created.txt");
    ssh.create(rid, &created_file.to_string_lossy(), false).await.unwrap();
    assert!(created_file.is_file());
    assert!(ssh.create(rid, &created_file.to_string_lossy(), false).await.is_err());

    let renamed = root.join("renamed.txt");
    ssh.rename(rid, &created_file.to_string_lossy(), &renamed.to_string_lossy()).await.unwrap();
    assert!(renamed.is_file());
    // Refuses to replace existing file
    assert!(ssh.rename(rid, &renamed.to_string_lossy(), &root.join("README.md").to_string_lossy()).await.is_err());
    // Case-only rename works
    let upper = root.join("RENAMED.TXT");
    ssh.rename(rid, &renamed.to_string_lossy(), &upper.to_string_lossy()).await.unwrap();
    let upper_names: Vec<_> = fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(upper_names.iter().any(|n| n == "RENAMED.TXT"));

    // copy_into: Finder naming + self-copy refusal
    let copy1 = ssh.copy_into(rid, &root.join("README.md").to_string_lossy(), &root_s).await.unwrap();
    assert_eq!(copy1, Location::format_remote(rid, &root.join("README copy.md").to_string_lossy()));
    let copy2 = ssh.copy_into(rid, &root.join("README.md").to_string_lossy(), &root_s).await.unwrap();
    assert_eq!(copy2, Location::format_remote(rid, &root.join("README copy 2.md").to_string_lossy()));
    assert!(ssh.copy_into(rid, &root.join("src").to_string_lossy(), &root.join("src").to_string_lossy()).await.is_err());
    // Symlink into src also caught by inode ancestor check!
    assert!(ssh.copy_into(rid, &root.join("src").to_string_lossy(), &root.join("src-link").to_string_lossy()).await.is_err());

    // delete: refuses filesystem root, unlinks symlink-to-root without traversing, deletes normal files
    assert!(ssh.delete(rid, &["/".into()]).await.is_err());
    assert!(ssh.delete(rid, &["///".into()]).await.is_err());
    let root_link = root.join("link-to-root");
    std::os::unix::fs::symlink("/", &root_link).unwrap();
    ssh.delete(rid, &[root_link.to_string_lossy().into_owned()])
        .await
        .unwrap();
    assert!(!root_link.exists() && fs::symlink_metadata(&root_link).is_err());

    ssh.delete(
        rid,
        &[
            root.join("README copy.md").to_string_lossy().into_owned(),
            root.join("README copy 2.md").to_string_lossy().into_owned(),
            upper.to_string_lossy().into_owned(),
        ],
    )
    .await
    .unwrap();
    assert!(!root.join("README copy.md").exists());

    // 4. read_text, read_bytes, write_text (version check, conflict, atomic, symlink write-through)
    let app_path = root.join("src/app.ts");
    let app_s = app_path.to_string_lossy().into_owned();
    let TextFile::Text { text, version: v1 } = ssh.read_text(rid, &app_s, TEXT_LIMIT).await.unwrap() else {
        panic!("expected text");
    };
    assert_eq!(text, "const greeting = 'héllo 😀 target';\n");
    assert_eq!(ssh.file_version(rid, &app_s).await.unwrap(), Some(v1.clone()));

    // Conflict when expecting wrong version
    let stale = crate::fs::file::FileVersion { mtime: "1".into(), size: v1.size };
    let conflict = ssh
        .write_text(rid, &app_s, "nope", &WriteExpect::Version { version: stale })
        .await
        .unwrap();
    assert!(matches!(conflict, WriteResult::Conflict { current: Some(_) }));

    // Valid optimistic save
    let WriteResult::Written { version: v2 } = ssh
        .write_text(
            rid,
            &app_s,
            "const greeting = 'updated target';\n",
            &WriteExpect::Version { version: v1 },
        )
        .await
        .unwrap()
    else {
        panic!("expected written");
    };
    assert_eq!(fs::read_to_string(&app_path).unwrap(), "const greeting = 'updated target';\n");
    assert_eq!(ssh.file_version(rid, &app_s).await.unwrap(), Some(v2));

    // Binary file detection + raw read_bytes
    let bin_path = root.join("data.bin");
    fs::write(&bin_path, b"\x89PNG\r\n\x1a\n\x00binary").unwrap();
    assert!(matches!(
        ssh.read_text(rid, &bin_path.to_string_lossy(), TEXT_LIMIT).await.unwrap(),
        TextFile::Binary { .. }
    ));
    let raw_bytes = ssh.read_bytes(rid, &bin_path.to_string_lossy(), BYTES_LIMIT).await.unwrap();
    assert_eq!(raw_bytes, b"\x89PNG\r\n\x1a\n\x00binary");

    // 5. git_status (unborn branch + staged + modified + untracked)
    let gs0 = ssh.git_status(rid, &root_s).await.unwrap().unwrap();
    assert_eq!(gs0.branch.as_deref(), Some("main"));
    assert_eq!(gs0.root, Location::format_remote(rid, &root_s));
    assert_eq!(gs0.entries.get("README.md"), Some(&GitCode::Untracked));
    // Commit README.md then modify it to test M status
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("README.md")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
    }
    fs::write(root.join("README.md"), "# Hello updated\nfindme here\n").unwrap();
    let gs1 = ssh.git_status(rid, &root.join("src").to_string_lossy()).await.unwrap().unwrap();
    assert_eq!(gs1.root, Location::format_remote(rid, &root_s));
    assert_eq!(gs1.branch.as_deref(), Some("main"));
    assert_eq!(gs1.entries.get("README.md"), Some(&GitCode::Modified));

    // 6. find_files & find_entries
    let found_files = ssh.find_files(rid, &root_s, 100).await.unwrap();
    assert!(found_files.paths.contains(&"README.md".to_string()));
    assert!(found_files.paths.contains(&"src/app.ts".to_string()));
    assert!(!found_files.paths.iter().any(|p| p.contains("junk.ignored")));
    assert!(!found_files.paths.iter().any(|p| p.contains("skipme.txt")));

    let found_entries = ssh.find_entries(rid, &root_s, 100, true).await.unwrap();
    assert!(found_entries.entries.iter().any(|e| e.path == ".git" && e.dir));
    assert!(!found_entries.entries.iter().any(|e| e.path.starts_with(".git/")));

    // 7. streaming text search
    let (stx, srx) = mpsc::channel();
    ssh.start_search(
        1,
        "test",
        rid.clone(),
        root_s.clone(),
        TextSearchOptions {
            query: "findme".into(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            show_hidden: false,
            max_results: 100,
        },
        Arc::new(move |ev| {
            let _ = stx.send(ev);
        }),
    );
    let mut matched_paths = Vec::new();
    let mut got_done = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(ev) = srx.recv_timeout(Duration::from_millis(200)) {
            match ev {
                TextSearchEvent::Files { files } => {
                    for f in files {
                        matched_paths.push(f.path);
                    }
                }
                TextSearchEvent::Done { cancelled, .. } => {
                    assert!(!cancelled);
                    got_done = true;
                    break;
                }
                TextSearchEvent::Error { message } => panic!("unexpected search error: {message}"),
            }
        }
    }
    assert!(got_done);
    assert_eq!(matched_paths, vec!["README.md".to_string()]);

    // 8. remote directory watching (real event)
    let (wtx, wrx) = mpsc::channel();
    ssh.register_watch(
        1,
        "test",
        Arc::new(move |dirs| {
            let _ = wtx.send(dirs);
        }),
    );
    let mut by_remote = std::collections::HashMap::new();
    by_remote.insert(rid.clone(), vec![root_s.clone()]);
    ssh.set_watch_dirs(1, by_remote);
    tokio::time::sleep(Duration::from_millis(250)).await;
    fs::write(root.join("watched-new.txt"), "ping").unwrap();
    let expected_watch_dir = Location::format_remote(rid, &root_s);
    let watch_deadline = Instant::now() + Duration::from_secs(6);
    let mut saw_watch = false;
    while Instant::now() < watch_deadline {
        if let Ok(dirs) = wrx.recv_timeout(Duration::from_millis(200))
            && dirs.contains(&expected_watch_dir)
        {
            saw_watch = true;
            break;
        }
    }
    assert!(saw_watch, "did not receive remote watch event for {expected_watch_dir}");
    // 8b. Lazy helper replacement must restore active watches automatically.
    {
        let client_before = ssh.client(rid).await.unwrap();
        let id_before = client_before.client_id;
        client_before.close().await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        // Lazily trigger a new helper via ordinary stat() (not explicit reconnect).
        let _ = ssh.stat(rid, &root_s).await.unwrap();
        let client_after = ssh.client(rid).await.unwrap();
        assert_ne!(id_before, client_after.client_id);
        // Drain any stale watch messages, wait briefly for reconciler, then trigger a change.
        tokio::time::sleep(Duration::from_millis(300)).await;
        while wrx.try_recv().is_ok() {}
        fs::write(root.join("watched-after-lazy-restart.txt"), "ping2").unwrap();
        let lazy_deadline = Instant::now() + Duration::from_secs(6);
        let mut saw_after_restart = false;
        while Instant::now() < lazy_deadline {
            if let Ok(dirs) = wrx.recv_timeout(Duration::from_millis(200))
                && dirs.contains(&expected_watch_dir)
            {
                saw_after_restart = true;
                break;
            }
        }
        assert!(
            saw_after_restart,
            "watch was not restored after lazy helper replacement"
        );
    }
    ssh.stop_watch(1);

    // 8c. Immediate cancel retains cancellation state through startup.
    {
        let (ctx, crx) = mpsc::channel();
        ssh.start_search(
            2,
            "test",
            rid.clone(),
            root_s.clone(),
            TextSearchOptions {
                query: "findme".into(),
                regex: false,
                case_sensitive: false,
                whole_word: false,
                show_hidden: false,
                max_results: 100,
            },
            Arc::new(move |ev| {
                let _ = ctx.send(ev);
            }),
        );
        ssh.cancel_search(2);
        let c_deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_done = false;
        while Instant::now() < c_deadline {
            if let Ok(TextSearchEvent::Done { cancelled, .. }) =
                crx.recv_timeout(Duration::from_millis(200))
            {
                assert!(cancelled);
                saw_done = true;
                break;
            }
        }
        assert!(saw_done, "cancelled search did not emit Done");
    }

    // 9. completion: complete_list & path_commands
    let bin_dir = root.join("mybin");
    fs::create_dir(&bin_dir).unwrap();
    let tool = bin_dir.join("my-remote-tool");
    fs::write(&tool, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
    let cmds = ssh
        .path_commands(rid, Some(&bin_dir.to_string_lossy()))
        .await
        .unwrap();
    assert_eq!(cmds, vec!["my-remote-tool".to_string()]);
    let clist = ssh.complete_list(rid, &bin_dir.to_string_lossy()).await.unwrap();
    assert_eq!(clist.len(), 1);
    assert!(clist[0].executable && !clist[0].dir);

    // 10. cross-host copy (Local -> Remote and Remote -> Local, including multi-chunk > 1 MiB + private perms)
    let local_dir = tempfile::tempdir().unwrap();
    let local_src = local_dir.path().join("upload.bin");
    let big_payload: Vec<u8> = (0..(1200 * 1024)).map(|i| (i % 251) as u8).collect();
    fs::write(&local_src, &big_payload).unwrap();
    fs::set_permissions(&local_src, fs::Permissions::from_mode(0o600)).unwrap();
    let uploaded = copy_cross_host(
        &ssh,
        &Location::Local(local_src),
        &Location::Remote { remote_id: rid.clone(), path: root_s.clone() },
    )
    .await
    .unwrap();
    assert_eq!(uploaded, Location::format_remote(rid, &root.join("upload.bin").to_string_lossy()));
    assert_eq!(fs::read(root.join("upload.bin")).unwrap(), big_payload);
    assert_eq!(
        fs::metadata(root.join("upload.bin")).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let downloaded_file = copy_cross_host(
        &ssh,
        &Location::Remote { remote_id: rid.clone(), path: root.join("upload.bin").to_string_lossy().into_owned() },
        &Location::Local(local_dir.path().to_path_buf()),
    )
    .await
    .unwrap();
    assert_eq!(downloaded_file, local_dir.path().join("upload copy.bin").to_string_lossy());
    assert_eq!(fs::read(local_dir.path().join("upload copy.bin")).unwrap(), big_payload);
    assert_eq!(
        fs::metadata(local_dir.path().join("upload copy.bin")).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let downloaded = copy_cross_host(
        &ssh,
        &Location::Remote { remote_id: rid.clone(), path: root.join("src").to_string_lossy().into_owned() },
        &Location::Local(local_dir.path().to_path_buf()),
    )
    .await
    .unwrap();
    assert_eq!(downloaded, local_dir.path().join("src").to_string_lossy());
    assert_eq!(
        fs::read_to_string(local_dir.path().join("src/app.ts")).unwrap(),
        "const greeting = 'updated target';\n"
    );

    // Connection list reflects Connected + discovered remote_home/remote_os.
    let list = ssh.list().await;
    let conn = list.iter().find(|c| c.id == *rid).unwrap();
    assert_eq!(conn.status, SshStatus::Connected);
    assert!(conn.remote_home.is_some());
    assert!(conn.remote_os.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_to_end_shell_fallback_preserves_newlines_versions_and_limits() {
    let ssh = SshManager::default();
    let Some(env) = TestSshd::start(&ssh) else {
        eprintln!("skipping SSH fallback test: sshd unavailable");
        return;
    };

    let client = super::client::RemoteClient::connect_shell_fallback(
        &env.control_path,
        Arc::new(|| {}),
    )
    .await
    .expect("fallback connect failed");
    assert_eq!(client.kind, super::client::HelperKind::ShellFallback);

    let work = tempfile::tempdir().unwrap();
    let root = work.path();
    let root_s = root.to_string_lossy().into_owned();

    // Base64-looking text with trailing newlines must NOT be double-decoded or stripped.
    let b64_looking = "SGVsbG8gd29ybGQ=\n\n";
    let fpath = root.join("note.txt");
    let fpath_s = fpath.to_string_lossy().into_owned();
    let WriteResult::Written { version: v1 } = client
        .write_text(&fpath_s, b64_looking, &WriteExpect::Absent)
        .await
        .unwrap()
    else {
        panic!("expected Written");
    };
    assert_eq!(fs::read_to_string(&fpath).unwrap(), b64_looking);

    // Same-second, same-size sequential write produces a distinct version token,
    // and saving with the old version detects Conflict atomically!
    let WriteResult::Written { version: v2 } = client
        .write_text(&fpath_s, "AAAAAAAAAAAAAAAA\n\n", &WriteExpect::Version { version: v1.clone() })
        .await
        .unwrap()
    else {
        panic!("expected second Written");
    };
    assert_ne!(v1, v2);
    let conflict = client
        .write_text(&fpath_s, "BBBBBBBBBBBBBBBB\n\n", &WriteExpect::Version { version: v1 })
        .await
        .unwrap();
    assert!(matches!(conflict, WriteResult::Conflict { current: Some(_) }));
    assert_eq!(fs::read_to_string(&fpath).unwrap(), "AAAAAAAAAAAAAAAA\n\n");

    // Byte limit is enforced before transferring full file.
    assert!(client.read_bytes(&fpath_s, 4).await.is_err());
    assert_eq!(client.read_bytes(&fpath_s, 64).await.unwrap(), b"AAAAAAAAAAAAAAAA\n\n");

    // Unreadable file surfaces an error rather than empty bytes.
    let secret = root.join("no-read.txt");
    fs::write(&secret, "secret").unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();
    let read_unreadable = client.read_bytes(&secret.to_string_lossy(), 64).await;
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_unreadable.is_err());

    // Filename ending in newline is preserved in list_dir and delete.
    let nl_file = root.join("weird\n");
    fs::write(&nl_file, "nl").unwrap();
    let entries = client.list_dir(&root_s, true).await.unwrap();
    assert!(entries.iter().any(|e| e.name == "weird\n"));
    client
        .delete(&[nl_file.to_string_lossy().into_owned()])
        .await
        .unwrap();
    assert!(!nl_file.exists());

    // Root deletion refused in fallback too.
    assert!(client.delete(&["/".into()]).await.is_err());

    // Saving through a symlink in fallback returns consistent version on subsequent save.
    let link_path = root.join("note-link.txt");
    std::os::unix::fs::symlink(&fpath, &link_path).unwrap();
    let link_s = link_path.to_string_lossy().into_owned();
    let WriteResult::Written { version: sv1 } = client
        .write_text(&link_s, "via-symlink-1\n", &WriteExpect::Any)
        .await
        .unwrap()
    else {
        panic!("expected symlink write");
    };
    let WriteResult::Written { version: _ } = client
        .write_text(&link_s, "via-symlink-2\n", &WriteExpect::Version { version: sv1 })
        .await
        .unwrap()
    else {
        panic!("expected second symlink write without spurious conflict");
    };
    assert_eq!(fs::read_to_string(&fpath).unwrap(), "via-symlink-2\n");

    // Saving onto a directory fails cleanly instead of moving temp inside the directory.
    let sub_dir = root.join("adir");
    fs::create_dir(&sub_dir).unwrap();
    assert!(
        client
            .write_text(&sub_dir.to_string_lossy(), "nope", &WriteExpect::Any)
            .await
            .is_err()
    );
    assert!(fs::read_dir(&sub_dir).unwrap().next().is_none());

    client.close().await;
}
