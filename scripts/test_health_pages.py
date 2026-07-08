from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 414, 'height': 896}, device_scale_factor=2)
    page = ctx.new_page()

    logs = []
    page.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))

    routes = ['/health/water', '/health/food', '/health/food-db', '/health/bmi']
    for r in routes:
        page.goto('http://localhost:5173' + r)
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(600)
        title = page.locator('.page-title').first.inner_text()
        print(r, '->', title)
        page.screenshot(path=f'/tmp/rein{r.replace("/", "_")}.png', full_page=True)

    # Quick add water
    page.goto('http://localhost:5173/health/water')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(500)
    page.locator('.quick-btn', has_text='+200ml').first.click()
    page.wait_for_timeout(400)
    ring_num = page.locator('.ring-num').first.inner_text()
    print('WATER_AFTER_ADD:', ring_num)
    page.screenshot(path='/tmp/rein_water_added.png', full_page=True)

    errors = [l for l in logs if 'pageerror' in l or '[error]' in l]
    print('CONSOLE_ERRORS:', errors[:5])
    browser.close()
    print('DONE')
