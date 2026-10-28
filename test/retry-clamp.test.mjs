import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeErrorResponse } from "../src/provider.mjs";

test("sanitizeErrorResponse clamps excessive Retry-After header to 10 seconds", () => {
  const raw = new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "FreeUsageLimitError",
        message: "Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go",
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "42341", // Upstream long lockout pointing to UTC 00:00
      },
    },
  );

  const sanitized = sanitizeErrorResponse(raw);
  assert.equal(sanitized.status, 429);
  assert.equal(sanitized.headers.get("retry-after"), "10");
});

test("sanitizeErrorResponse preserves short Retry-After header <= 10 seconds", () => {
  const raw = new Response("{}", {
    status: 429,
    headers: { "retry-after": "5" },
  });

  const sanitized = sanitizeErrorResponse(raw);
  assert.equal(sanitized.status, 429);
  assert.equal(sanitized.headers.get("retry-after"), "5");
});

test("sanitizeErrorResponse preserves responses without Retry-After", () => {
  const raw = new Response("{}", {
    status: 500,
    headers: { "content-type": "application/json" },
  });

  const sanitized = sanitizeErrorResponse(raw);
  assert.equal(sanitized.status, 500);
  assert.equal(sanitized.headers.get("retry-after"), null);
});
