import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the ship fitting workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>舰装格局 · 二维飞船配装工具<\/title>/i);
  assert.match(html, /配装工作台/);
  assert.match(html, /棋盘编辑/);
  assert.match(html, /模块绘制/);
  assert.match(html, /导出 JSON/);
  assert.match(html, /导入 JSON/);
  assert.match(html, /自动配装/);
  assert.match(html, /v1\.1\.0/);
  assert.match(html, /立即保存/);
  assert.match(html, /id="frontier-extension-error-guard"/);
  assert.match(html, /stopImmediatePropagation/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/);
});
