import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-recovery-test-"));
  const temp = path.join(root, "tmp");
  fs.mkdirSync(temp, { mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(temp, "openclaw-tg-test-credential-"));
  const receipt = path.join(directory, "lease.json");
  fs.writeFileSync(
    receipt,
    JSON.stringify({
      identity: {
        kind: "telegram-test-userbot",
        credentialId: "owned",
        ownerId: "test-owner",
        actorRole: "ci",
        leaseToken: "synthetic",
      },
      leaseTtlMs: 1200000,
      heartbeatIntervalMs: 30000,
    }),
    { mode: 0o600 },
  );
  const methods = [];
  let rejected = false;
  const server = http.createServer((request, response) => {
    methods.push(request.url.split("/").at(-1));
    request.resume();
    response.writeHead(rejected ? 409 : 200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        rejected
          ? { status: "error", code: "LEASE_EXPIRED", message: "expired" }
          : { status: "ok" },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    root,
    temp,
    directory,
    receipt,
    methods,
    rejectLease() {
      rejected = true;
    },
    async run(target = directory, command = "release") {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./telegram-test-recover.mjs", import.meta.url)), target, command],
        {
          env: {
            PATH: root + path.delimiter + process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: temp,
            OPENCLAW_QA_CONVEX_SITE_URL: `http://127.0.0.1:${server.address().port}`,
            OPENCLAW_QA_CONVEX_SECRET_CI: "synthetic",
            OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
          },
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const [code] = await once(child, "close");
      return { code, stdout, stderr };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("release removes its receipt but preserves unknown sibling files", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.directory, "operator-notes"), "keep", { mode: 0o600 });
    const result = await f.run();
    assert.equal(
      fs.existsSync(path.join(f.directory, "operator-notes")),
      true,
      "unrelated files must survive broker release",
    );
    assert.equal(fs.readFileSync(path.join(f.directory, "operator-notes"), "utf8"), "keep");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(f.receipt), false);
    assert.deepEqual(f.methods, ["heartbeat", "release"]);
  } finally {
    await f.close();
  }
});

for (const layout of ["wrong-root", "linked-directory", "linked-receipt", "linked-state"]) {
  test(`recovery rejects ${layout} before broker access or deletion`, async () => {
    const f = await fixture();
    try {
      let target = f.directory;
      if (layout === "wrong-root") {
        target = path.join(f.root, path.basename(f.directory));
        fs.renameSync(f.directory, target);
      } else if (layout === "linked-directory") {
        target = path.join(f.temp, "openclaw-tg-test-credential-link");
        fs.symlinkSync(f.directory, target);
      } else if (layout === "linked-receipt") {
        const saved = path.join(f.root, "saved-receipt");
        fs.renameSync(f.receipt, saved);
        fs.symlinkSync(saved, f.receipt);
      } else {
        fs.symlinkSync(f.root, path.join(f.directory, "state"));
      }
      const result = await f.run(target);
      assert.notEqual(result.code, 0);
      assert.equal(fs.existsSync(path.join(target, "lease.json")), true);
      assert.deepEqual(f.methods, []);
    } finally {
      await f.close();
    }
  });
}

test("expired recovery leaves its receipt and never releases a replacement", async () => {
  const f = await fixture();
  try {
    f.rejectLease();
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LEASE_EXPIRED/);
    assert.equal(fs.existsSync(f.receipt), true);
    assert.deepEqual(f.methods, ["heartbeat"]);
  } finally {
    await f.close();
  }
});

test("status revalidates a retained broker receipt after credential state was removed", async () => {
  const f = await fixture();
  try {
    const result = await f.run(f.directory, "status");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      leaseHealthy: true,
      credentialStatePresent: false,
      leaseReleased: false,
    });
    assert.equal(fs.existsSync(f.receipt), true);
    assert.deepEqual(f.methods, ["heartbeat"]);
  } finally {
    await f.close();
  }
});

test("failed group cleanup preserves both credential state and recovery receipt", async () => {
  const f = await fixture();
  try {
    const state = path.join(f.directory, "state");
    fs.mkdirSync(state, { mode: 0o700 });
    fs.mkdirSync(path.join(state, "user-driver"), { mode: 0o700 });
    fs.writeFileSync(
      path.join(state, "credentials.local.json"),
      JSON.stringify({ sutBotToken: "synthetic", sutBotId: "42", sutUsername: "sut" }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(f.root, "uv"),
      "#!/bin/sh\necho 'unconfirmed group creation' >&2\nexit 1\n",
      { mode: 0o700 },
    );
    const result = await f.run(f.directory, "cleanup-group");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unconfirmed group creation/);
    assert.equal(fs.existsSync(f.receipt), true);
    assert.equal(fs.existsSync(state), true);
    assert.deepEqual(f.methods, ["heartbeat"]);
  } finally {
    await f.close();
  }
});
