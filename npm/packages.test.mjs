// @ts-check
// node --test npm/packages.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PLATFORMS, command, packageName, platformFor } from "./ain-app/lib/target.js";
import { baseManifest, launcherManifest, platformManifest, stageLauncher, stagePlatform } from "./stage.mjs";

const scratch = mkdtempSync(join(tmpdir(), "ain-npm-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** @param {string} path */
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("platformFor", () => {
  it("picks the build npm installs for this OS and CPU", () => {
    assert.equal(platformFor("linux", "x64"), "linux-x64");
    assert.equal(platformFor("win32", "x64"), "win32-x64");
    assert.equal(platformFor("darwin", "x64"), "darwin-x64");
    assert.equal(platformFor("darwin", "arm64"), "darwin-x64", "Apple silicon runs the Intel build");
  });

  it("has none for the rest", () => {
    assert.equal(platformFor("linux", "arm64"), undefined);
    assert.equal(platformFor("win32", "arm64"), undefined);
    assert.equal(platformFor("freebsd", "x64"), undefined);
  });
});

describe("command", () => {
  const dir = join("/opt", "pkg");

  it("runs the AppImage, unpacking itself where FUSE is missing", () => {
    const mounted = command("linux-x64", dir, ["--flag"], { fuse: true, wait: false });
    assert.deepEqual(mounted, { file: join(dir, "AiN.AppImage"), args: ["--flag"], env: {}, executable: join(dir, "AiN.AppImage") });
    assert.deepEqual(command("linux-x64", dir, [], { fuse: false, wait: false }).env, { APPIMAGE_EXTRACT_AND_RUN: "1" });
  });

  it("opens the .app through Launch Services, its arguments after --args", () => {
    const app = join(dir, "AiN.app");
    assert.deepEqual(command("darwin-x64", dir, [], { fuse: false, wait: false }).args, [app]);
    assert.deepEqual(command("darwin-x64", dir, ["-x"], { fuse: false, wait: true }).args, ["-W", app, "--args", "-x"]);
    assert.equal(command("darwin-x64", dir, [], { fuse: false, wait: false }).executable, join(app, "Contents", "MacOS", "ain"));
  });

  it("runs the .exe", () => {
    assert.equal(command("win32-x64", dir, [], { fuse: false, wait: false }).file, join(dir, "ain.exe"));
  });

  it("refuses a platform it has no build for", () => {
    assert.throws(() => command("linux-arm64", dir, [], { fuse: true, wait: false }), /no AiN build/);
  });
});

describe("manifests", () => {
  const base = baseManifest();

  it("pins every platform's package at the launcher's version", () => {
    const manifest = launcherManifest(base, "1.2.3");
    assert.equal(manifest.version, "1.2.3");
    assert.deepEqual(manifest.optionalDependencies, {
      "ain-app-linux-x64": "1.2.3",
      "ain-app-darwin-x64": "1.2.3",
      "ain-app-win32-x64": "1.2.3",
    });
    assert.deepEqual(manifest.bin, { ain: "bin/ain.js" });
  });

  it("limits each platform's package to its OS and CPU, as the launcher looks it up", () => {
    for (const [id, platform] of Object.entries(PLATFORMS)) {
      const manifest = platformManifest(base, id, "1.2.3");
      assert.equal(manifest.name, packageName(id));
      assert.deepEqual(manifest.os, [platform.os]);
      assert.deepEqual(manifest.cpu, platform.cpu);
      assert.deepEqual(manifest.files, [platform.file]);
      assert.equal(manifest.license, "MIT");
      for (const cpu of platform.cpu) assert.equal(platformFor(platform.os, cpu), id, `${platform.os} ${cpu}`);
    }
    assert.deepEqual(platformManifest(base, "linux-x64", "1.0.0").libc, ["glibc"], "the AppImage needs glibc");
    assert.equal(platformManifest(base, "win32-x64", "1.0.0").libc, undefined);
  });

  it("names the repository, for npm's provenance check", () => {
    assert.match(String(/** @type {{ url: string }} */ (base.repository).url), /github\.com\/Satcomx00-x00\/AiN\.git$/);
  });
});

describe("staging", () => {
  it("puts the newest AppImage in the Linux package, still executable", () => {
    const release = join(scratch, "linux", "release");
    const appimages = join(release, "bundle", "appimage");
    mkdirSync(appimages, { recursive: true });
    for (const version of ["0.9.0", "1.0.0"]) {
      writeFileSync(join(appimages, `AiN_${version}_amd64.AppImage`), version);
      chmodSync(join(appimages, `AiN_${version}_amd64.AppImage`), 0o755);
    }
    const out = join(scratch, "linux", "out");
    stagePlatform("linux-x64", "1.0.0", release, out);
    assert.equal(readFileSync(join(out, "AiN.AppImage"), "utf8"), "1.0.0");
    if (process.platform !== "win32") assert.equal(statSync(join(out, "AiN.AppImage")).mode & 0o111, 0o111);
    assert.equal(json(join(out, "package.json")).name, "ain-app-linux-x64");
    assert.ok(statSync(join(out, "LICENSE")).isFile());
    assert.throws(() => stagePlatform("linux-x64", "2.0.0", release, out), /expected one \.AppImage for 2\.0\.0/);
  });

  it("puts the whole .app in the macOS package", () => {
    const release = join(scratch, "mac", "release");
    mkdirSync(join(release, "bundle", "macos", "AiN.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(release, "bundle", "macos", "AiN.app", "Contents", "MacOS", "ain"), "app");
    writeFileSync(join(release, "bundle", "macos", "AiN.app", "Contents", "Info.plist"), "plist");
    const out = join(scratch, "mac", "out");
    stagePlatform("darwin-x64", "1.0.0", release, out);
    assert.equal(readFileSync(join(out, "AiN.app", "Contents", "MacOS", "ain"), "utf8"), "app");
    assert.equal(readFileSync(join(out, "AiN.app", "Contents", "Info.plist"), "utf8"), "plist");
  });

  it("says where it looked when the build is missing", () => {
    assert.throws(() => stagePlatform("win32-x64", "1.0.0", join(scratch, "nothing"), join(scratch, "win")), /no build at .*ain\.exe/);
  });

  it("stages the launcher with its program and the platform table it reads", () => {
    const out = join(scratch, "launcher");
    stageLauncher("1.0.0", out);
    const manifest = json(join(out, "package.json"));
    assert.equal(manifest.version, "1.0.0");
    for (const file of manifest.files) assert.ok(statSync(join(out, file)), file);
    assert.ok(statSync(join(out, "README.md")).isFile());
  });
});
