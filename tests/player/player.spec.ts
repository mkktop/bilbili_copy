import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const video = readFileSync(new URL("./fixtures/video.mp4", import.meta.url));
const audio = readFileSync(new URL("./fixtures/audio.mp4", import.meta.url));
const portrait = readFileSync(new URL("./fixtures/portrait.mp4", import.meta.url));

// Read real fMP4 fragment timestamps. Tests exercise ranged video + audio feeds,
// rather than replacing MediaSource or mocking HTMLMediaElement playback.
function seekIndex(file: Buffer) {
  function boxes(start: number, end: number): { start: number; size: number; type: string }[] {
    const found = [];
    for (let offset = start; offset + 8 <= end;) {
      const size = file.readUInt32BE(offset);
      if (size < 8 || offset + size > end) break;
      found.push({ start: offset, size, type: file.toString("ascii", offset + 4, offset + 8) });
      offset += size;
    }
    return found;
  }
  const top = boxes(0, file.length);
  const moov = top.find(b => b.type === "moov")!;
  const trak = boxes(moov.start + 8, moov.start + moov.size).find(b => b.type === "trak")!;
  const mdia = boxes(trak.start + 8, trak.start + trak.size).find(b => b.type === "mdia")!;
  const mdhd = boxes(mdia.start + 8, mdia.start + mdia.size).find(b => b.type === "mdhd")!;
  const timescale = file.readUInt32BE(mdhd.start + (file[mdhd.start + 8] === 1 ? 28 : 20));
  const points = top.filter(b => b.type === "moof").map(moof => {
    const traf = boxes(moof.start + 8, moof.start + moof.size).find(b => b.type === "traf")!;
    const tfdt = boxes(traf.start + 8, traf.start + traf.size).find(b => b.type === "tfdt")!;
    const time = file[tfdt.start + 8] === 1 ? Number(file.readBigUInt64BE(tfdt.start + 12)) : file.readUInt32BE(tfdt.start + 12);
    return { time_secs: time / timescale, byte: moof.start };
  });
  return { init_end: points[0].byte, points };
}
const indexes = { video: seekIndex(video), audio: seekIndex(audio) };

async function setup(page: Page, query = "") {
  const requests: { url: string; start: number; end: number }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(index => { (window as any).__seekIndex = index; }, query.includes("no-index") ? { video: null, audio: null } : indexes);
  await page.route("http://biliproxy.localhost/**", async route => {
    const request = route.request();
    const url = Buffer.from(new URL(request.url()).pathname.slice(3), "base64url").toString();
    const file = url.includes("audio") ? audio : query.includes("portrait") ? portrait : video;
    const [, s = "0", e] = request.headers().range?.match(/bytes=(\d+)-(\d*)/) ?? [];
    const start = Number(s), end = Math.min(e ? Number(e) : file.length - 1, file.length - 1);
    requests.push({ url, start, end });
    await route.fulfill({ status: 206, headers: {
      "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${file.length}`,
      "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range",
    }, body: file.subarray(start, end + 1) });
  });
  await page.goto(`/${query}`);
  return { requests, errors };
}

async function ready(page: Page) {
  await expect(page.getByText("正在准备视频…", { exact: true })).toBeHidden();
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 2);
}
async function pauseAt(page: Page, time: number) {
  await page.evaluate(t => { const v = document.querySelector("video")!; v.pause(); v.currentTime = t; }, time);
  await expect.poll(() => page.locator("video").evaluate(v => v.paused)).toBe(true);
}
async function quality(page: Page, label: string) {
  await page.getByRole("button", { name: "选择画质", exact: true }).click();
  await page.getByRole("group", { name: "画质选项" }).getByRole("button", { name: label, exact: true }).click();
}

test("ordinary layout preserves titlebar and uses custom controls", async ({ page }) => {
  const { errors } = await setup(page);
  await ready(page); await pauseAt(page, 0);
  expect(await page.locator("video").evaluate(v => v.controls)).toBe(false);
  expect(await page.locator(".watch-page").evaluate(el => el.getBoundingClientRect().top)).toBe(40);
  expect(await page.locator("#window-titlebar").evaluate(el => document.elementFromPoint(20, 20) === el)).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("第 1 集");
  await expect(page.getByLabel("选集与相关推荐")).toBeVisible();
  expect(errors).toEqual([]);
});

