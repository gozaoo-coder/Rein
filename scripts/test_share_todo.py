from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 414, 'height': 896}, device_scale_factor=2)
    page = ctx.new_page()

    # Console log capture
    logs = []
    page.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))

    # 1. TodoPage
    page.goto('http://localhost:5173/todo')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(800)
    page.screenshot(path='/tmp/rein_todo.png', full_page=True)
    print('TODO_PAGE_TITLE:', page.title())

    # Verify calendar grid renders
    day_cells = page.locator('.day-cell').all()
    print('TODO_DAY_CELLS:', len(day_cells))

    # Try creating a todo
    try:
        page.locator('button.add-btn').first.click()
        page.wait_for_timeout(400)
        page.fill('input[placeholder="如：完成训练计划"]', '测试待办')
        page.wait_for_timeout(200)
        page.locator('button.primary-btn').last.click()
        page.wait_for_timeout(500)
        page.screenshot(path='/tmp/rein_todo_after_create.png', full_page=True)
        print('TODO_CREATE_OK')
    except Exception as e:
        print('TODO_CREATE_FAIL:', e)

    # 2. Profile menu entry
    page.goto('http://localhost:5173/profile')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(500)
    page.screenshot(path='/tmp/rein_profile.png', full_page=True)
    menu_items = page.locator('.menu-title').all_text_contents()
    print('PROFILE_MENUS:', menu_items)
    print('HAS_TODO_ENTRY:', '待办事项' in menu_items)

    # 3. Sports page (verify recent records list)
    page.goto('http://localhost:5173/sports')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(500)
    page.screenshot(path='/tmp/rein_sports.png', full_page=True)
    rec_rows = page.locator('.rec-row').all()
    print('SPORTS_REC_ROWS:', len(rec_rows))

    # 4. CourseEditPage share button (need an id - use any)
    page.goto('http://localhost:5173/sports')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(800)
    # Try clicking first course card
    try:
        page.locator('.course-card, .course-row').first.click()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(500)
        share_btns = page.locator('.share-btn').all()
        print('COURSE_SHARE_BTN:', len(share_btns))
        page.screenshot(path='/tmp/rein_course_edit.png', full_page=True)
    except Exception as e:
        print('COURSE_NAV_FAIL:', e)

    # 5. Verify ShareSheet opens from course edit
    try:
        if page.locator('.share-btn').count() > 0:
            page.locator('.share-btn').first.click()
            page.wait_for_timeout(500)
            share_sheet_visible = page.locator('.share-sheet').count() > 0
            print('SHARE_SHEET_VISIBLE:', share_sheet_visible)
            page.screenshot(path='/tmp/rein_share_sheet.png', full_page=True)
            page.locator('.close-btn').first.click()
            page.wait_for_timeout(300)
    except Exception as e:
        print('SHARE_OPEN_FAIL:', e)

    # Print captured console errors
    errors = [l for l in logs if 'pageerror' in l or '[error]' in l]
    print('CONSOLE_ERRORS:', errors[:5])

    browser.close()
    print('DONE')
