import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { BoothError } from "../errors.js";
import { getProfileDir } from "../profile.js";
import { persistBoothSession } from "../session-state.js";

const MANAGE_ORIGIN = "https://manage.booth.pm";

export type LoginBrowserCandidate =
  | { label: string; executablePath: string }
  | { label: string; channel: "chrome" | "msedge" };

export function getLoginBrowserCandidates(env: NodeJS.ProcessEnv = process.env): LoginBrowserCandidate[] {
  const candidates: LoginBrowserCandidate[] = [];
  if (env.BOOTH_MCP_BROWSER_PATH) {
    candidates.push({ label: "BOOTH_MCP_BROWSER_PATH", executablePath: env.BOOTH_MCP_BROWSER_PATH });
  }
  candidates.push({ label: "Google Chrome", channel: "chrome" });
  candidates.push({ label: "Microsoft Edge", channel: "msedge" });
  return candidates;
}

export async function runInteractiveLogin(timeoutMs = 10 * 60_000): Promise<void> {
  const profileDir = getProfileDir();
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const context = await launchLoginBrowser(profileDir);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${MANAGE_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    if (!(await isAuthenticated(page))) {
      process.stderr.write("브라우저에서 BOOTH 로그인을 완료해 주세요. 로그인 정보는 booth-library-mcp가 읽지 않습니다.\n");
      const deadline = Date.now() + timeoutMs;
      let authenticated = false;
      while (Date.now() < deadline) {
        for (const candidate of context.pages()) {
          if (await isAuthenticated(candidate)) {
            authenticated = true;
            break;
          }
        }
        if (authenticated) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (!authenticated) throw new BoothError("AUTH_REQUIRED", "10분 안에 로그인이 완료되지 않았습니다.");
    }
    await persistBoothSession(context);
  } finally {
    await context.close();
  }
}

async function launchLoginBrowser(profileDir: string): Promise<BrowserContext> {
  const failures: string[] = [];
  for (const candidate of getLoginBrowserCandidates()) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        headless: false,
        locale: "en-US",
        ...("executablePath" in candidate
          ? { executablePath: candidate.executablePath }
          : { channel: candidate.channel }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
      failures.push(`${candidate.label}: ${message}`);
    }
  }

  throw new Error(
    `로그인에 사용할 Chrome 또는 Edge를 실행하지 못했습니다. 브라우저를 설치하거나 BOOTH_MCP_BROWSER_PATH에 Chromium 계열 브라우저 실행 파일을 지정해 주세요.\n${failures.join("\n")}`,
  );
}

async function isAuthenticated(page: Page): Promise<boolean> {
  if (new URL(page.url()).hostname !== "manage.booth.pm") return false;
  return (await page.locator('a[href="/orders"], a[href="https://manage.booth.pm/orders"]').count()) > 0;
}
