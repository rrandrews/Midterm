use super::*;

#[test]
fn node_version_gate() {
    assert!(check_node_version(Some("v20.11.1")).is_ok());
    assert!(check_node_version(Some("v18.0.0")).is_ok());
    let e = check_node_version(Some("v16.2.0")).unwrap_err();
    assert_eq!(
        e.message,
        "Claude Code needs Node.js 18 or later; found v16.2.0"
    );
    assert!(check_node_version(None).is_err());
    assert!(check_node_version(Some("garbage")).is_err());
}

#[test]
fn env_has_path_and_claude() {
    let env = bridge_env("/a:/b", std::path::Path::new("/x/claude"));
    assert!(env.contains(&("PATH".into(), "/a:/b".into())));
    assert!(env.contains(&("MIDTERM_CLAUDE_PATH".into(), "/x/claude".into())));
    assert!(ENV_REMOVE.contains(&"CLAUDECODE"));
    assert!(ENV_REMOVE.contains(&"CLAUDE_CODE_ENTRYPOINT"));
}

#[test]
fn exit_line_is_json() {
    let v: serde_json::Value =
        serde_json::from_str(&exit_line(Some(1), "bad \"thing\"\n")).unwrap();
    assert_eq!(v["event"], "bridgeExit");
    assert_eq!(v["code"], 1);
    assert_eq!(v["stderr"], "bad \"thing\"\n");
    let v: serde_json::Value = serde_json::from_str(&exit_line(None, "")).unwrap();
    assert!(v["code"].is_null());
}

#[test]
fn script_path_is_in_resources() {
    assert!(
        concat!(env!("CARGO_MANIFEST_DIR"), "/resources/claude-bridge.mjs")
            .ends_with("resources/claude-bridge.mjs")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn manager_close_all_kills_groups() {
    let (child, _stdin, _stdout) = LongChild::spawn(Spawn {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), "cat".into()],
        cwd: None,
        env: vec![],
        env_remove: vec![],
    })
    .unwrap();
    let manager = ClaudeManager::default();
    let (tx, _rx) = mpsc::unbounded_channel();
    manager.bridges.lock().unwrap().insert(
        "w".into(),
        Bridge {
            generation: 0,
            tx,
            group: child.group(),
            close: None,
        },
    );
    manager.close_all();
    let (_, _) = child.shutdown(Duration::from_secs(1)).await;
    assert!(manager.bridges.lock().unwrap().is_empty());
}
