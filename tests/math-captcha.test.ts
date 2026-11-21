import { test } from "node:test";
import assert from "node:assert/strict";
import { solveMathCaptcha } from "../src/core/mathCaptcha.ts";

test("word arithmetic", () => {
  assert.equal(solveMathCaptcha("three plus five"), "8");
  assert.equal(solveMathCaptcha("Three Plus Five = ?"), "8");
  assert.equal(solveMathCaptcha("nine minus four"), "5");
  assert.equal(solveMathCaptcha("six times seven"), "42");
  assert.equal(solveMathCaptcha("six multiplied by seven"), "42");
  assert.equal(solveMathCaptcha("twelve divided by four"), "3");
  assert.equal(solveMathCaptcha("twenty-one plus nine"), "30");
  assert.equal(solveMathCaptcha("twenty one plus nine"), "30");
  assert.equal(solveMathCaptcha("twenty-one minus nine"), "12", "hyphen inside a number word is not 'minus'");
  assert.equal(solveMathCaptcha("six x seven"), "42", "x as a symbol");
  assert.equal(solveMathCaptcha("six times six"), "36", "the x inside 'six' is not a multiplication sign");
  assert.equal(solveMathCaptcha("six plus six"), "12");
  assert.equal(solveMathCaptcha("sixty minus six"), "54");
});

test("digit arithmetic with symbols", () => {
  assert.equal(solveMathCaptcha("3 + 5"), "8");
  assert.equal(solveMathCaptcha("12 - 4 = ?"), "8");
  assert.equal(solveMathCaptcha("12-4"), "8");
  assert.equal(solveMathCaptcha("7 x 3"), "21");
  assert.equal(solveMathCaptcha("7 × 3"), "21");
  assert.equal(solveMathCaptcha("8 / 2"), "4");
  assert.equal(solveMathCaptcha("What is 4 plus 9?"), "13");
});

test("the real AP captcha wording (an image reading \"27 plus 3\"), with and without spaces", () => {
  assert.equal(solveMathCaptcha("27 plus 3"), "30");
  assert.equal(solveMathCaptcha("27plus3"), "30");
  assert.equal(solveMathCaptcha("9 minus 4"), "5");
});

test("mixed words and digits", () => {
  assert.equal(solveMathCaptcha("four + 5"), "9");
});

test("negative results are returned as-is", () => assert.equal(solveMathCaptcha("two minus five"), "-3"));

test("unrecognisable or unsafe input returns null instead of guessing", () => {
  for (const v of ["", "hello", "three", "three plus", "plus five", "5 / 0", "7 / 2", "foo plus bar", "1 + 2 + 3"]) {
    assert.equal(solveMathCaptcha(v), null, JSON.stringify(v));
  }
});
