#!/usr/bin/env python3
"""Record V4 HTML animation using Playwright + Chromium"""
import asyncio
import os
from playwright.async_api import async_playwright

HTML_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), 'html', 'index.html'))
RECORDING_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), 'recording'))
TOTAL_DUR = 143  # 138.383s + 5s buffer

async def main():
    os.makedirs(RECORDING_DIR, exist_ok=True)
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        )
        context = await browser.new_context(
            viewport={'width': 450, 'height': 800},
            record_video_dir=RECORDING_DIR,
            record_video_size={'width': 450, 'height': 800}
        )
        page = await context.new_page()
        
        # Load HTML file
        await page.goto(f'file://{HTML_PATH}')
        await page.wait_for_timeout(1000)
        
        # Click to start animation
        await page.click('#canvas')
        print("Recording started...")
        
        # Wait for entire animation + buffer
        await page.wait_for_timeout(TOTAL_DUR * 1000)
        
        # Close to save recording
        await context.close()
        await browser.close()
        print("Recording complete!")

if __name__ == '__main__':
    asyncio.run(main())
