import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const { AutosaveScheduler } = await import("../src/persistence/autosaveScheduler.ts");

class FakeTimers {
  now = 0;
  nextId = 1;
  tasks = new Map();

  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, dueAt: this.now + delayMs });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  advanceBy(delayMs) {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.dueAt;
      task.callback();
    }
    this.now = target;
  }
}

test("bursty changes save once after five idle seconds", async () => {
  const timers = new FakeTimers();
  let saves = 0;
  const scheduler = new AutosaveScheduler(() => { saves += 1; }, 5_000, 30_000, timers);

  scheduler.schedule();
  timers.advanceBy(4_000);
  scheduler.schedule();
  timers.advanceBy(4_999);
  assert.equal(saves, 0);
  timers.advanceBy(1);
  await Promise.resolve();

  assert.equal(saves, 1);
  assert.equal(timers.tasks.size, 0);
});

test("continuous changes save at the thirty second maximum wait", async () => {
  const timers = new FakeTimers();
  let saves = 0;
  const scheduler = new AutosaveScheduler(() => { saves += 1; }, 5_000, 30_000, timers);

  scheduler.schedule();
  for (let elapsed = 4_000; elapsed < 30_000; elapsed += 4_000) {
    timers.advanceBy(4_000);
    scheduler.schedule();
  }
  timers.advanceBy(2_000);
  await Promise.resolve();

  assert.equal(saves, 1);
  assert.equal(timers.tasks.size, 0);
});

test("cancel prevents a pending autosave", async () => {
  const timers = new FakeTimers();
  let saves = 0;
  const scheduler = new AutosaveScheduler(() => { saves += 1; }, 5_000, 30_000, timers);

  scheduler.schedule();
  scheduler.cancel();
  timers.advanceBy(30_000);
  await Promise.resolve();

  assert.equal(saves, 0);
});
