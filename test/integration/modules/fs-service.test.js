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
  waitForSlave,
} from "../helpers/common.js";

installTimeoutScaling();

export async function runFsServiceTests(runner) {
  runner.section("fs 内建服务");

  await runner.test(
    "plain 模式：fs CRUD + patch + upload/download 正常",
    async () => {
      const EP_FS = "tcp://127.0.0.1:16040";
      const baseDir = path.resolve("test/tmp/fs-plain");
      const rootDir = path.join(baseDir, "remote");
      const uploadSource = path.join(baseDir, "upload-source.txt");
      const downloadTarget = path.join(baseDir, "downloaded.txt");

      await resetDir(baseDir);
      await fs.mkdir(rootDir, { recursive: true });
      await fs.writeFile(
        path.join(rootDir, "hello.txt"),
        "hello\nworld\n",
        "utf8",
      );
      await fs.writeFile(uploadSource, "upload-body-001", "utf8");

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

        const registered = await waitForSlave(master, "s-fs", 3000);
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

        const uploadResult = await master.fs.upload(
          "s-fs",
          uploadSource,
          "uploaded.txt",
          {
            timeoutMs: scaleMs(3000),
            chunkSize: 128 * 1024,
          },
        );
        runner.assert(uploadResult.ok === true, "upload 完成");

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

      let error = null;
      try {
        await master.fs.get("s-fs-boundary", "../outside.txt", {
          timeoutMs: scaleMs(1500),
        });
      } catch (thrown) {
        error = thrown;
      }

      runner.assert(
        String(error?.message ?? error).includes("路径越权"),
        `越权访问被拒绝 → "${error?.message ?? error}"`,
      );
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

      let error = null;
      try {
        await master.fs.list("s-fs-no-root", ".", {
          timeoutMs: scaleMs(1500),
        });
      } catch (thrown) {
        error = thrown;
      }

      const message = String(error?.message ?? error);
      runner.assert(
        message.includes("fs root") ||
          message.includes("setRoot") ||
          message.includes("未注册的 service：fs"),
        `未配置 root 时返回明确错误 → "${message}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

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

        const registered = await waitForSlave(master, "s-fs-enc", 3000);
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

        const registered = await waitForSlave(master, "s-fs-mixed", 3000);
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
      await fs.writeFile(
        path.join(rootDir, "secure-alpha.txt"),
        "secure-alpha",
        "utf8",
      );
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

      master.ROUTER(async ({ payload }) => `EMIX-M:${toText(payload)}`);
      slave.DEALER(async ({ payload }) => `EMIX-S:${toText(payload)}`);
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

        const registered = await waitForSlave(master, "s-fs-mixed-enc", 3000);
        runner.assert(
          registered,
          `mixed encrypted slave 已注册 → ${master.slaves}`,
        );

        const slaveRpcTasks = Array.from({ length: 8 }, (_, i) =>
          slave.DEALER(`enc-s2m-${i}`, { timeoutMs: scaleMs(3500) }),
        );
        const masterRpcTasks = Array.from({ length: 8 }, (_, i) =>
          master.ROUTER("s-fs-mixed-enc", `enc-m2s-${i}`, {
            timeoutMs: scaleMs(3500),
          }),
        );
        const fsGetTasks = Array.from({ length: 6 }, () =>
          master.fs.get("s-fs-mixed-enc", "secure-alpha.txt", {
            timeoutMs: scaleMs(3000),
          }),
        );

        const uploadPromise = master.fs.upload(
          "s-fs-mixed-enc",
          uploadSource,
          "secure-uploaded-mixed.txt",
          {
            timeoutMs: scaleMs(4000),
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
            (value, i) => toText(value) === `EMIX-M:enc-s2m-${i}`,
          ),
          `encrypted slave→master 并发 RPC 全部正确 → ${slaveRpcResults.length} 条`,
        );

        runner.assert(
          masterRpcResults.every(
            (value, i) => toText(value) === `EMIX-S:enc-m2s-${i}`,
          ),
          `encrypted master→slave 并发 RPC 全部正确 → ${masterRpcResults.length} 条`,
        );

        runner.assert(
          fsGetResults.every(
            (result) => readFsBodyText(result) === "secure-alpha",
          ),
          `encrypted 并发 fs.get 全部正确 → ${fsGetResults.length} 次`,
        );

        runner.assert(
          uploadResult.ok === true,
          "encrypted 混合场景 upload 完成",
        );

        const uploaded = await master.fs.get(
          "s-fs-mixed-enc",
          "secure-uploaded-mixed.txt",
          {
            timeoutMs: scaleMs(3000),
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
