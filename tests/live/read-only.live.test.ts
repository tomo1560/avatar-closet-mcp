import { describe, expect, it } from "vitest";
import { BoothService } from "../../src/service.js";

// Manual only: `npm run test:live` uses the real saved session. Never run in CI.
describe.runIf(process.env.BOOTH_MCP_LIVE === "1")("opt-in live smoke test", () => {
  it("checks the buyer session with one GET and without launching a browser", async () => {
    const service = new BoothService();
    try {
      const auth = await service.authStatus();
      expect(auth.data.authenticated).toBe(true);
    } finally {
      await service.close();
    }
  }, 30_000);
});
