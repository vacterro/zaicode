const { chromium } = require('playwright');
const TARGET_URL = 'https://github.com/vacterro/saimail/settings';
(async () => {
  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 10000 });
    const body = await page.locator('body').innerText({ timeout: 10000 });
    const result = {
      url: page.url(),
      title: await page.title(),
      login_required: /Sign in to GitHub|Sign in · GitHub|Username or email address/i.test(body),
      settings_visible: /General|Social preview/.test(body),
      social_preview_visible: /Social preview/.test(body),
      file_input_count: await page.locator('input[type="file"]').count()
    };
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})();