test("800px layout defaults to full-width video and can reveal episodes", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await setup(page); await ready(page); await pauseAt(page, 0);
  await expect(page.getByLabel("选集与相关推荐")).toHaveCount(0);
  expect(await page.locator(".watch-stage").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(740);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
  await page.getByRole("button", { name: "切换选集侧栏" }).click();
  await expect(page.getByLabel("选集与相关推荐")).toBeVisible();
  expect(await page.locator(".watch-sidebar").evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(
    await page.locator(".watch-details").evaluate(el => el.getBoundingClientRect().top));
});

test("quality changes preserve pause, speed and position and seek both streams by index", async ({ page }) => {
  const { requests, errors } = await setup(page); await ready(page);
  await page.getByRole("button", { name: "播放速度", exact: true }).click();
  await page.getByRole("group", { name: "倍速选项" }).getByRole("button", { name: "1.5×", exact: true }).click();
  await pauseAt(page, 6.8);
  const before = requests.length;
  await quality(page, "720P"); await ready(page);
  expect(await page.locator("video").evaluate(v => v.paused)).toBe(true);
  expect(await page.locator("video").evaluate(v => v.playbackRate)).toBe(1.5);
  expect(await page.locator("video").evaluate(v => v.currentTime)).toBeCloseTo(6.8, 1);
  const after = requests.slice(before);
  const vPoint = indexes.video.points.filter(p => p.time_secs <= 6.8).at(-1)!;
  const aPoint = indexes.audio.points.filter(p => p.time_secs <= 6.8).at(-1)!;
  expect(after.some(r => r.url.includes("720") && r.start === vPoint.byte)).toBe(true);
  expect(after.some(r => r.url.includes("audio") && r.start === aPoint.byte)).toBe(true);
  expect(errors).toEqual([]);
});

test("all fullscreen entries retain subtitles and danmaku", async ({ page }) => {
  await setup(page); await ready(page); await pauseAt(page, 1);
  await page.getByRole("button", { name: "播放设置", exact: true }).click();
  await page.getByRole("group", { name: "播放设置选项" }).getByRole("button", { name: "中文 AI" }).click();
  await expect(page.locator(".watch-subtitle")).toBeVisible();
  await page.getByRole("button", { name: "全屏（F）", exact: true }).click();
  expect(await page.evaluate(() => document.fullscreenElement?.classList.contains("watch-stage"))).toBe(true);
  expect(await page.evaluate(() => document.fullscreenElement?.querySelectorAll("canvas").length)).toBe(2);
  expect(await page.evaluate(() => !!document.fullscreenElement?.querySelector(".watch-subtitle"))).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await page.locator(".watch-stage").focus(); await page.keyboard.press("f");
  expect(await page.evaluate(() => document.fullscreenElement?.classList.contains("watch-stage"))).toBe(true);
});

test("Escape closes settings and sidebar before returning", async ({ page }) => {
  await setup(page); await ready(page); await pauseAt(page, 0);
  await page.getByRole("button", { name: "播放设置", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "播放设置选项" })).toHaveCount(0);
  await expect(page.getByLabel("选集与相关推荐")).toBeVisible();
  await page.locator(".watch-stage").focus(); await page.keyboard.press("Escape");
  await expect(page.getByLabel("选集与相关推荐")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fixture.backCount)).toBe(0);
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).__fixture.backCount)).toBe(1);
});

test("progress range supports keyboard and preview only appears over timeline", async ({ page }) => {
  await setup(page); await ready(page); await pauseAt(page, 2);
  const progress = page.getByRole("slider", { name: "播放进度" });
  await progress.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.locator("video").evaluate(v => v.currentTime)).toBeCloseTo(2.1, 1);
  await page.getByRole("button", { name: "静音（M）", exact: true }).hover();
  await expect(page.locator(".player-preview")).toHaveCount(0);
  await progress.hover(); await expect(page.locator(".player-preview")).toBeVisible();
});

test("mini mode and theater retain media session and scope keyboard shortcuts", async ({ page }) => {
  await setup(page); await ready(page); await pauseAt(page, 4);
  const src = await page.locator("video").evaluate(v => v.src);
  await page.getByRole("button", { name: "沉浸模式", exact: true }).click();
  expect(await page.locator("video").evaluate(v => v.src)).toBe(src);
  await page.getByRole("button", { name: "退出沉浸", exact: true }).click();
  await page.getByRole("button", { name: "播放设置", exact: true }).click();
  await page.getByRole("button", { name: "应用内小窗", exact: true }).click();
  await expect(page.locator(".watch-page--mini")).toBeVisible();
  expect(await page.locator("video").evaluate(v => v.src)).toBe(src);
  await page.locator("#underlying-button").focus(); await page.keyboard.press("Space");
  expect(await page.locator("video").evaluate(v => v.paused)).toBe(true);
  await page.getByRole("button", { name: "还原播放页", exact: true }).click();
  expect(await page.locator("video").evaluate(v => v.currentTime)).toBeCloseTo(4, 1);
});

