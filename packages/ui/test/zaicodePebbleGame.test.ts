import assert from "node:assert/strict";
import test from "node:test";
import { LEVELS, newWorld, updateWorld } from "../src/zaicode/ZaicodePebbleGame.js";

test("Pebble Drop can clear every level and reach the win state", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5; // Every drop is a gold pebble at the player's starting position.
  try {
    const world = newWorld();
    const keys = new Set<string>();
    for (let level = 1; level <= LEVELS; level++) {
      let result: ReturnType<typeof updateWorld> = null;
      for (let frame = 0; frame < 20_000 && result === null; frame++) {
        result = updateWorld(world, keys, 40);
      }
      assert.equal(result, level === LEVELS ? "won" : "levelComplete", `level ${level}`);
      assert.equal(world.level, level);
      assert.equal(world.caught, 5 + level * 3);
      assert.equal(world.lives, 3);
      if (level < LEVELS) {
        // The Space key's next-level transition in GameSurface.
        world.level++;
        world.caught = 0;
        world.drops = [];
        world.spawnMs = 0;
      }
    }
    assert.ok(world.score > 0);
  } finally {
    Math.random = originalRandom;
  }
});

test("Pebble Drop loses after three caught hazards and a new world restarts", () => {
  const originalRandom = Math.random;
  const sequence = [0, 0.5, 0.5]; // hazard, centred X, speed
  let sample = 0;
  Math.random = () => sequence[sample++ % sequence.length];
  try {
    const world = newWorld();
    let result: ReturnType<typeof updateWorld> = null;
    for (let frame = 0; frame < 20_000 && result === null; frame++) {
      result = updateWorld(world, new Set<string>(), 40);
    }
    assert.equal(result, "gameOver");
    assert.equal(world.lives, 0);
    assert.deepEqual(newWorld(), {
      playerX: 160,
      score: 0,
      lives: 3,
      level: 1,
      caught: 0,
      spawnMs: 0,
      drops: [],
    });
  } finally {
    Math.random = originalRandom;
  }
});
