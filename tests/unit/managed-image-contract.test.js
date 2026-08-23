import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

function ignored(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).some((line) => line.trim() === "package-lock.json");
}

describe("managed image contract", () => {
  it("commits deterministic npm lockfiles", () => {
    expect(fs.existsSync(path.join(root, "package-lock.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tests/package-lock.json"))).toBe(true);
    expect(ignored(path.join(root, ".gitignore"))).toBe(false);
    expect(ignored(path.join(root, "tests/.gitignore"))).toBe(false);
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).not.toMatch(/npm install/);
  });

  it("pins and identifies the image build", () => {
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=node:22-alpine@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toContain("ARG VCS_REF=unknown");
    expect(dockerfile).toContain("org.opencontainers.image.revision=$VCS_REF");
    expect(dockerfile).not.toMatch(/apk .*upgrade/);
  });

  it("runs non-root without recursively taking ownership of mounted data", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toContain("chown -R");
    expect(dockerfile).not.toContain("su-exec");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain('CMD ["node", "custom-server.js"]');
  });
});
