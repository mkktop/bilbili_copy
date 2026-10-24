import { test, expect, type Page } from "@playwright/test";

const work = (page: Page) => page.getByRole("navigation", {name:"工作区",exact:true});
const tools = (page: Page) => page.getByRole("navigation", {name:"应用工具",exact:true});
const settingsNav = (page: Page) => page.getByRole("navigation", {name:"设置分类",exact:true});
async function start(page: Page, query = "") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/workspace.html${query}`);
  await expect(page.getByRole("heading", {name:"把喜欢的内容留在身边",exact:true})).toBeVisible();
  await expect(page.locator(".overview-card strong").nth(2)).toHaveText(query.includes("empty") ? "0" : "89");
  return errors;
}
async function openSettings(page: Page) {
  await tools(page).getByRole("button", {name:"设置",exact:true}).click();
  await expect(page.getByRole("heading", {name:"通用设置",exact:true})).toBeVisible();
}

test("workspace uses persistent navigation and database-wide counts", async ({page}) => {
  const errors = await start(page);
  await expect(page.locator(".overview-card strong")).toHaveText(["15","96","89"]);
  await expect(work(page).getByRole("button", {name:"工作台",exact:true})).toHaveAttribute("aria-current","page");
  await expect(work(page).getByRole("button", {name:"下载管理",exact:true})).toContainText("15");
  await page.locator(".overview-card").nth(1).click();
  await expect(page.getByRole("navigation", {name:"下载状态筛选"}).getByRole("button", {name:/已完成/})).toHaveAttribute("aria-current","page");
  await expect(page.locator(".download-row")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("global login dialog works from the library rather than only homepage", async ({page}) => {
  const errors = await start(page);
  await work(page).getByRole("button", {name:"我的资料库",exact:true}).click();
  await expect(page.getByRole("heading", {name:"登录后查看你的内容",exact:true})).toBeVisible();
  await page.getByRole("button", {name:"登录 B 站",exact:true}).click();
  await expect(page.getByRole("dialog", {name:"B站账号登录",exact:true})).toBeVisible();
  await page.getByRole("button", {name:"关闭登录弹窗",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(work(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test("background jobs outside the current page refresh global counts", async ({page}) => {
  await start(page);
  await page.evaluate(async () => {
    const state = (window as any).__workspace;
    state.counts.downloading = 2;
    state.counts.done = 97;
    await state.emit("download://complete", {id:"background-job",output_path:"D:\\Videos\\background.mp4",size:1024});
  });
  await expect(page.locator(".overview-card strong")).toHaveText(["14","97","89"]);
  await expect(work(page).getByRole("button", {name:"下载管理",exact:true})).toContainText("14");
});

test("discovery navigation remains visible across discovery pages", async ({page}) => {
  const errors = await start(page);
  await work(page).getByRole("button", {name:"发现",exact:true}).click();
  const discovery = page.getByRole("navigation", {name:"发现内容导航"});
  await expect(page.getByRole("heading", {name:"搜索内容",exact:true})).toBeVisible();
  await discovery.getByRole("button", {name:"推荐",exact:true}).click();
  await expect(page.getByRole("heading", {name:"推荐视频",exact:true})).toBeVisible();
  await discovery.getByRole("button", {name:"排行榜",exact:true}).click();
  await expect(page.getByRole("heading", {name:"热门排行榜",exact:true})).toBeVisible();
  await expect(work(page).getByRole("button", {name:"发现",exact:true})).toHaveAttribute("aria-current","page");
  expect(errors).toEqual([]);
});

test("download filters include queued jobs and reject stale paginated responses", async ({page}) => {
  await start(page);
  await work(page).getByRole("button", {name:"下载管理",exact:true}).click();
  const filters=page.getByRole("navigation", {name:"下载状态筛选"});
  await expect(filters.getByRole("button", {name:/全部任务/})).toContainText("123");
  await filters.getByRole("button", {name:/排队中/}).click();
  await expect(filters.getByRole("button", {name:/排队中/})).toContainText("12");
  await expect(page.locator(".download-row")).toHaveCount(1);
  await expect(page.locator(".download-row")).toContainText("排队中");
  await page.evaluate(()=>{(window as any).__workspace.delayedFilters=true;});
  await filters.getByRole("button", {name:/下载中/}).click();
  await filters.getByRole("button", {name:/已完成/}).click();
  await expect(page.locator(".download-row")).toHaveCount(2);
  await page.waitForTimeout(600); // The older mocked RPC returns after the current filter.
  await expect(page.locator(".download-row")).toHaveCount(2);
  await expect(filters.getByRole("button", {name:/已完成/})).toHaveAttribute("aria-current","page");
});

test("filtered downloads replace completed jobs after queued jobs start", async ({page}) => {
  const errors=await start(page);
  await work(page).getByRole("button", {name:"下载管理",exact:true}).click();
  await page.getByRole("navigation", {name:"下载状态筛选"}).getByRole("button", {name:/下载中/}).click();
  await expect(page.locator(".download-row")).toHaveCount(1);
  await page.evaluate(async () => {
    const state=(window as any).__workspace;
    state.statusWriteDelay=300;
    state.downloads.find((item:any)=>item.id==="download-1").title="队列接续任务";
    state.counts.queued--;state.counts.done++;
    await state.emit("download://complete", {id:"download-0",output_path:"D:\\Videos\\finished.mp4",size:1024});
    await state.emit("download://state", {id:"download-1",status:"downloading"});
  });
  await expect(page.locator(".download-row")).toHaveCount(1);
  await expect(page.locator(".download-row")).toContainText("队列接续任务");
  expect(errors).toEqual([]);
});

test("a shrinking queue returns from an emptied last page to remaining jobs", async ({page}) => {
  await start(page);
  await page.evaluate(() => {
    const state=(window as any).__workspace;
    const seed=state.downloads[1];
    state.paginateDownloads=true;
    state.downloads=Array.from({length:21},(_,i)=>({...seed,id:`queue-${i}`,title:`排队任务 ${i+1}`}));
    state.counts={all:21,queued:21,downloading:0,paused:0,done:0,error:0};
  });
  await work(page).getByRole("button", {name:"下载管理",exact:true}).click();
  await page.getByRole("navigation", {name:"下载状态筛选"}).getByRole("button", {name:/排队中/}).click();
  await expect(page.locator(".download-row")).toHaveCount(20);
  await page.getByRole("button", {name:"下一页",exact:true}).click();
  await expect(page.locator(".download-row")).toHaveCount(1);
  await expect(page.locator(".download-row")).toContainText("排队任务 21");
  await page.evaluate(async () => {
    const state=(window as any).__workspace;
    state.counts.queued=20;state.counts.downloading=1;
    await state.emit("download://state", {id:"queue-20",status:"downloading"});
  });
  await expect(page.locator(".download-row")).toHaveCount(20);
  await expect(page.locator(".download-row").first()).toContainText("排队任务 1");
});

test("an empty page keeps pagination available when other records exist", async ({page}) => {
  await start(page);
  await page.evaluate(() => { (window as any).__workspace.downloads=[]; });
  await work(page).getByRole("button", {name:"下载管理",exact:true}).click();
  await expect(page.getByText("当前页暂时没有任务", {exact:true})).toBeVisible();
  await page.getByRole("button", {name:"下一页",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__workspace.calls.filter((c:any)=>c.cmd==="get_download_history").at(-1)?.args.page)).toBe(2);
});

for(const [link,destination] of [["https://www.bilibili.com/read/cv12345","下载管理"],["https://www.bilibili.com/opus/1234567890123456789","设置"]]) {
  test(`article overlay closes when navigating to ${destination}`, async ({page}) => {
    const errors=await start(page);
    await page.getByRole("textbox", {name:"B 站视频或专栏链接",exact:true}).fill(link);
    await page.getByRole("button", {name:"解析链接",exact:true}).click();
    await expect(page.getByRole("article").getByRole("heading", {name:"测试专栏文章",exact:true})).toBeVisible();
    const navigation=destination==="设置" ? tools(page) : work(page);
    await navigation.getByRole("button", {name:destination,exact:true}).click();
    await expect(page.getByRole("heading", {name:destination,exact:true})).toBeVisible();
    await expect(page.locator(".workspace-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("theme patches preserve unsaved settings and sticky save persists them", async ({page}) => {
  const errors=await start(page);await openSettings(page);
  const dir=page.getByRole("textbox", {name:"默认下载目录",exact:true});
  await dir.fill("D:\\MyEditedVideos");
  await page.getByRole("button", {name:"深色",exact:true}).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(dir).toHaveValue("D:\\MyEditedVideos");
  await settingsNav(page).getByRole("button", {name:"下载与文件",exact:true}).click();
  await expect(page.locator(".settings-footer")).toContainText("有尚未保存的修改");
  await page.getByRole("button", {name:"保存修改",exact:true}).click();
  await expect(page.getByRole("button", {name:"保存修改",exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).__workspace.settings.default_download_dir)).toBe("D:\\MyEditedVideos");
  expect(await page.evaluate(()=>(window as any).__workspace.settings.theme)).toBe("dark");
  expect(errors).toEqual([]);
});

test("settings save failures remain visible and keep user input", async ({page}) => {
  await start(page);await openSettings(page);
  const dir=page.getByRole("textbox", {name:"默认下载目录",exact:true});
  await dir.fill("D:\\PendingVideos");
  await page.evaluate(()=>{(window as any).__workspace.failSave=true;});
  await page.getByRole("button", {name:"保存修改",exact:true}).click();
  await expect(page.locator(".settings-footer").getByRole("alert")).toContainText("磁盘写入失败");
  await expect(dir).toHaveValue("D:\\PendingVideos");
  await page.evaluate(()=>{(window as any).__workspace.failSave=false;});
  await page.getByRole("button", {name:"保存修改",exact:true}).click();
  await expect(page.getByRole("button", {name:"保存修改",exact:true})).toBeDisabled();
});

test("unsaved settings require deliberate discard on navigation", async ({page}) => {
  await start(page);await openSettings(page);
  await page.getByRole("textbox", {name:"默认下载目录",exact:true}).fill("D:\\PendingVideos");
  page.once("dialog",dialog=>dialog.dismiss());
  await work(page).getByRole("button", {name:"工作台",exact:true}).click();
  await expect(page.getByRole("heading", {name:"通用设置",exact:true})).toBeVisible();
  page.once("dialog",dialog=>dialog.accept());
  await work(page).getByRole("button", {name:"工作台",exact:true}).click();
  await expect(page.getByRole("heading", {name:"把喜欢的内容留在身边",exact:true})).toBeVisible();
});

test("suggestions support keyboard selection and stay dismissed after search", async ({page}) => {
  await start(page);await work(page).getByRole("button", {name:"发现",exact:true}).click();
  const input=page.getByRole("combobox", {name:"搜索视频、UP 主或番剧"});
  await input.fill("旅行");await expect(page.getByRole("option", {name:"旅行 推荐",exact:true})).toBeVisible();
  await input.press("ArrowDown");await input.press("Enter");
  await expect.poll(()=>page.evaluate(()=>(window as any).__workspace.calls.filter((c:any)=>c.cmd==="search_videos").at(-1)?.args.keyword)).toBe("旅行 推荐");
  await expect(input).toHaveAttribute("aria-expanded","false");
  await page.waitForTimeout(400);
  await expect(input).toHaveAttribute("aria-expanded","false");
});

test("stale search suggestions cannot replace a newer term", async ({page}) => {
  await start(page);await work(page).getByRole("button", {name:"发现",exact:true}).click();
  await page.evaluate(()=>{(window as any).__workspace.suggestionRace=true;});
  const input=page.getByRole("combobox", {name:"搜索视频、UP 主或番剧"});
  await input.fill("旧词");
  await expect.poll(()=>page.evaluate(()=>(window as any).__workspace.calls.some((c:any)=>c.cmd==="get_search_suggest"&&c.args.term==="旧词"))).toBe(true);
  await input.fill("新词");await expect(page.getByRole("option", {name:"新词 推荐",exact:true})).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.getByRole("option", {name:"新词 推荐",exact:true})).toBeVisible();
  await expect(page.getByRole("option", {name:"旧词 推荐",exact:true})).toHaveCount(0);
});

test("search filters are optional and retain active values when collapsed", async ({page}) => {
  await start(page);await work(page).getByRole("button", {name:"发现",exact:true}).click();
  await expect(page.locator("#search-filters")).toHaveCount(0);
  await page.getByRole("button", {name:"筛选",exact:true}).click();
  await page.locator("#search-filters").getByRole("button", {name:"最新",exact:true}).click();
  await page.getByRole("button", {name:"筛选（1）",exact:true}).click();
  await expect(page.locator("#search-filters")).toHaveCount(0);
  await page.getByRole("combobox").fill("生活");
  await page.getByRole("button", {name:"搜索",exact:true}).last().click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__workspace.calls.filter((c:any)=>c.cmd==="search_videos").at(-1)?.args.order)).toBe("pubdate");
});

test("detail overlay preserves access to global navigation", async ({page}) => {
  await start(page);await page.locator(".home-recent-card").first().click();
  await expect(page.getByRole("heading", {name:"视频详情",exact:true})).toBeVisible();
  expect(await page.locator(".workspace-overlay").first().evaluate(el=>el.getBoundingClientRect().left)).toBe(196);
  await work(page).getByRole("button", {name:"下载管理",exact:true}).click();
  await expect(page.getByRole("heading", {name:"下载管理",exact:true})).toBeVisible();
  await expect(page.locator(".workspace-overlay")).toHaveCount(0);
});

test("empty library offers a useful next step", async ({page}) => {
  await start(page,"?empty=1");
  await expect(page.getByRole("heading", {name:"从第一个喜欢的视频开始",exact:true})).toBeVisible();
  await page.getByRole("button", {name:"去发现内容",exact:false}).click();
  await expect(page.getByRole("combobox")).toBeVisible();
});

test("800px pages fit viewport with compact navigation and accessible save controls", async ({page}) => {
  await page.setViewportSize({width:800,height:600});const errors=await start(page,"?logged=1&dark=1");
  expect(await page.locator(".app-sidebar").evaluate(el=>el.getBoundingClientRect().width)).toBe(72);
  for(const label of ["下载管理","发现","我的资料库"]) {
    await work(page).getByRole("button", {name:label,exact:true}).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(800);
  }
  await openSettings(page);
  for(const label of ["通用设置","画质与编码","下载与文件","字幕与弹幕"]) {
    await settingsNav(page).getByRole("button", {name:label,exact:true}).click();
    const dimensions=await page.locator(".settings-content").evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width+1);
    const rect=(await page.getByRole("button", {name:"保存修改",exact:true}).boundingBox())!;
    expect(rect.y+rect.height).toBeLessThanOrEqual(600);
  }
  expect(errors).toEqual([]);
});
