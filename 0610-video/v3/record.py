import asyncio
import os
from playwright.async_api import async_playwright

async def record_video():
    html_path = '/home/z/my-project/download/0610-video/v3/html/index.html'
    output_path = '/home/z/my-project/download/0610-video/v3/recording/recording.webm'
    rec_dir = '/home/z/my-project/download/0610-video/v3/recording/'
    
    os.makedirs(rec_dir, exist_ok=True)
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 450, 'height': 800},
            record_video_dir=rec_dir,
            record_video_size={'width': 450, 'height': 800}
        )
        
        page = await context.new_page()
        await page.goto(f'file://{html_path}')
        await page.wait_for_timeout(500)
        await page.click('#canvas')
        await page.wait_for_timeout(160000)
        
        await context.close()
        await browser.close()
    
    # Find the generated video file and rename it
    for f in os.listdir(rec_dir):
        if f.endswith('.webm'):
            src = os.path.join(rec_dir, f)
            if f != 'recording.webm':
                os.rename(src, output_path)
            print(f'Video saved: {output_path}')

if __name__ == '__main__':
    asyncio.run(record_video())
