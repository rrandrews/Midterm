import { describe, expect, it } from "vitest";
import { commandPrograms, runsFullPane } from "./fullPane";

describe("commandPrograms", () => {
  it("takes the first word of each segment", () => {
    expect(commandPrograms("agy")).toEqual(["agy"]);
    expect(commandPrograms("agy --resume  ")).toEqual(["agy"]);
    expect(commandPrograms("cd src && agy; git status | less")).toEqual(["cd", "agy", "git", "less"]);
  });
  it("skips assignments, wrappers and their flags", () => {
    expect(commandPrograms("FOO=1 BAR=x claude")).toEqual(["claude"]);
    expect(commandPrograms("sudo -E env -i nice htop")).toEqual(["htop"]);
    expect(commandPrograms("\\claude")).toEqual(["claude"]);
    expect(commandPrograms("'codex' run")).toEqual(["codex"]);
  });
  it("splits only at unquoted operators and newlines", () => {
    expect(commandPrograms('grep "error|agy failed" log')).toEqual(["grep"]);
    expect(commandPrograms("echo 'a; agy'")).toEqual(["echo"]);
    expect(commandPrograms("echo ready\nagy")).toEqual(["echo", "agy"]);
    expect(commandPrograms("make & agy")).toEqual(["make", "agy"]);
  });
  it("leaves out commands after ||", () => {
    expect(commandPrograms("sleep 60 || agy")).toEqual(["sleep"]);
    expect(commandPrograms("false || true && agy")).toEqual(["false", "agy"]);
  });
  it("skips wrapper options with values, and lookups", () => {
    expect(commandPrograms("sudo -u agy sleep 60")).toEqual(["sleep"]);
    expect(commandPrograms("sudo -u root agy")).toEqual(["agy"]);
    expect(commandPrograms("command -v agy")).toEqual([]);
    expect(commandPrograms("command agy")).toEqual(["agy"]);
  });
  it("gives nothing for an empty line", () => {
    expect(commandPrograms("   ")).toEqual([]);
  });
});

describe("runsFullPane", () => {
  const programs = ["agy"];
  it("matches the running command line", () => {
    expect(runsFullPane({ programs, command: "agy", foregroundName: undefined })).toBe(true);
    expect(runsFullPane({ programs, command: "/opt/bin/agy chat", foregroundName: "zsh" })).toBe(true);
  });
  it("matches the foreground program", () => {
    expect(runsFullPane({ programs, command: "./start.sh", foregroundName: "agy" })).toBe(true);
  });
  it("needs a running command and a listed program", () => {
    expect(runsFullPane({ programs, command: undefined, foregroundName: "agy" })).toBe(false);
    expect(runsFullPane({ programs, command: "vim", foregroundName: "vim" })).toBe(false);
    expect(runsFullPane({ programs: [], command: "agy", foregroundName: "agy" })).toBe(false);
  });
});
