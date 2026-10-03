import { describe, expect, it } from "vitest";
import { publicDeliveryError, smtpFailureReasons } from "../src/delivery-errors.js";

describe("public delivery errors", () => {
  it("exposes known safe failure reasons", () => {
    for (const message of Object.values(smtpFailureReasons)) expect(publicDeliveryError(message)).toBe(message);
    expect(publicDeliveryError(null)).toBeNull();
  });
  it("does not expose historical raw provider errors", () => {
    expect(publicDeliveryError("SMTP rejected password=private-secret")).not.toContain("private-secret");
    expect(publicDeliveryError("SMTP authentication failed; private-secret")).not.toContain("private-secret");
  });
});
