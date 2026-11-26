import { describe, expect, it } from "vitest";
import { parseOsc7, parsePathReport, parseSshOsc } from "./osc";

describe("parseOsc7", () => {
  it("parses host and path", () => {
    expect(parseOsc7("file://mac.local/Users/ron/Code")).toEqual({
      host: "mac.local",
      path: "/Users/ron/Code",
    });
  });

  it("decodes percent-encoding", () => {
    expect(parseOsc7("file://h/tmp/a%20b/%C3%A9t%C3%A9")?.path).toBe("/tmp/a b/été");
  });

  it("allows an empty host and the root directory", () => {
    expect(parseOsc7("file:///")).toEqual({ host: "", path: "/" });
  });

  it("drops a trailing slash", () => {
    expect(parseOsc7("file://h/tmp/")?.path).toBe("/tmp");
  });

  it("accepts kitty's scheme", () => {
    expect(parseOsc7("kitty-shell-cwd://box/srv/app")).toEqual({ host: "box", path: "/srv/app" });
  });

  it("rejects other schemes and garbage", () => {
    expect(parseOsc7("http://h/tmp")).toBeNull();
    expect(parseOsc7("/tmp")).toBeNull();
    expect(parseOsc7("file://h/%E0%A4%A")).toBeNull();
  });
});

describe("parsePathReport", () => {
  it("decodes the path and reads the aid", () => {
    expect(parsePathReport("path=/usr/bin%3A/my%20bin;aid=12.34")).toEqual({ path: "/usr/bin:/my bin", aid: "12.34" });
    expect(parsePathReport("path=/a:/b")).toEqual({ path: "/a:/b", aid: undefined });
    expect(parsePathReport("path=")).toEqual({ path: "", aid: undefined });
  });

  it("rejects anything else", () => {
    expect(parsePathReport("aid=1")).toBeNull();
    expect(parsePathReport("/usr/bin")).toBeNull();
    expect(parsePathReport("path=%E0%A4%A")).toBeNull();
  });
});

describe("parseSshOsc", () => {
  it("parses ssh=start with encoded args and fields", () => {
    expect(
      parseSshOsc(
        "ssh=start;id=prod-0123456789ab;label=prod%20box;host=10.0.0.5;user=deploy;port=2222;sock=%2Ftmp%2Fmt-501%2Fs-0123456789ab;owned=1;args=-p,2222,-i,%2Fmy%20key,prod;token=deadbeef",
      ),
    ).toEqual({
      kind: "start",
      id: "prod-0123456789ab",
      label: "prod box",
      host: "10.0.0.5",
      user: "deploy",
      port: 2222,
      controlPath: "/tmp/mt-501/s-0123456789ab",
      ownedSocket: true,
      sshArgs: ["-p", "2222", "-i", "/my key", "prod"],
      token: "deadbeef",
    });

    expect(
      parseSshOsc("ssh=start;id=box-0123456789ab;host=box;sock=%2Ftmp%2Fs;owned=0;args=;token=tok"),
    ).toEqual({
      kind: "start",
      id: "box-0123456789ab",
      label: "box",
      host: "box",
      user: "",
      port: 22,
      controlPath: "/tmp/s",
      ownedSocket: false,
      sshArgs: [],
      token: "tok",
    });
  });

  it("parses ssh=end and meta=1", () => {
    expect(parseSshOsc("ssh=end;id=prod-0123456789ab;token=deadbeef")).toEqual({
      kind: "end",
      id: "prod-0123456789ab",
      token: "deadbeef",
    });
    expect(parseSshOsc("meta=1;home=%2Fhome%2Fmy%20user%2F;shell=zsh;aid=99.1")).toEqual({
      kind: "meta",
      home: "/home/my user",
      shell: "zsh",
      aid: "99.1",
    });
  });

  it("rejects malformed or unsafe OSC 6974 payloads", () => {
    expect(parseSshOsc("ssh=start;id=../evil;host=h;sock=%2Ftmp%2Fs;token=t")).toBeNull();
    expect(parseSshOsc("ssh=start;id=ok;host=h;sock=%2Ftmp%2Fs;port=99999;token=t")).toBeNull();
    expect(parseSshOsc("ssh=start;id=ok;host=h;sock=%2Ftmp%2Fs")).toBeNull();
    expect(parseSshOsc("ssh=end;id=ok")).toBeNull();
    expect(parseSshOsc("meta=1;home=relative;shell=")).toBeNull();
    expect(parseSshOsc("unknown=1")).toBeNull();
  });
});
