#!/usr/bin/env python3
"""Record final.html animation as video using Playwright's built-in video recording."""
import asyncio
import os
import shutil
import sys

HTML_PATH = '/tmp/photos/table-skills/new/video/v2/final.html'
OUTPUT = '/tmp/photos/table-skills/new/video/v2'
RECORDING_DIR = f'{OUTPUT}/recording2'
os.makedirs(RECORDING_DIR, exist_ok=True)

async def record():
    from playwright.async_api import async_playwright
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 450, 'height': 800},
            device_scale_factor=2,
            record_video_dir=RECORDING_DIR,
            record_video_size={'width': 900, 'height': 1600},
        )
        page = await context.new_page()
        
        # Navigate to HTML file
        html_url = f'file://{HTML_PATH}'
        print(f'Loading {html_url}', flush=True)
        await page.goto(html_url, wait_until='networkidle')
        await page.wait_for_timeout(1000)
        
        # Take initial screenshot to verify
        await page.screenshot(path=f'{OUTPUT}/test_screenshot2.png')
        print('Initial screenshot taken', flush=True)
        
        # Click to start playback (for autoplay policy)
        try:
            await page.click('body', timeout=2000)
        except:
            pass
        
        # Wait a moment for animation to start
        await page.wait_for_timeout(500)
        
        # Let the animation play for 144 seconds
        print('Recording animation for 144 seconds...', flush=True)
        for sec in range(144):
            if sec % 15 == 0:
                print(f'  {sec}s / 144s', flush=True)
            await page.wait_for_timeout(1000)
        
        print('Done waiting, closing context to finalize video...', flush=True)
        
        # Close context to finalize the video
        await context.close()
        await browser.close()
        print('Browser closed', flush=True)

asyncio.run(record())
print('Recording complete!', flush=True)
