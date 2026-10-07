import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function installGuard() {
  const source = await readFile(
    new URL("../src/extensionErrorGuard.ts", import.meta.url),
    "utf8",
  );
  const script = source.match(/String\.raw`([\s\S]*)`;\s*$/)?.[1];
  assert.ok(script, "extension error guard script should be extractable");

  const listeners = new Map();
  const window = {
    addEventListener(type, listener, capture) {
      listeners.set(type, { listener, capture });
    },
  };
  vm.runInNewContext(script, { window });
  return listeners;
}

test("extension guard stops browser-extension script errors before the dev overlay", async () => {
  const listeners = await installGuard();
  let stopped = false;
  listeners.get("error").listener({
    error: new Error("Cannot redefine property: ethereum"),
    filename: "chrome-extension://wallet/evmAsk.js",
    stopImmediatePropagation() {
      stopped = true;
    },
  });

  assert.equal(listeners.get("error").capture, true);
  assert.equal(stopped, true);
});

test("extension guard does not hide application errors", async () => {
  const listeners = await installGuard();
  let stopped = false;
  listeners.get("error").listener({
    error: new Error("application failure"),
    filename: "http://localhost:3000/app.js",
    stopImmediatePropagation() {
      stopped = true;
    },
  });

  assert.equal(stopped, false);
});

test("extension guard also stops rejected promises originating in extensions", async () => {
  const listeners = await installGuard();
  let stopped = false;
  const reason = new Error("wallet injection failure");
  reason.stack = "Error: wallet injection failure\n    at chrome-extension://wallet/inpage.js:1:1";
  listeners.get("unhandledrejection").listener({
    reason,
    stopImmediatePropagation() {
      stopped = true;
    },
  });

  assert.equal(stopped, true);
});
