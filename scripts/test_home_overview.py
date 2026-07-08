from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 414, 'height': 896}, device_scale_factor=2)
    page = ctx.new_page()

    logs = []
    page.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))

    # 1. Home page — verify card grid system
    page.goto('http://localhost:5173/')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1200)
    page.screenshot(path='/tmp/rein_home.png', full_page=True)
    print('HOME_TITLE:', page.title())

    # Tab label should be 首页
    tab_labels = page.locator('.tab-label').all_text_contents()
    print('TAB_LABELS:', tab_labels)
    print('HAS_HOME_TAB:', '首页' in tab_labels)
    print('NO_HEALTH_TAB:', '健康' not in tab_labels)

    # Top bar title
    top_title = page.locator('.top-bar-title').first.inner_text()
    print('TOP_TITLE:', top_title)

    # Card grid + cells present (default 3 cards)
    grid_count = page.locator('.card-grid').count()
    print('CARD_GRID:', grid_count)
    cell_count = page.locator('.card-cell').count()
    print('CARD_CELLS:', cell_count)

    # Edit FAB present (pen icon)
    fab = page.locator('.edit-fab').count()
    print('EDIT_FAB:', fab)

    # 2. Enter edit mode via FAB
    page.locator('.edit-fab').first.click()
    page.wait_for_timeout(600)
    page.screenshot(path='/tmp/rein_home_edit.png', full_page=True)
    toolbar = page.locator('.edit-toolbar').count()
    print('EDIT_TOOLBAR:', toolbar)
    delete_btns = page.locator('.card-delete').count()
    resize_btns = page.locator('.card-resize').count()
    print('DELETE_BTNS:', delete_btns)
    print('RESIZE_BTNS:', resize_btns)

    # 3. Click 三环数据 sheet
    page.locator('.tool-btn', has_text='三环数据').first.click()
    page.wait_for_timeout(500)
    ring_sheet = page.locator('.ring-sheet').count()
    print('RING_SHEET:', ring_sheet)
    page.screenshot(path='/tmp/rein_ring_sheet.png', full_page=True)
    page.locator('.close-btn').first.click()
    page.wait_for_timeout(400)

    # 4. Click 添加卡片 sheet
    page.locator('.tool-btn--primary', has_text='添加卡片').first.click()
    page.wait_for_timeout(500)
    add_sheet = page.locator('.add-sheet').count()
    print('ADD_SHEET:', add_sheet)
    entries = page.locator('.card-entry').count()
    print('CARD_ENTRIES:', entries)
    page.screenshot(path='/tmp/rein_add_sheet.png', full_page=True)
    # Close sheet
    page.locator('.close-btn').first.click()
    page.wait_for_timeout(400)

    # 5. Exit edit mode
    page.locator('.tool-btn--done').first.click()
    page.wait_for_timeout(400)
    print('AFTER_EXIT_EDIT_TOOLBAR:', page.locator('.edit-toolbar').count())

    # 6. Click health-overview card → ring sheet opens
    page.locator('.card-cell').first.click()
    page.wait_for_timeout(500)
    print('RING_SHEET_AFTER_CLICK:', page.locator('.ring-sheet').count())
    page.screenshot(path='/tmp/rein_ring_via_card.png', full_page=True)

    errors = [l for l in logs if 'pageerror' in l or '[error]' in l]
    print('CONSOLE_ERRORS:', errors[:5])

    browser.close()
    print('DONE')
