use super::*;

fn strings(args: &[OsString]) -> Vec<String> {
    args.iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn builds_agy_acp_args() {
    assert_eq!(strings(&build_agy_acp_args(false, None, &[])), vec!["acp"]);
    assert_eq!(
        strings(&build_agy_acp_args(
            true,
            Some("  coder  "),
            &["/a".into(), " ".into(), "/b".into()]
        )),
        vec![
            "acp",
            "--sandbox",
            "--agent",
            "coder",
            "--add-dir",
            "/a",
            "--add-dir",
            "/b"
        ]
    );
    assert_eq!(
        strings(&build_agy_acp_args(false, Some("  "), &[])),
        vec!["acp"]
    );
}

#[test]
fn env_contains_path_and_no_color() {
    let env = acp_env("/usr/local/bin:/usr/bin");
    assert!(env.contains(&("PATH".into(), "/usr/local/bin:/usr/bin".into())));
    assert!(env.contains(&("NO_COLOR".into(), "1".into())));
}

#[test]
fn exit_line_is_jsonrpc_notification() {
    let v: serde_json::Value =
        serde_json::from_str(&exit_line(Some(2), "auth failed\n")).unwrap();
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["method"], EXIT_METHOD);
    assert_eq!(v["params"]["code"], 2);
    assert_eq!(v["params"]["stderr"], "auth failed\n");
    let v: serde_json::Value = serde_json::from_str(&exit_line(None, "")).unwrap();
    assert!(v["params"]["code"].is_null());
}

#[cfg(unix)]
#[tokio::test]
async fn manager_closes_single_and_owned_and_all() {
    let spawn_cat = || {
        LongChild::spawn(Spawn {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "cat".into()],
            cwd: None,
            env: vec![],
            env_remove: vec![],
        })
        .unwrap()
    };

    let (c1, _i1, _o1) = spawn_cat();
    let (c2, _i2, _o2) = spawn_cat();
    let (c3, _i3, _o3) = spawn_cat();
    let manager = AntigravityManager::default();
    let insert = |id: &str, owner: &str, generation: u64, child: &LongChild| {
        let (tx, _rx) = mpsc::unbounded_channel();
        let (close, _close_rx) = oneshot::channel();
        manager.state.lock().unwrap().connections.insert(
            id.into(),
            Connection {
                owner: owner.into(),
                generation,
                tx,
                group: child.group(),
                close: Some(close),
            },
        );
    };
    insert("p1", "w1", 1, &c1);
    insert("p2", "w1", 2, &c2);
    insert("p3", "w2", 3, &c3);

    // Wrong owner cannot close p1.
    manager.close_connection("w2", "p1");
    assert!(manager.state.lock().unwrap().connections.contains_key("p1"));

    // Right owner closes p1, moving its group to closing.
    manager.close_connection("w1", "p1");
    {
        let state = manager.state.lock().unwrap();
        assert!(!state.connections.contains_key("p1"));
        assert!(state.closing.contains_key(&1));
    }

    // Closing window w1 removes p2, leaves w2's p3 untouched.
    manager.close_owned_by("w1");
    {
        let state = manager.state.lock().unwrap();
        assert!(!state.connections.contains_key("p2"));
        assert!(state.connections.contains_key("p3"));
        assert!(state.closing.contains_key(&2));
        assert!(state.window_gen["w1"] >= 1);
    }

    // close_all kills everything (active and closing).
    manager.close_all();
    {
        let state = manager.state.lock().unwrap();
        assert!(state.connections.is_empty());
        assert!(state.closing.is_empty());
    }
    let _ = c1.shutdown(Duration::from_secs(1)).await;
    let _ = c2.shutdown(Duration::from_secs(1)).await;
    let _ = c3.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn bounded_line_reader_stops_on_oversized_lines() {
    let data = b"ok\n12345678901\n";
    let mut reader = tokio::io::BufReader::new(&data[..]);
    let mut buf = Vec::new();
    assert!(matches!(
        read_line_bounded(&mut reader, &mut buf, 10).await.unwrap(),
        LineRead::Line
    ));
    assert_eq!(buf, b"ok\n");
    assert!(matches!(
        read_line_bounded(&mut reader, &mut buf, 10).await.unwrap(),
        LineRead::TooLong
    ));
}