test("error offers fresh-address retry", async ({ page }) => {
  await setup(page, "?error=1");
  await expect(page.getByRole("alert")).toContainText("HTTP 403");
  await page.evaluate(() => { (window as any).__fixture.failStreams = false; });
  await page.getByRole("button", { name: "重新获取并重试", exact: true }).click();
  await ready(page); await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fixture.calls.filter((c: any) => c.cmd === "get_play_streams").length)).toBeGreaterThan(1);
});

test("multi-part next and completion load correct cid and metadata", async ({ page }) => {
  await setup(page); await ready(page);
  await page.getByRole("button", { name: "下一集", exact: true }).click(); await ready(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("第 2 集");
  await page.evaluate(() => document.querySelector("video")!.dispatchEvent(new Event("ended"))); await ready(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("第 3 集");
  await page.getByRole("button", { name: "下载当前视频", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__fixture.downloads[0].cid)).toBe(3);
});

test("playlist switch and rapid quality switch ignore stale index requests", async ({ page }) => {
  const { errors } = await setup(page, "?playlist=1"); await ready(page); await pauseAt(page, 4);
  await page.evaluate(() => { (window as any).__fixture.slowIndex = true; });
  await quality(page, "720P");
  await quality(page, "1080P"); await ready(page);
  await expect(page.getByRole("button", { name: "选择画质" })).toHaveText("1080P");
  expect(await page.locator("video").evaluate(v => v.paused)).toBe(true);
  await page.getByRole("button", { name: /02.*第 2 集/ }).click(); await ready(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("第 2 集");
  expect(errors).toEqual([]);
});

test("AI chapter timestamps seek in the same player", async ({ page }) => {
  await setup(page); await ready(page); await pauseAt(page, 0);
  await page.getByRole("tab", { name: "AI 章节", exact: true }).click();
  await page.getByRole("button", { name: "0:04 在湖边停下脚步" }).click();
  await expect.poll(() => page.locator("video").evaluate(v => v.currentTime)).toBeCloseTo(4, 1);
});

test("quality switch without optional index falls back and stays paused", async ({ page }) => {
  await setup(page, "?no-index=1"); await ready(page); await pauseAt(page, 4);
  await quality(page, "720P"); await ready(page);
  expect(await page.locator("video").evaluate(v => v.currentTime)).toBeCloseTo(4, 1);
  expect(await page.locator("video").evaluate(v => v.paused)).toBe(true);
});

test("portrait video fits the stage and fullscreen from mini fills viewport", async ({ page }) => {
  await setup(page, "?portrait=1"); await ready(page); await pauseAt(page, 1);
  expect(await page.locator("video").evaluate(v => v.videoHeight > v.videoWidth)).toBe(true);
  expect(await page.locator(".watch-stage").evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThan(720);
  await page.getByRole("button", { name: "播放设置", exact: true }).click();
  await page.getByRole("button", { name: "应用内小窗", exact: true }).click();
  await page.getByRole("button", { name: "全屏（F）", exact: true }).click();
  await expect.poll(() => page.locator(".watch-stage").evaluate(el => el.getBoundingClientRect().height)).toBe(720);
});

test("dragging progress commits on release without repeated stream rebuilds", async ({ page }) => {
  await setup(page); await ready(page); await pauseAt(page, 1);
  const progress = page.getByRole("slider", { name: "播放进度" });
  const rect = (await progress.boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .1, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .65, rect.y + rect.height / 2, { steps: 8 });
  expect(await page.locator("video").evaluate(v => v.currentTime)).toBeCloseTo(1, 1);
  await page.mouse.up();
  await expect.poll(() => page.locator("video").evaluate(v => v.currentTime)).toBeGreaterThan(7);
});

test("part play button opens chosen part without selecting it for download", async ({ page }) => {
  await setup(page, "?detail=1");
  await page.getByRole("button", { name: "播放 第 2 集 · 山湖之间，记录一段安静的旅程", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__fixture.playRequests[0].cid)).toBe(2);
  await expect(page.getByText("分P列表（已选 0/3）", { exact: true })).toBeVisible();
});
