import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../src/add.js";

test("add returns the sum of its arguments", () => {
  assert.equal(add(2, 3), 5);
});
