import { beforeEach, describe, expect, it } from "vitest";
import * as fsMock from "../ipc/fsMock";
import { _resetMockSshForTests } from "../ipc/ssh";
import {
  _resetConnectionsForTests,
  displayLocation,
  getConnection,
  homeForLocation,
  hostLabelForLocation,
  registerConnection,
  subscribeConnections,
  updateConnectionMeta,
} from "./connections";

describe("ssh connections store", () => {
  beforeEach(() => {
    _resetConnectionsForTests();
    _resetMockSshForTests();
  });

  it("registers connections, updates metadata, and notifies subscribers", async () => {
    let calls = 0;
    const unsub = subscribeConnections(() => calls++);

    const info = await registerConnection({
      id: "prod-0123456789ab",
      label: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 22,
      controlPath: "/tmp/mt-501/s-0123456789ab",
      ownedSocket: true,
      sshArgs: ["--", "prod"],
    });
    expect(info.status).toBe("connected");
    expect(getConnection("prod-0123456789ab")?.label).toBe("prod");
    expect(calls).toBe(1);

    // Re-registering identical details preserves object identity and doesn't notify.
    const same = await registerConnection({
      id: "prod-0123456789ab",
      label: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 22,
      controlPath: "/tmp/mt-501/s-0123456789ab",
      ownedSocket: true,
      sshArgs: ["--", "prod"],
    });
    expect(same).toBe(info);
    expect(calls).toBe(1);

    // Changing sshArgs with the same length DOES trigger an update.
    const updatedArgs = await registerConnection({
      id: "prod-0123456789ab",
      label: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 22,
      controlPath: "/tmp/mt-501/s-0123456789ab",
      ownedSocket: true,
      sshArgs: ["--", "prod2"],
    });
    expect(updatedArgs.sshArgs).toEqual(["--", "prod2"]);
    expect(calls).toBe(2);

    updateConnectionMeta("prod-0123456789ab", { remoteHome: "/home/deploy", remoteShell: "bash" });
    expect(getConnection("prod-0123456789ab")?.remoteHome).toBe("/home/deploy");
    expect(getConnection("prod-0123456789ab")?.remoteShell).toBe("bash");
    expect(calls).toBe(3);

    unsub();
  });

  it("rejects mock fs access for disconnected/unknown remotes and allows connected ones", async () => {
    await expect(fsMock.listDir("ssh://unknown-0123456789ab/home/demo", { showHidden: false })).rejects.toThrow(
      /not active/,
    );
    await registerConnection({
      id: "prod-0123456789ab",
      label: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 22,
      controlPath: "/tmp/mt-501/s-0123456789ab",
      ownedSocket: true,
      sshArgs: ["--", "prod"],
    });
    const entries = await fsMock.listDir("ssh://prod-0123456789ab/home/demo/app", { showHidden: false });
    expect(entries.some((e) => e.name === "README.md")).toBe(true);
  });

  it("computes host labels, matching homes, and clean display strings", async () => {
    await registerConnection({
      id: "prod-0123456789ab",
      label: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 22,
      controlPath: "/tmp/mt-501/s-0123456789ab",
      ownedSocket: true,
      sshArgs: ["--", "prod"],
    });
    updateConnectionMeta("prod-0123456789ab", { remoteHome: "/home/deploy" });

    expect(hostLabelForLocation("/Users/me/app")).toBeNull();
    expect(hostLabelForLocation("ssh://prod-0123456789ab/home/deploy/app")).toBe("prod");
    expect(hostLabelForLocation("ssh://staging-abcdef012345/var/log")).toBe("staging");

    expect(homeForLocation("/Users/me/app", "/Users/me")).toBe("/Users/me");
    expect(homeForLocation("ssh://prod-0123456789ab/var/log", "/Users/me")).toBe(
      "ssh://prod-0123456789ab/home/deploy",
    );

    expect(displayLocation("/Users/me/app", "/Users/me", { includeHost: true })).toBe("~/app");
    expect(displayLocation("ssh://prod-0123456789ab/home/deploy/app", "/Users/me")).toBe("~/app");
    expect(displayLocation("ssh://prod-0123456789ab/home/deploy/app", "/Users/me", { includeHost: true })).toBe(
      "prod:~/app",
    );
    expect(displayLocation("ssh://prod-0123456789ab/etc/nginx", "/Users/me", { includeHost: true })).toBe(
      "prod:/etc/nginx",
    );
  });
});
