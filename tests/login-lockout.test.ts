import { describe, expect, it, vi } from "vitest";
import { checkLogin } from "../src/login-lockout.js";

describe("login lockouts", () => {
  it("locks each fifth failure, escalates, caps, and ignores attempts during a lock", async () => {
    const state = { failures: 0, level: 0, lockedUntil: 0 };
    let now = 1000;
    for (const seconds of [60, 300, 1500, 7500, 37500, 86400, 86400]) {
      for (let i = 0; i < 4; i++) expect(await checkLogin(state, async () => false, now)).toEqual({ allowed: false, retryAfterSeconds: 0 });
      expect(await checkLogin(state, async () => false, now)).toEqual({ allowed: false, retryAfterSeconds: seconds });
      const verify = vi.fn(async () => true);
      expect((await checkLogin(state, verify, now + 1)).allowed).toBe(false);
      expect(verify).not.toHaveBeenCalled();
      now = state.lockedUntil;
    }
    expect((await checkLogin(state, async () => true, now)).allowed).toBe(true);
    expect(state).toEqual({ failures: 0, level: 0, lockedUntil: 0 });
  });
});
