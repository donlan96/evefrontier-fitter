import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("daily launcher uses hidden production services with readiness checks", () => {
  const launcher = read("../scripts/start-local.ps1");
  const entry = read("../启动配装工具.bat");
  const wrapper = read("../scripts/launch-local.ps1");
  assert.match(launcher, /"start", "--hostname", "127\.0\.0\.1", "--port", "3000"/);
  assert.doesNotMatch(launcher, /"dev", "--hostname"/);
  assert.match(launcher, /-WindowStyle Hidden/g);
  assert.match(launcher, /http:\/\/127\.0\.0\.1:8765\/api\/health/);
  assert.match(launcher, /http:\/\/localhost:3000/);
  assert.match(launcher, /running-processes\.json/);
  assert.match(launcher, /Get-ListeningProcessId -Port 3000/);
  assert.match(launcher, /Get-ListeningProcessId -Port 8765/);
  assert.match(launcher, /Normalize-ProcessPath/);
  assert.match(launcher, /Test-PythonRuntime/);
  assert.match(launcher, /class="app"/);
  assert.match(launcher, /stylesheetMatch/);
  assert.match(launcher, /scriptMatch/);
  assert.match(launcher, /-Method Head/);
  assert.match(launcher, /text\/css/);
  assert.match(launcher, /java\|ecma/);
  assert.match(launcher, /\.cache\\codex-runtimes/);
  assert.match(launcher, /Preparing or repairing the local solver environment/);
  assert.match(launcher, /EVE Frontier Fitter is already ready/);
  assert.doesNotMatch(launcher, /--reload/);
  assert.match(entry, /start "" powershell\.exe/);
  assert.match(entry, /-WindowStyle Hidden/);
  assert.match(entry, /launch-local\.ps1/);
  assert.match(wrapper, /start-local\.ps1/);
  assert.match(wrapper, /http:\/\/localhost:3000/);
  assert.match(wrapper, /launcher\.log/);
  assert.match(wrapper, /WScript\.Shell/);
  assert.match(wrapper, /explorer\.exe/);
  assert.match(wrapper, /启动失败/);
});

test("local web server disables the Vite overlay", () => {
  const viteConfig = read("../vite.config.ts");
  assert.match(viteConfig, /hmr: \{ overlay: false \}/);
});

test("home page is never served from a stale browser cache", () => {
  const nextConfig = read("../next.config.ts");
  assert.match(nextConfig, /source: "\/"/);
  assert.match(nextConfig, /key: "Cache-Control", value: "no-store"/);
});

test("page guard keeps browser extension errors out of the vinext overlay", () => {
  const guard = read("../src/extensionErrorGuard.ts");
  assert.match(guard, /chrome\|moz/);
  assert.match(guard, /stopImmediatePropagation/);
  assert.match(guard, /unhandledrejection/);
});

test("daily stop script recovers managed listeners and remains PowerShell 5.1 safe", () => {
  const stopper = read("../scripts/stop-local.ps1");
  const entry = read("../停止配装工具.bat");
  assert.match(stopper, /running-processes\.json/);
  assert.match(stopper, /Get-ListeningProcessId -Port 3000/);
  assert.match(stopper, /Get-ListeningProcessId -Port 8765/);
  assert.match(stopper, /ProcessName -notin @\("node", "python", "python3"\)/);
  assert.match(stopper, /stop\.log/);
  assert.match(stopper, /Local fitting data was not changed/);
  assert.equal([...stopper].every((character) => character.charCodeAt(0) < 128), true);
  assert.match(entry, /-WindowStyle Hidden/);
  assert.match(entry, /-ShowMessage/);
});
