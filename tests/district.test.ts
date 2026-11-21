import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { findCaptchaUrl } from "../src/connectors/district.ts";

// fixtures/district/home.html is the real home page of services.ecourts.gov.in/ecourtindia_v6 (saved 2026-11-21).
test("district captcha URL resolves to the real securimage endpoint, not a doubled path", () => {
  const url = findCaptchaUrl(fixture("district/home.html"))!;
  assert.match(url, /^https:\/\/services\.ecourts\.gov\.in\/ecourtindia_v6\/vendor\/securimage\/securimage_show\.php\?[0-9a-f]{32}$/);
  assert.ok(!url.includes("/ecourtindia_v6/ecourtindia_v6/"), "old code produced a doubled path");
});

test("no captcha on the page → undefined (caller reports a layout change)", () => {
  assert.equal(findCaptchaUrl("<html><body>hello</body></html>"), undefined);
});
