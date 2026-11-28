import { describe, expect, test } from "bun:test";
import { programNameOf } from "./program-names";

describe("programNameOf", () => {
  test.each([
    { command: "/Users/alex/.bun/bin/jive login", name: "jive login" },
    { command: "/home/alex/.bun/bin/bun /home/alex/.bun/install/global/node_modules/@ozyman42/agenticloud-connect/dist/base/agenticloud-connect.js", name: "agenticloud-connect" },
    { command: "-zsh", name: "zsh" },
    { command: "/sbin/launchd", name: "launchd" },
    { command: "git push origin main", name: "git push" },
    { command: "ssh -o ServerAliveInterval=30 root@example.com", name: "ssh" },
    { command: "curl -H Authorization:secret https://example.com", name: "curl" },
    { command: "jive-ssh root@ssh.example.com", name: "jive-ssh" },
  ])("$command is $name", ({ command, name }) => {
    expect(programNameOf(command)).toBe(name);
  });
});
