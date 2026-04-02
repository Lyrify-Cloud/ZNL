import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

import { ZNL } from "../../../index.js";
import {
  delay,
  installTimeoutScaling,
  readFsBodyText,
  resetDir,
  safeStop,
  scaleMs,
  toText,
  waitForRegistered,
} from "../helpers/common.js";

installTimeoutScaling();

async function expectRejected(action, messageIncludes = []) {
  let error = null;
  try {
    await action();
  } catch (thrown) {
    error = thrown;
  }

  const text = String(error?.message ?? error ?? "");
  return {
    error,
    message: text,
    matched:
      !messageIncludes.length ||
      messageIncludes.some((part) => text.includes(String(part))),
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function createDirectoryEscapeLink(linkPath, targetDir) {
  await fs.rm(linkPath, { recursive: true, force: true }).catch(() => {});

  const type = process.platform === "win32" ? "junction" : "dir";
  try {
    await fs.symlink(targetDir, linkPath, type);
    return { created: true, mode: type };
  } catch (error) {
    return {
      created: false,
      mode: type,
      reason: String(error?.message ?? error),
    };
  }
}

export async function runFsServiceTests(runner) {
  runner.section("fs 内建服务");

  await runner.test(
    "plain 模式：fs CRUD + patch + upload/download 正常",
    async () => {
      const EP_FS = "tcp://127.0.0.1:16040";
      const baseDir = path.resolve("test/tmp/fs-plain");
      const rootDir = path.join(baseDir, "remote");
      const uploadSource = path.join(baseDir, "upload-source.txt");
      const uploadSourceDir = path.join(baseDir, "banner.txt");
      const uploadSourceDot = path.join(baseDir, "root-note.txt");
      const downloadTarget = path.join(baseDir, "downloaded.txt");

      await resetDir(baseDir);
      await fs.mkdir(rootDir, { recursive: true });
      await fs.writeFile(
        path.join(rootDir, "hello.txt"),
        "hello\nworld\n",
        "utf8",
      );
      await fs.writeFile(uploadSource, "upload-body-001", "utf8");
      await fs.writeFile(uploadSourceDir, "upload-body-dir", "utf8");
      await fs.writeFile(uploadSourceDot, "upload-body-dot", "utf8");

      const master = new ZNL({
        role: "master",
        id: "m-fs",
        endpoints: { router: EP_FS },
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-fs",
        endpoints: { router: EP_FS },
      });

      slave.fs.setRoot(rootDir);

      try {
        await master.start();
        await slave.start();
        await delay(250);

        const registered = await waitForRegistered(master, "s-fs", {
          timeoutMs: 3000,
          intervalMs: 100,
        });
        runner.assert(registered, `fs slave 已注册 → ${master.slaves}`);

        const list1 = await master.fs.list("s-fs", ".", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          Array.isArray(list1.entries) &&
            list1.entries.some((entry) => entry.name === "hello.txt"),
          `list 返回 hello.txt → ${JSON.stringify(list1.entries)}`,
        );

        const stat1 = await master.fs.stat("s-fs", "hello.txt", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(stat1.isFile === true, "stat 返回 isFile=true");

        const get1 = await master.fs.get("s-fs", "hello.txt", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          readFsBodyText(get1) === "hello\nworld\n",
          `get 内容正确 → "${readFsBodyText(get1)}"`,
        );

        const mkdirResult = await master.fs.mkdir("s-fs", "nested/subdir", {
          timeoutMs: scaleMs(2000),
          recursive: true,
        });
        runner.assert(
          mkdirResult.ok === true && mkdirResult.created === true,
          `mkdir 返回成功 → ${JSON.stringify(mkdirResult)}`,
        );

        const mkdirStat = await master.fs.stat("s-fs", "nested/subdir", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          mkdirStat.isDirectory === true,
          "mkdir 后 stat 返回 isDirectory=true",
        );

        const createResult = await master.fs.create(
          "s-fs",
          "nested/new-file.txt",
          {
            timeoutMs: scaleMs(2000),
            recursive: true,
          },
        );
        runner.assert(
          createResult.ok === true && createResult.created === true,
          `create 返回成功 → ${JSON.stringify(createResult)}`,
        );

        const createdStat = await master.fs.stat(
          "s-fs",
          "nested/new-file.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          createdStat.isFile === true,
          "create 后 stat 返回 isFile=true",
        );

        const createdGet = await master.fs.get("s-fs", "nested/new-file.txt", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          readFsBodyText(createdGet) === "",
          `create 后空文件内容正确 → "${readFsBodyText(createdGet)}"`,
        );

        const patch = createTwoFilesPatch(
          "hello.txt",
          "hello.txt",
          "hello\nworld\n",
          "hello\nznl\n",
        );
        const patchResult = await master.fs.patch("s-fs", "hello.txt", patch, {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(patchResult.applied === true, "patch applied=true");

        const get2 = await master.fs.get("s-fs", "hello.txt", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          readFsBodyText(get2) === "hello\nznl\n",
          `patch 后内容正确 → "${readFsBodyText(get2)}"`,
        );

        const renameResult = await master.fs.rename(
          "s-fs",
          "hello.txt",
          "renamed.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          renameResult.to === "renamed.txt",
          `rename 返回目标正确 → "${renameResult.to}"`,
        );

        const list2 = await master.fs.list("s-fs", ".", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          list2.entries.some((entry) => entry.name === "renamed.txt"),
          `rename 后目录包含 renamed.txt → ${JSON.stringify(list2.entries)}`,
        );

        const assetsDir = await master.fs.mkdir("s-fs", "assets", {
          timeoutMs: scaleMs(2000),
          recursive: true,
          existOk: true,
        });
        runner.assert(
          assetsDir.ok === true,
          `upload 目录准备成功 → ${JSON.stringify(assetsDir)}`,
        );

        const uploadToTrailingSlash = await master.fs.upload(
          "s-fs",
          uploadSourceDir,
          "assets/",
          {
            timeoutMs: scaleMs(3000),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(
          uploadToTrailingSlash.ok === true,
          "upload 到目录路径(带 /) 完成",
        );

        const uploadedToAssets = await master.fs.get(
          "s-fs",
          "assets/banner.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          readFsBodyText(uploadedToAssets) === "upload-body-dir",
          `upload 到 assets/ 应落盘为 assets/banner.txt → "${readFsBodyText(uploadedToAssets)}"`,
        );

        const uploadToDot = await master.fs.upload(
          "s-fs",
          uploadSourceDot,
          ".",
          {
            timeoutMs: scaleMs(3000),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(uploadToDot.ok === true, "upload 到 . 根目录完成");

        const uploadedToRoot = await master.fs.get("s-fs", "root-note.txt", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          readFsBodyText(uploadedToRoot) === "upload-body-dot",
          `upload 到 . 应落盘为 root-note.txt → "${readFsBodyText(uploadedToRoot)}"`,
        );

        const incomingDir = await master.fs.mkdir("s-fs", "incoming", {
          timeoutMs: scaleMs(2000),
          recursive: true,
          existOk: true,
        });
        runner.assert(
          incomingDir.ok === true,
          `existing 目录准备成功 → ${JSON.stringify(incomingDir)}`,
        );

        const uploadToExistingDir = await master.fs.upload(
          "s-fs",
          uploadSource,
          "incoming",
          {
            timeoutMs: scaleMs(3000),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(
          uploadToExistingDir.ok === true,
          "upload 到已有目录路径(不带 /) 完成",
        );

        const uploadedToExistingDir = await master.fs.get(
          "s-fs",
          "incoming/upload-source.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          readFsBodyText(uploadedToExistingDir) === "upload-body-001",
          `upload 到 existing dir 应落盘为 incoming/upload-source.txt → "${readFsBodyText(uploadedToExistingDir)}"`,
        );

        const uploadResult = await master.fs.upload(
          "s-fs",
          uploadSource,
          "uploaded.txt",
          {
            timeoutMs: scaleMs(3000),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(uploadResult.ok === true, "upload 到明确文件路径完成");

        const uploaded = await master.fs.get("s-fs", "uploaded.txt", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          readFsBodyText(uploaded) === "upload-body-001",
          `upload 后远端文件内容正确 → "${readFsBodyText(uploaded)}"`,
        );

        const downloadResult = await master.fs.download(
          "s-fs",
          "uploaded.txt",
          downloadTarget,
          {
            timeoutMs: scaleMs(3000),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(downloadResult.ok === true, "download 完成");

        const downloadedText = await fs.readFile(downloadTarget, "utf8");
        runner.assert(
          downloadedText === "upload-body-001",
          `download 本地文件内容正确 → "${downloadedText}"`,
        );

        const deleteResult = await master.fs.delete("s-fs", "renamed.txt", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(deleteResult.ok === true, "delete 完成");

        const list3 = await master.fs.list("s-fs", ".", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          !list3.entries.some((entry) => entry.name === "renamed.txt"),
          `delete 后 renamed.txt 不存在 → ${JSON.stringify(list3.entries)}`,
        );
      } finally {
        await safeStop(slave, master);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );

  await runner.test("plain 模式：fs root 越权访问被拒绝", async () => {
    const EP_FS_SEC = "tcp://127.0.0.1:16041";
    const baseDir = path.resolve("test/tmp/fs-boundary");
    const rootDir = path.join(baseDir, "remote");

    await resetDir(baseDir);
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, "inside.txt"), "safe", "utf8");

    const master = new ZNL({
      role: "master",
      id: "m-fs-boundary",
      endpoints: { router: EP_FS_SEC },
    });
    const slave = new ZNL({
      role: "slave",
      id: "s-fs-boundary",
      endpoints: { router: EP_FS_SEC },
    });

    slave.fs.setRoot(rootDir);

    try {
      await master.start();
      await slave.start();
      await delay(250);

      const result = await expectRejected(
        () =>
          master.fs.get("s-fs-boundary", "../outside.txt", {
            timeoutMs: scaleMs(1500),
          }),
        ["路径越权"],
      );

      runner.assert(result.matched, `越权访问被拒绝 → "${result.message}"`);
    } finally {
      await safeStop(slave, master);
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  await runner.test("plain 模式：未设置 fs root 时请求被拒绝", async () => {
    const EP_FS_ROOT = "tcp://127.0.0.1:16043";

    const master = new ZNL({
      role: "master",
      id: "m-fs-no-root",
      endpoints: { router: EP_FS_ROOT },
    });
    const slave = new ZNL({
      role: "slave",
      id: "s-fs-no-root",
      endpoints: { router: EP_FS_ROOT },
    });

    try {
      await master.start();
      await slave.start();
      await delay(250);

      const result = await expectRejected(
        () =>
          master.fs.list("s-fs-no-root", ".", {
            timeoutMs: scaleMs(1500),
          }),
        ["fs root", "setRoot", "未注册的 service：fs"],
      );

      runner.assert(
        result.matched,
        `未配置 root 时返回明确错误 → "${result.message}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test(
    "plain 模式：fs 应拒绝通过 symlink / junction 越界访问 root 外文件",
    async () => {
      const EP_FS_SYMLINK = "tcp://127.0.0.1:16046";
      const baseDir = path.resolve("test/tmp/fs-symlink-escape");
      const rootDir = path.join(baseDir, "remote");
      const outsideDir = path.join(baseDir, "outside");
      const linkDir = path.join(rootDir, "escape-dir");
      const downloadTarget = path.join(baseDir, "leaked.txt");

      await resetDir(baseDir);
      await fs.mkdir(rootDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(
        path.join(outsideDir, "secret.txt"),
        "top-secret-outside",
        "utf8",
      );

      const link = await createDirectoryEscapeLink(linkDir, outsideDir);

      if (!link.created) {
        runner.assert(
          true,
          `当前环境无法创建 symlink/junction，跳过该用例 → ${link.reason}`,
        );
        await fs.rm(baseDir, { recursive: true, force: true });
        return;
      }

      const master = new ZNL({
        role: "master",
        id: "m-fs-symlink",
        endpoints: { router: EP_FS_SYMLINK },
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-fs-symlink",
        endpoints: { router: EP_FS_SYMLINK },
      });

      slave.fs.setRoot(rootDir);

      try {
        await master.start();
        await slave.start();
        await delay(250);

        const registered = await waitForRegistered(master, "s-fs-symlink", {
          timeoutMs: 3000,
          intervalMs: 100,
        });
        runner.assert(
          registered,
          `symlink 测试 slave 已注册 → ${master.slaves}`,
        );

        const checks = await Promise.all([
          expectRejected(
            () =>
              master.fs.stat("s-fs-symlink", "escape-dir/secret.txt", {
                timeoutMs: scaleMs(2000),
              }),
            ["symlink", "符号链接", "越权", "非法"],
          ),
          expectRejected(
            () =>
              master.fs.get("s-fs-symlink", "escape-dir/secret.txt", {
                timeoutMs: scaleMs(2000),
              }),
            ["symlink", "符号链接", "越权", "非法"],
          ),
          expectRejected(
            () =>
              master.fs.download(
                "s-fs-symlink",
                "escape-dir/secret.txt",
                downloadTarget,
                {
                  timeoutMs: scaleMs(2500),
                  chunkSize: 64 * 1024,
                },
              ),
            ["symlink", "符号链接", "越权", "非法"],
          ),
          expectRejected(
            () =>
              master.fs.list("s-fs-symlink", "escape-dir", {
                timeoutMs: scaleMs(2000),
              }),
            ["symlink", "符号链接", "越权", "非法"],
          ),
        ]);

        runner.assert(
          checks.every((item) => item.matched),
          `symlink 越界访问全部被拒绝 → ${checks.map((item) => item.message).join(" | ")}`,
        );

        runner.assert(
          !(await pathExists(downloadTarget)),
          "被拒绝后不应生成下载目标文件",
        );
      } finally {
        await safeStop(slave, master);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );

  await runner.test(
    "plain 模式：setRoot 策略 readOnly=true 应拒绝写操作",
    async () => {
      const EP_FS_POLICY_RO = "tcp://127.0.0.1:16047";
      const baseDir = path.resolve("test/tmp/fs-policy-readonly");
      const rootDir = path.join(baseDir, "remote");
      const uploadSource = path.join(baseDir, "upload-source.txt");

      await resetDir(baseDir);
      await fs.mkdir(rootDir, { recursive: true });
      await fs.writeFile(path.join(rootDir, "readonly.txt"), "hello\n", "utf8");
      await fs.writeFile(uploadSource, "upload-body", "utf8");

      const master = new ZNL({
        role: "master",
        id: "m-fs-policy-ro",
        endpoints: { router: EP_FS_POLICY_RO },
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-fs-policy-ro",
        endpoints: { router: EP_FS_POLICY_RO },
      });

      slave.fs.setRoot(rootDir, {
        readOnly: true,
      });

      try {
        await master.start();
        await slave.start();
        await delay(250);

        const registered = await waitForRegistered(master, "s-fs-policy-ro", {
          timeoutMs: 3000,
          intervalMs: 100,
        });
        runner.assert(
          registered,
          `readOnly 测试 slave 已注册 → ${master.slaves}`,
        );

        const statResult = await master.fs.stat(
          "s-fs-policy-ro",
          "readonly.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(statResult.isFile === true, "readOnly 下 stat 仍允许");

        const getResult = await master.fs.get(
          "s-fs-policy-ro",
          "readonly.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          readFsBodyText(getResult) === "hello\n",
          `readOnly 下 get 仍允许 → "${readFsBodyText(getResult)}"`,
        );

        const patch = createTwoFilesPatch(
          "readonly.txt",
          "readonly.txt",
          "hello\n",
          "changed\n",
        );

        const results = await Promise.all([
          expectRejected(
            () =>
              master.fs.patch("s-fs-policy-ro", "readonly.txt", patch, {
                timeoutMs: scaleMs(2000),
              }),
            ["只读", "readOnly", "禁止", "不允许"],
          ),
          expectRejected(
            () =>
              master.fs.rename(
                "s-fs-policy-ro",
                "readonly.txt",
                "renamed.txt",
                {
                  timeoutMs: scaleMs(2000),
                },
              ),
            ["只读", "readOnly", "禁止", "不允许"],
          ),
          expectRejected(
            () =>
              master.fs.delete("s-fs-policy-ro", "readonly.txt", {
                timeoutMs: scaleMs(2000),
              }),
            ["只读", "readOnly", "禁止", "不允许"],
          ),
          expectRejected(
            () =>
              master.fs.mkdir("s-fs-policy-ro", "created-dir", {
                timeoutMs: scaleMs(2000),
                recursive: true,
              }),
            ["只读", "readOnly", "禁止", "不允许"],
          ),
          expectRejected(
            () =>
              master.fs.create("s-fs-policy-ro", "created.txt", {
                timeoutMs: scaleMs(2000),
                recursive: true,
              }),
            ["只读", "readOnly", "禁止", "不允许"],
          ),
          expectRejected(
            () =>
              master.fs.upload("s-fs-policy-ro", uploadSource, "uploaded.txt", {
                timeoutMs: scaleMs(2500),
                chunkSize: 64 * 1024,
              }),
            ["只读", "readOnly", "禁止", "不允许"],
          ),
        ]);

        runner.assert(
          results.every((item) => item.matched),
          `readOnly 写操作全部被拒绝 → ${results.map((item) => item.message).join(" | ")}`,
        );

        const finalContent = await master.fs.get(
          "s-fs-policy-ro",
          "readonly.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          readFsBodyText(finalContent) === "hello\n",
          `readOnly 不应改动原文件 → "${readFsBodyText(finalContent)}"`,
        );
      } finally {
        await safeStop(slave, master);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );

  await runner.test(
    "plain 模式：setRoot 路径策略应限制 allowedPaths / denyGlobs / allow*",
    async () => {
      const EP_FS_POLICY = "tcp://127.0.0.1:16048";
      const baseDir = path.resolve("test/tmp/fs-policy-paths");
      const rootDir = path.join(baseDir, "remote");
      const uploadSource = path.join(baseDir, "upload-source.txt");
      const downloadTarget = path.join(baseDir, "downloaded.txt");

      await resetDir(baseDir);
      await fs.mkdir(path.join(rootDir, "public"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "private"), { recursive: true });

      await fs.writeFile(
        path.join(rootDir, "public", "allowed.txt"),
        "allowed",
        "utf8",
      );
      await fs.writeFile(
        path.join(rootDir, "public", "blocked.secret.txt"),
        "secret",
        "utf8",
      );
      await fs.writeFile(
        path.join(rootDir, "private", "hidden.txt"),
        "hidden",
        "utf8",
      );
      await fs.writeFile(uploadSource, "upload-policy-body", "utf8");

      const master = new ZNL({
        role: "master",
        id: "m-fs-policy",
        endpoints: { router: EP_FS_POLICY },
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-fs-policy",
        endpoints: { router: EP_FS_POLICY },
      });

      slave.fs.setRoot(rootDir, {
        allowDelete: false,
        allowPatch: false,
        allowUpload: false,
        allowedPaths: ["public/**"],
        denyGlobs: ["**/*.secret.txt", "private/**"],
      });

      try {
        await master.start();
        await slave.start();
        await delay(250);

        const registered = await waitForRegistered(master, "s-fs-policy", {
          timeoutMs: 3000,
          intervalMs: 100,
        });
        runner.assert(
          registered,
          `policy 测试 slave 已注册 → ${master.slaves}`,
        );

        const allowedList = await master.fs.list("s-fs-policy", "public", {
          timeoutMs: scaleMs(2000),
        });
        runner.assert(
          Array.isArray(allowedList.entries) &&
            allowedList.entries.some((entry) => entry.name === "allowed.txt"),
          `allowedPaths 命中时 list 允许 → ${JSON.stringify(allowedList.entries)}`,
        );

        const allowedGet = await master.fs.get(
          "s-fs-policy",
          "public/allowed.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          readFsBodyText(allowedGet) === "allowed",
          `allowedPaths 命中时 get 允许 → "${readFsBodyText(allowedGet)}"`,
        );

        const blockedChecks = await Promise.all([
          expectRejected(
            () =>
              master.fs.get("s-fs-policy", "private/hidden.txt", {
                timeoutMs: scaleMs(2000),
              }),
            ["拒绝", "禁止", "allow", "allowedPaths", "权限"],
          ),
          expectRejected(
            () =>
              master.fs.get("s-fs-policy", "public/blocked.secret.txt", {
                timeoutMs: scaleMs(2000),
              }),
            ["拒绝", "禁止", "deny", "denyGlobs", "权限"],
          ),
          expectRejected(
            () =>
              master.fs.download(
                "s-fs-policy",
                "private/hidden.txt",
                downloadTarget,
                {
                  timeoutMs: scaleMs(2500),
                  chunkSize: 64 * 1024,
                },
              ),
            ["拒绝", "禁止", "allow", "allowedPaths", "权限"],
          ),
          expectRejected(
            () =>
              master.fs.delete("s-fs-policy", "public/allowed.txt", {
                timeoutMs: scaleMs(2000),
              }),
            ["拒绝", "禁止", "delete", "allowDelete", "权限"],
          ),
          expectRejected(() => {
            const patch = createTwoFilesPatch(
              "allowed.txt",
              "allowed.txt",
              "allowed",
              "changed",
            );
            return master.fs.patch("s-fs-policy", "public/allowed.txt", patch, {
              timeoutMs: scaleMs(2000),
            });
          }, ["拒绝", "禁止", "patch", "allowPatch", "权限"]),
          expectRejected(
            () =>
              master.fs.mkdir("s-fs-policy", "public/created-dir", {
                timeoutMs: scaleMs(2000),
                recursive: true,
              }),
            ["拒绝", "禁止", "upload", "allowUpload", "权限"],
          ),
          expectRejected(
            () =>
              master.fs.create("s-fs-policy", "public/created.txt", {
                timeoutMs: scaleMs(2000),
                recursive: true,
              }),
            ["拒绝", "禁止", "upload", "allowUpload", "权限"],
          ),
          expectRejected(
            () =>
              master.fs.upload(
                "s-fs-policy",
                uploadSource,
                "public/uploaded.txt",
                {
                  timeoutMs: scaleMs(2500),
                  chunkSize: 64 * 1024,
                },
              ),
            ["拒绝", "禁止", "upload", "allowUpload", "权限"],
          ),
        ]);

        runner.assert(
          blockedChecks.every((item) => item.matched),
          `路径与操作策略全部生效 → ${blockedChecks.map((item) => item.message).join(" | ")}`,
        );

        const stillExists = await master.fs.get(
          "s-fs-policy",
          "public/allowed.txt",
          {
            timeoutMs: scaleMs(2000),
          },
        );
        runner.assert(
          readFsBodyText(stillExists) === "allowed",
          `allowDelete=false 后文件仍存在 → "${readFsBodyText(stillExists)}"`,
        );

        runner.assert(
          !(await pathExists(downloadTarget)),
          "被拒绝的下载不应生成本地目标文件",
        );
      } finally {
        await safeStop(slave, master);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );

  await runner.test(
    "encrypted 模式：fs get + upload/download 正常",
    async () => {
      const EP_FS_ENC = "tcp://127.0.0.1:16042";
      const KEY = "fs-encrypted-key";
      const baseDir = path.resolve("test/tmp/fs-encrypted");
      const rootDir = path.join(baseDir, "remote");
      const uploadSource = path.join(baseDir, "secure-upload.txt");
      const downloadTarget = path.join(baseDir, "secure-downloaded.txt");

      await resetDir(baseDir);
      await fs.mkdir(rootDir, { recursive: true });
      await fs.writeFile(
        path.join(rootDir, "secure.txt"),
        "secret-hello",
        "utf8",
      );
      await fs.writeFile(uploadSource, "secret-upload-body", "utf8");

      const master = new ZNL({
        role: "master",
        id: "m-fs-enc",
        endpoints: { router: EP_FS_ENC },
        authKey: KEY,
        encrypted: true,
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-fs-enc",
        endpoints: { router: EP_FS_ENC },
        authKey: KEY,
        encrypted: true,
      });

      slave.fs.setRoot(rootDir);

      try {
        await master.start();
        await slave.start();
        await delay(300);

        const registered = await waitForRegistered(master, "s-fs-enc", {
          timeoutMs: 3000,
          intervalMs: 100,
        });
        runner.assert(
          registered,
          `encrypted fs slave 已注册 → ${master.slaves}`,
        );

        const secureGet = await master.fs.get("s-fs-enc", "secure.txt", {
          timeoutMs: scaleMs(2500),
        });
        runner.assert(
          readFsBodyText(secureGet) === "secret-hello",
          `encrypted get 正常 → "${readFsBodyText(secureGet)}"`,
        );

        const uploadResult = await master.fs.upload(
          "s-fs-enc",
          uploadSource,
          "enc-uploaded.txt",
          {
            timeoutMs: scaleMs(3500),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(uploadResult.ok === true, "encrypted upload 完成");

        const downloadResult = await master.fs.download(
          "s-fs-enc",
          "enc-uploaded.txt",
          downloadTarget,
          {
            timeoutMs: scaleMs(3500),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(downloadResult.ok === true, "encrypted download 完成");

        const downloadedText = await fs.readFile(downloadTarget, "utf8");
        runner.assert(
          downloadedText === "secret-upload-body",
          `encrypted download 内容正确 → "${downloadedText}"`,
        );
      } finally {
        await safeStop(slave, master);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );

  await runner.test(
    "plain 模式：fs 与普通 RPC/PUBLISH/PUSH 并发时互不串线",
    async () => {
      const EP_FS_MIXED = "tcp://127.0.0.1:16044";
      const baseDir = path.resolve("test/tmp/fs-mixed-plain");
      const rootDir = path.join(baseDir, "remote");
      const uploadSource = path.join(baseDir, "mixed-upload.txt");

      await resetDir(baseDir);
      await fs.mkdir(rootDir, { recursive: true });
      await fs.writeFile(path.join(rootDir, "alpha.txt"), "alpha-body", "utf8");
      await fs.writeFile(uploadSource, "upload-mixed-body", "utf8");

      const master = new ZNL({
        role: "master",
        id: "m-fs-mixed",
        endpoints: { router: EP_FS_MIXED },
        maxPending: 200,
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-fs-mixed",
        endpoints: { router: EP_FS_MIXED },
        maxPending: 200,
      });

      const publishLog = [];
      const pushLog = [];

      master.ROUTER(async ({ payload }) => `MIXED-M:${toText(payload)}`);
      slave.DEALER(async ({ payload }) => `MIXED-S:${toText(payload)}`);
      slave.SUBSCRIBE("mixed-news", ({ payload }) =>
        publishLog.push(toText(payload)),
      );
      master.on("push", ({ identityText, topic, payload }) => {
        pushLog.push(`${identityText}:${topic}:${toText(payload)}`);
      });

      slave.fs.setRoot(rootDir);

      try {
        await master.start();
        await slave.start();
        await delay(300);

        const registered = await waitForRegistered(master, "s-fs-mixed", {
          timeoutMs: 3000,
          intervalMs: 100,
        });
        runner.assert(
          registered,
          `mixed plain slave 已注册 → ${master.slaves}`,
        );

        const slaveRpcTasks = Array.from({ length: 12 }, (_, i) =>
          slave.DEALER(`plain-s2m-${i}`, { timeoutMs: scaleMs(3000) }),
        );
        const masterRpcTasks = Array.from({ length: 12 }, (_, i) =>
          master.ROUTER("s-fs-mixed", `plain-m2s-${i}`, {
            timeoutMs: scaleMs(3000),
          }),
        );
        const fsGetTasks = Array.from({ length: 8 }, () =>
          master.fs.get("s-fs-mixed", "alpha.txt", {
            timeoutMs: scaleMs(2500),
          }),
        );

        const uploadPromise = master.fs.upload(
          "s-fs-mixed",
          uploadSource,
          "uploaded-mixed.txt",
          {
            timeoutMs: scaleMs(3500),
            chunkSize: 128 * 1024,
          },
        );

        const listPromise = master.fs.list("s-fs-mixed", ".", {
          timeoutMs: scaleMs(2500),
        });

        const eventsPromise = (async () => {
          master.PUBLISH("mixed-news", "plain-news-1");
          slave.PUSH("mixed-metrics", "cpu=0.77");
          await delay(200);
        })();

        const [
          slaveRpcResults,
          masterRpcResults,
          fsGetResults,
          uploadResult,
          listResult,
        ] = await Promise.all([
          Promise.all(slaveRpcTasks),
          Promise.all(masterRpcTasks),
          Promise.all(fsGetTasks),
          uploadPromise,
          listPromise,
          eventsPromise,
        ]);

        runner.assert(
          slaveRpcResults.every(
            (value, i) => toText(value) === `MIXED-M:plain-s2m-${i}`,
          ),
          `slave→master 并发 RPC 全部正确 → ${slaveRpcResults.length} 条`,
        );

        runner.assert(
          masterRpcResults.every(
            (value, i) => toText(value) === `MIXED-S:plain-m2s-${i}`,
          ),
          `master→slave 并发 RPC 全部正确 → ${masterRpcResults.length} 条`,
        );

        runner.assert(
          fsGetResults.every(
            (result) => readFsBodyText(result) === "alpha-body",
          ),
          `并发 fs.get 全部正确 → ${fsGetResults.length} 次`,
        );

        runner.assert(uploadResult.ok === true, "混合场景 upload 完成");

        runner.assert(
          Array.isArray(listResult.entries) &&
            listResult.entries.some((entry) => entry.name === "alpha.txt"),
          `混合场景 list 正常 → ${JSON.stringify(listResult.entries)}`,
        );

        const uploaded = await master.fs.get(
          "s-fs-mixed",
          "uploaded-mixed.txt",
          {
            timeoutMs: scaleMs(2500),
          },
        );
        runner.assert(
          readFsBodyText(uploaded) === "upload-mixed-body",
          `upload 后文件内容正确 → "${readFsBodyText(uploaded)}"`,
        );

        runner.assert(
          publishLog.length === 1 && publishLog[0] === "plain-news-1",
          `PUBLISH 未被 fs 串线影响 → ${publishLog.join(", ")}`,
        );

        runner.assert(
          pushLog.length === 1 &&
            pushLog[0] === "s-fs-mixed:mixed-metrics:cpu=0.77",
          `PUSH 未被 fs 串线影响 → ${pushLog.join(", ")}`,
        );
      } finally {
        await safeStop(slave, master);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );

  await runner.test(
    "encrypted 模式：fs 与普通 RPC/PUBLISH/PUSH 并发时互不串线",
    async () => {
      const EP_FS_MIXED_ENC = "tcp://127.0.0.1:16045";
      const KEY = "fs-mixed-encrypted-key";
      const baseDir = path.resolve("test/tmp/fs-mixed-encrypted");
      const rootDir = path.join(baseDir, "remote");
      const uploadSource = path.join(baseDir, "mixed-secure-upload.txt");

      await resetDir(baseDir);
      await fs.mkdir(rootDir, { recursive: true });
      await fs.writeFile(path.join(rootDir, "alpha.txt"), "alpha-body", "utf8");
      await fs.writeFile(uploadSource, "secure-upload-mixed", "utf8");

      const master = new ZNL({
        role: "master",
        id: "m-fs-mixed-enc",
        endpoints: { router: EP_FS_MIXED_ENC },
        authKey: KEY,
        encrypted: true,
        maxPending: 200,
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-fs-mixed-enc",
        endpoints: { router: EP_FS_MIXED_ENC },
        authKey: KEY,
        encrypted: true,
        maxPending: 200,
      });

      const publishLog = [];
      const pushLog = [];

      master.ROUTER(async ({ payload }) => `MIXED-ENC-M:${toText(payload)}`);
      slave.DEALER(async ({ payload }) => `MIXED-ENC-S:${toText(payload)}`);
      slave.SUBSCRIBE("enc-mixed-news", ({ payload }) =>
        publishLog.push(toText(payload)),
      );
      master.on("push", ({ identityText, topic, payload }) => {
        pushLog.push(`${identityText}:${topic}:${toText(payload)}`);
      });

      slave.fs.setRoot(rootDir);

      try {
        await master.start();
        await slave.start();
        await delay(350);

        const registered = await waitForRegistered(master, "s-fs-mixed-enc", {
          timeoutMs: 3000,
          intervalMs: 100,
        });
        runner.assert(
          registered,
          `mixed encrypted slave 已注册 → ${master.slaves}`,
        );

        const slaveRpcTasks = Array.from({ length: 8 }, (_, i) =>
          slave.DEALER(`enc-s2m-${i}`, { timeoutMs: scaleMs(3000) }),
        );
        const masterRpcTasks = Array.from({ length: 8 }, (_, i) =>
          master.ROUTER("s-fs-mixed-enc", `enc-m2s-${i}`, {
            timeoutMs: scaleMs(3000),
          }),
        );
        const fsGetTasks = Array.from({ length: 6 }, () =>
          master.fs.get("s-fs-mixed-enc", "alpha.txt", {
            timeoutMs: scaleMs(2500),
          }),
        );

        const uploadPromise = master.fs.upload(
          "s-fs-mixed-enc",
          uploadSource,
          "uploaded-mixed-enc.txt",
          {
            timeoutMs: scaleMs(3500),
            chunkSize: 128 * 1024,
          },
        );

        const eventsPromise = (async () => {
          master.PUBLISH("enc-mixed-news", "enc-news-1");
          slave.PUSH("enc-mixed-metrics", "cpu=0.91");
          await delay(220);
        })();

        const [slaveRpcResults, masterRpcResults, fsGetResults, uploadResult] =
          await Promise.all([
            Promise.all(slaveRpcTasks),
            Promise.all(masterRpcTasks),
            Promise.all(fsGetTasks),
            uploadPromise,
            eventsPromise,
          ]);

        runner.assert(
          slaveRpcResults.every(
            (value, i) => toText(value) === `MIXED-ENC-M:enc-s2m-${i}`,
          ),
          `encrypted slave→master 并发 RPC 全部正确 → ${slaveRpcResults.length} 条`,
        );

        runner.assert(
          masterRpcResults.every(
            (value, i) => toText(value) === `MIXED-ENC-S:enc-m2s-${i}`,
          ),
          `encrypted master→slave 并发 RPC 全部正确 → ${masterRpcResults.length} 条`,
        );

        runner.assert(
          fsGetResults.every(
            (result) => readFsBodyText(result) === "alpha-body",
          ),
          `encrypted 并发 fs.get 全部正确 → ${fsGetResults.length} 次`,
        );

        runner.assert(
          uploadResult.ok === true,
          "encrypted 混合场景 upload 完成",
        );

        const uploaded = await master.fs.get(
          "s-fs-mixed-enc",
          "uploaded-mixed-enc.txt",
          {
            timeoutMs: scaleMs(2500),
          },
        );
        runner.assert(
          readFsBodyText(uploaded) === "secure-upload-mixed",
          `encrypted upload 后内容正确 → "${readFsBodyText(uploaded)}"`,
        );

        runner.assert(
          publishLog.length === 1 && publishLog[0] === "enc-news-1",
          `encrypted PUBLISH 未被 fs 串线影响 → ${publishLog.join(", ")}`,
        );

        runner.assert(
          pushLog.length === 1 &&
            pushLog[0] === "s-fs-mixed-enc:enc-mixed-metrics:cpu=0.91",
          `encrypted PUSH 未被 fs 串线影响 → ${pushLog.join(", ")}`,
        );
      } finally {
        await safeStop(slave, master);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );
}
