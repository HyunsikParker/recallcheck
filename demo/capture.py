"""Capture the RecallCheck demo as timestamped phone-sized screenshots, one folder per scene.

Usage: python3 capture.py [base_url]   (default http://localhost:8801/)
       ONLY=s5_about python3 capture.py   (re-record the named scenes; the others still run, unrecorded, and
                                           keep their earlier frames and log entries)
Writes demo/build/frames/<scene>/fNNNN.jpg and demo/build/frames/log.json ([scene, index, ms]).
Screenshots are taken in a loop while the actions run, so the timeline is real time; build_video.py
later trims long static stretches and fits the narration.
"""
import asyncio, json, os, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

D = Path(__file__).resolve().parent
FR = D / "build" / "frames"
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8801/"
VW, VH = 412, 915
PHOTOS = D / "photos"
# The installed Python playwright expects an older headless shell build than the one in the cache.
HEADLESS = Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"

log, t0 = [], time.monotonic()
ONLY = set(filter(None, os.environ.get("ONLY", "").split(",")))


class Recorder:
    def __init__(self, page):
        self.page, self.task, self.scene = page, None, None

    async def _loop(self, scene, stop):
        out = FR / scene
        out.mkdir(parents=True, exist_ok=True)
        i = 0
        while not stop.is_set():
            t = time.monotonic()
            await self.page.screenshot(path=str(out / f"f{i:04d}.jpg"), type="jpeg", quality=92)
            log.append([scene, i, round((t - t0) * 1000, 1)])
            i += 1
            await asyncio.sleep(max(0.0, 0.1 - (time.monotonic() - t)))

    async def start(self, scene):
        self.stop = asyncio.Event()
        if ONLY and scene not in ONLY:
            self.task = None
            return
        self.task = asyncio.create_task(self._loop(scene, self.stop))
        await asyncio.sleep(0.2)

    async def end(self):
        await asyncio.sleep(0.3)
        self.stop.set()
        if self.task:
            await self.task


async def hold(s):
    await asyncio.sleep(s)


async def wheel(page, dy, steps=14, dt=0.035):
    await page.mouse.move(VW / 2, VH / 2)
    for _ in range(steps):
        await page.mouse.wheel(0, dy / steps)
        await asyncio.sleep(dt)
    await asyncio.sleep(0.25)


async def to_top(page):
    y = await page.evaluate("() => window.scrollY")
    if y > 0:
        await wheel(page, -y - 50, steps=10)


async def until(check, timeout=90, every=0.2):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if await check():
            return True
        await asyncio.sleep(every)
    raise TimeoutError("condition not met")


async def show_preview_then_results(page):
    """The page scrolls to the result on its own; step back to show the chosen photo first."""
    y = await page.evaluate("() => document.getElementById('photo-preview').getBoundingClientRect().top")
    await wheel(page, y - 90, steps=12)
    await hold(2.2)
    y = await page.evaluate("() => document.getElementById('results').getBoundingClientRect().top")
    await wheel(page, y - 12, steps=12)


async def label_done(page):
    """True once the label reader finished: a Label check panel or a final note."""
    if await page.locator("#results article.facts h3", has_text="Label check").count():
        return True
    note = page.locator("#label-note")
    if await note.count():
        txt = (await note.text_content()) or ""
        return not txt.startswith("Reading any label")
    return False


async def main():
    FR.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=str(HEADLESS) if HEADLESS.exists() else None)
        ctx = await browser.new_context(viewport={"width": VW, "height": VH}, device_scale_factor=2,
                                        color_scheme="light", is_mobile=True, has_touch=True)
        page = await ctx.new_page()
        page.on("console", lambda m: print("console:", m.type, m.text[:160]) if m.type in ("error", "warning") else None)
        await page.goto(BASE, wait_until="networkidle")
        rec = Recorder(page)

        # 1. Barcode from a saved photo of a package barcode.
        await rec.start("s1_barcode")
        await hold(2.5)
        await page.set_input_files("#barcode-file", str(D / "upc-681131328944.png"))
        await until(lambda: page.locator("#results article.facts").count())
        await hold(2.5)
        for _ in range(2):
            await wheel(page, 420)
            await hold(2.4)
        await rec.end()

        # 2. Photo search with a kettle that is not in the recall photos.
        await rec.start("s2_photo")
        await to_top(page)
        await page.click("#tab-photo")
        await hold(2.5)
        await page.set_input_files("#photo-file", str(PHOTOS / "kettle-demo.jpg"))
        await until(lambda: page.locator("#label-note").count(), timeout=120)
        await until(lambda: label_done(page), timeout=120)
        await hold(1.0)
        await show_preview_then_results(page)
        await hold(2.5)
        await wheel(page, 380)
        await hold(2.0)
        summ = page.locator("#results .match details summary").first
        if await summ.count():
            await summ.scroll_into_view_if_needed()
            await hold(0.8)
            await summ.click()
            await hold(3.0)
        await wheel(page, 420)
        await hold(2.0)
        await rec.end()

        # 3. A close photo of a label: the model number is read on the phone.
        await rec.start("s3_label")
        await to_top(page)
        await hold(1.0)
        await page.set_input_files("#photo-file", str(PHOTOS / "label-xy15302.jpg"))
        await until(lambda: label_done(page), timeout=120)
        await hold(1.0)
        await show_preview_then_results(page)
        await hold(3.0)
        await wheel(page, 360)
        await hold(3.0)
        await wheel(page, 360)
        await hold(2.0)
        await rec.end()

        # 4. Name search for a model number written without its dash.
        await rec.start("s4_name")
        await to_top(page)
        await page.click("#tab-name")
        await hold(1.0)
        await page.click("#name-input")
        await page.locator("#name-input").press_sequentially("KTCS17", delay=140)
        await hold(0.6)
        await page.press("#name-input", "Enter")
        await until(lambda: page.locator("#results article.facts").count())
        await hold(3.0)
        await wheel(page, 380)
        await hold(3.0)
        await rec.end()

        # 5. The measured results in "How the check works".
        await rec.start("s5_about")
        y = await page.evaluate("() => document.getElementById('how-title').getBoundingClientRect().top")
        await wheel(page, y - 16, steps=24)
        await hold(3.0)
        for _ in range(2):
            await wheel(page, 380)
            await hold(3.0)
        await rec.end()

        await browser.close()
    if ONLY:  # keep the earlier take of every scene that was not re-recorded
        log[:0] = [e for e in json.loads((FR / "log.json").read_text()) if e[0] not in ONLY]
    (FR / "log.json").write_text(json.dumps(log))
    by = {}
    for s, i, ms in log:
        by.setdefault(s, []).append(ms)
    print(json.dumps({s: {"frames": len(v), "seconds": round((v[-1] - v[0]) / 1000, 1)} for s, v in by.items()}))


asyncio.run(main())
