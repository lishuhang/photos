import asyncio
import os
from playwright.async_api import async_playwright

async def record_video():
    html_path = '/home/z/my-project/download/0610-video/html/index.html'
    output_path = '/home/z/my-project/download/0610-video/recording/recording.webm'
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 450, 'height': 800},
            record_video_dir='/home/z/my-project/download/0610-video/recording/',
            record_video_size={'width': 450, 'height': 800}
        )
        
        page = await context.new_page()
        
        # Navigate to HTML file
        await page.goto(f'file://{html_path}')
        await page.wait_for_timeout(500)
        
        # Click to start animation
        await page.click('#canvas')
        
        # Wait for the full animation duration plus buffer
        await page.wait_for_timeout(15000)
        
        await context.close()
        await browser.close()
    
    print(f'Recording complete!')
    
    # Check for the recorded video
    rec_dir = '/home/z/my-project/download/0610-video/recording/'
    for f in os.listdir(rec_dir):
        if f.endswith('.webm'):
            src = os.path.join(rec_dir, f)
            if f != 'recording.webm':
                os.rename(src, output_path)
            print(f'Video saved to: {output_path}')
            print(f'File size: {os.path.getsize(output_path)} bytes')

if __name__ == '__main__':
    asyncio.run(record_video())
