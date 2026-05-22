const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const readline = require('readline');

const startUrl = process.argv[2];
const APP_ROOT = __dirname;
const DATA_ROOT = process.env.SCRAPER_HOME || APP_ROOT;
const OUTPUT_ROOT = path.join(DATA_ROOT, 'downloaded_site');
const OUTPUT_DIR = path.join(OUTPUT_ROOT, timestampName());
const USER_DATA_DIR = path.join(DATA_ROOT, 'browser_profile');

let browser;
let context;
let page;
let pageCount = 0;
const pages = [];
const downloaded = new Map();
const openPages = new Set();

main().catch(async (err) => {
  emit('error', err.message || String(err));
  await shutdown(1);
});

async function main() {
  if (!isHttpUrl(startUrl)) throw new Error('A valid http or https URL is required.');

  await fs.ensureDir(OUTPUT_DIR);
  await fs.ensureDir(USER_DATA_DIR);
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    acceptDownloads: true,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  browser = context.browser();

  context.on('page', (newPage) => {
    trackPage(newPage, 'New browser window detected');
  });

  for (const existingPage of context.pages()) trackPage(existingPage);
  page = newestOpenPage() || await context.newPage();
  trackPage(page);

  emit('state', { outputDir: OUTPUT_DIR, currentUrl: startUrl });
  emit('log', `Opening ${startUrl}`);
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    emit('error', `Could not open the start URL automatically: ${err.message || String(err)}`);
    emit('log', 'The browser is still open. Reload the page or type the URL manually, then continue from the app.');
  }
  emit('log', 'Use the browser normally. Log in and navigate first, then click "Scrape Current Page" when the page or popup you want is visible.');

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch (err) {
      emit('error', 'Invalid command received.');
      return;
    }

    try {
      if (command.action === 'scrape') await scrapeCurrentPage();
      if (command.action === 'next') await goToNextPage();
      if (command.action === 'finish') await shutdown(0);
    } catch (err) {
      emit('error', err.message || String(err));
    }
  });

  rl.on('close', () => {
    emit('log', 'Control input closed. Browser is still open; use Finish or Stop from the app if available.');
  });
}

function trackPage(newPage, message) {
  if (openPages.has(newPage)) return;
  openPages.add(newPage);
  page = newPage;

  newPage.on('download', async (download) => {
    const suggested = safeFileName(download.suggestedFilename() || 'download.bin');
    const target = path.join(OUTPUT_DIR, 'browser-downloads', suggested);
    await fs.ensureDir(path.dirname(target));
    await download.saveAs(target);
    emit('log', `Browser download saved: ${displayPath(target)}`);
  });

  newPage.on('close', () => {
    openPages.delete(newPage);
    if (page === newPage) page = newestOpenPage();
    if (page) {
      emit('state', { currentUrl: page.url() });
      return;
    }
    emit('error', 'All browser windows are closed. Start the scraper again to continue.');
  });

  newPage.on('framenavigated', (frame) => {
    if (frame === newPage.mainFrame() && page === newPage) {
      emit('state', { currentUrl: newPage.url() });
    }
  });

  newPage.on('popup', (popup) => {
    trackPage(popup, 'Popup window detected');
  });

  newPage.once('domcontentloaded', () => {
    page = newPage;
    emit('state', { currentUrl: newPage.url() });
  });

  newPage.bringToFront().catch(() => {});
  emit('state', { currentUrl: newPage.url() });
  if (message) emit('log', `${message}: ${newPage.url() || 'loading...'}`);
}

function newestOpenPage() {
  const candidates = Array.from(openPages).filter((item) => !item.isClosed());
  return candidates[candidates.length - 1] || null;
}

async function scrapeCurrentPage() {
  page = newestOpenPage();
  if (!page) throw new Error('No open browser page is available to scrape.');
  await page.bringToFront().catch(() => {});
  await settlePage();
  pageCount += 1;

  const url = page.url();
  const title = await page.title();
  const name = `page_${String(pageCount).padStart(3, '0')}`;

  emit('log', `Scraping visible page: ${url}`);

  const html = await page.content();
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const $ = cheerio.load(html, { decodeEntities: false });
  markScraperIds($);
  const assets = collectAssets($, url);

  for (const asset of assets) {
    const local = await downloadAsset(asset.url);
    if (!local) continue;

    asset.localPath = local.absolutePath;
    asset.relativePath = path.relative(OUTPUT_DIR, local.absolutePath).replace(/\\/g, '/');
    rewriteAssetReference($, asset);
  }

  const pageHtmlPath = path.join(OUTPUT_DIR, `${name}.html`);
  $('[data-scraper-id]').removeAttr('data-scraper-id');
  await fs.writeFile(pageHtmlPath, $.html());

  const textPath = path.join(OUTPUT_DIR, `${name}.txt`);
  await fs.writeFile(textPath, text);

  const screenshotPath = path.join(OUTPUT_DIR, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const savedPage = {
    title,
    url,
    htmlFile: path.basename(pageHtmlPath),
    textFile: path.basename(textPath),
    screenshotFile: path.basename(screenshotPath),
    assetCount: assets.filter((asset) => asset.localPath).length,
    assets: assets
      .filter((asset) => asset.localPath)
      .map((asset) => ({
        type: asset.type,
        url: asset.url,
        file: asset.relativePath,
      })),
  };

  pages.push(savedPage);
  await writeIndex();

  emit('page', {
    url,
    title,
    outputDir: OUTPUT_DIR,
    htmlFile: pageHtmlPath,
    textFile: textPath,
    assetCount: savedPage.assetCount,
  });
  emit('log', `Saved ${displayPath(pageHtmlPath)} with ${savedPage.assetCount} downloaded assets.`);
}

async function goToNextPage() {
  emit('log', 'Looking for a visible next-page link or button...');

  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    const next = candidates.find((el) => {
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('rel'),
        el.textContent,
        el.className,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      return visible && /\b(next|older|more|continue|>)\b|»|›/.test(label);
    });

    if (!next) return false;
    next.scrollIntoView({ block: 'center', inline: 'center' });
    next.click();
    return true;
  });

  if (!clicked) {
    emit('error', 'No next-page control was found. Use the browser to navigate, then scrape the current page.');
    return;
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await settlePage();
  emit('state', { currentUrl: page.url() });
  emit('log', `Moved to: ${page.url()}`);
}

async function settlePage() {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let previousHeight = 0;
      let stableTicks = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, Math.max(400, Math.floor(window.innerHeight * 0.7)));
        const height = document.documentElement.scrollHeight || document.body.scrollHeight;
        stableTicks = height === previousHeight ? stableTicks + 1 : 0;
        previousHeight = height;
        if (stableTicks >= 3 || window.scrollY + window.innerHeight >= height) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 250);
    });
  });
}

function collectAssets($, baseUrl) {
  const assets = [];
  const seen = new Set();

  const add = (type, url, selector, attr, original) => {
    const absolute = toAbsoluteUrl(url, baseUrl);
    if (!absolute || seen.has(`${selector}|${attr}|${absolute}`)) return;
    seen.add(`${selector}|${attr}|${absolute}`);
    assets.push({ type, url: absolute, selector, attr, original: original || url });
  };

  $('[src]').each((i, el) => add(tagType(el), $(el).attr('src'), domSelector(el, i), 'src'));
  $('[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    add(tagType(el), href, domSelector(el, i), 'href');
  });
  $('[poster]').each((i, el) => add('poster', $(el).attr('poster'), domSelector(el, i), 'poster'));
  $('object[data], embed[src]').each((i, el) => add(tagType(el), $(el).attr('data') || $(el).attr('src'), domSelector(el, i), $(el).attr('data') ? 'data' : 'src'));

  $('[srcset]').each((i, el) => {
    for (const item of parseSrcset($(el).attr('srcset'))) {
      add('srcset', item.url, domSelector(el, i), 'srcset', item.raw);
    }
  });

  $('[style]').each((i, el) => {
    for (const cssUrl of extractCssUrls($(el).attr('style'))) {
      add('inline-style', cssUrl, domSelector(el, i), 'style', cssUrl);
    }
  });

  $('style').each((i, el) => {
    for (const cssUrl of extractCssUrls($(el).html() || '')) {
      add('style-block', cssUrl, domSelector(el, i), 'style-block', cssUrl);
    }
  });

  return assets;
}

function markScraperIds($) {
  let count = 0;
  $('*').each((i, el) => {
    $(el).attr('data-scraper-id', `scraper-${count}`);
    count += 1;
  });
}

async function downloadAsset(url) {
  if (downloaded.has(url)) return downloaded.get(url);

  try {
    const parsed = new URL(url);
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim();
    const extension = extensionFor(parsed.pathname, contentType);
    const host = safeFileName(parsed.hostname);
    const pathname = parsed.pathname.endsWith('/') ? `${parsed.pathname}index${extension}` : parsed.pathname;
    const relative = path.join('assets', host, safePath(pathname, extension));
    const absolutePath = uniquePath(path.join(OUTPUT_DIR, relative));

    await fs.ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, response.data);

    const result = { absolutePath, contentType };
    downloaded.set(url, result);
    emit('log', `Downloaded asset: ${displayPath(absolutePath)}`);
    return result;
  } catch (err) {
    emit('error', `Failed asset: ${url}`);
    downloaded.set(url, null);
    return null;
  }
}

function rewriteAssetReference($, asset) {
  const el = $(asset.selector);
  if (!el.length || !asset.relativePath) return;

  if (asset.attr === 'style') {
    el.attr('style', String(el.attr('style') || '').replace(asset.original, asset.relativePath));
    return;
  }

  if (asset.attr === 'style-block') {
    el.text(String(el.html() || '').replace(asset.original, asset.relativePath));
    return;
  }

  if (asset.attr === 'srcset') {
    const current = String(el.attr('srcset') || '');
    el.attr('srcset', current.replace(asset.original, asset.relativePath));
    return;
  }

  el.attr(asset.attr, asset.relativePath);
}

async function writeIndex() {
  const pageList = pages
    .map((item, index) => {
      const assetRows = item.assets
        .map((asset) => `<li><span>${escapeHtml(asset.type)}</span><a href="${escapeAttr(asset.file)}">${escapeHtml(asset.file)}</a></li>`)
        .join('');

      return `<article>
        <h2>${index + 1}. ${escapeHtml(item.title || item.url)}</h2>
        <p><a href="${escapeAttr(item.url)}">${escapeHtml(item.url)}</a></p>
        <div class="links">
          <a href="${escapeAttr(item.htmlFile)}">Saved HTML</a>
          <a href="${escapeAttr(item.textFile)}">Extracted Text</a>
          <a href="${escapeAttr(item.screenshotFile)}">Screenshot</a>
        </div>
        <p>${item.assetCount} assets downloaded.</p>
        <ul>${assetRows || '<li>No downloadable assets found.</li>'}</ul>
      </article>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Scraped Site Export</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; color: #16202a; background: #f6f7f9; }
    header { padding: 28px 36px; background: #ffffff; border-bottom: 1px solid #d9dee5; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px; }
    article { background: #ffffff; border: 1px solid #d9dee5; border-radius: 8px; padding: 20px; margin-bottom: 18px; }
    h1, h2 { margin: 0 0 10px; }
    p { line-height: 1.5; }
    a { color: #0f5ea8; }
    .links { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
    .links a { padding: 8px 10px; border: 1px solid #b8c4d1; border-radius: 6px; text-decoration: none; background: #f8fbff; }
    li { margin: 7px 0; overflow-wrap: anywhere; }
    li span { display: inline-block; min-width: 86px; color: #506070; }
  </style>
</head>
<body>
  <header>
    <h1>Scraped Site Export</h1>
    <p>${pages.length} page${pages.length === 1 ? '' : 's'} saved in this run.</p>
  </header>
  <main>${pageList || '<p>No pages scraped yet.</p>'}</main>
</body>
</html>`;

  await fs.writeFile(path.join(OUTPUT_DIR, 'index.html'), html);
}

async function shutdown(code) {
  await writeIndex().catch(() => {});
  emit('log', `Finished. Open this file: ${path.join(OUTPUT_DIR, 'index.html')}`);
  if (browser) await browser.close().catch(() => {});
  process.exit(code);
}

function parseSrcset(value) {
  return String(value || '')
    .split(',')
    .map((part) => {
      const raw = part.trim();
      const url = raw.split(/\s+/)[0];
      return { raw, url };
    })
    .filter((item) => item.url);
}

function extractCssUrls(value) {
  const urls = [];
  const re = /url\((['"]?)(.*?)\1\)/gi;
  let match;
  while ((match = re.exec(String(value || '')))) urls.push(match[2]);
  return urls;
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value) return null;
  if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
  try {
    return new URL(value, baseUrl).href;
  } catch (err) {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function tagType(el) {
  const name = (el.name || '').toLowerCase();
  if (name === 'audio' || name === 'video' || name === 'source' || name === 'track') return 'media';
  if (name === 'img' || name === 'picture') return 'image';
  if (name === 'script') return 'script';
  if (name === 'link') return 'link';
  return name || 'asset';
}

function domSelector(el, index) {
  const id = el.attribs && el.attribs['data-scraper-id'];
  if (id) return `[data-scraper-id="${id}"]`;
  const name = el.name || '*';
  return `${name}:eq(${index})`;
}

function extensionFor(pathname, contentType) {
  const current = path.extname(pathname);
  if (current) return current;
  const map = {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'text/html': '.html',
    'application/pdf': '.pdf',
  };
  return map[contentType] || '.bin';
}

function safePath(pathname, extension) {
  const pieces = pathname
    .split('/')
    .filter(Boolean)
    .map((piece) => safeFileName(piece));
  if (!pieces.length) return `asset${extension}`;

  const last = pieces[pieces.length - 1];
  if (!path.extname(last)) pieces[pieces.length - 1] = `${last}${extension}`;
  return path.join(...pieces);
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let count = 2;
  while (fs.existsSync(`${base}_${count}${ext}`)) count += 1;
  return `${base}_${count}${ext}`;
}

function safeFileName(value) {
  return String(value || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 150);
}

function timestampName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function displayPath(filePath) {
  const relative = path.relative(DATA_ROOT, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function emit(type, payload) {
  const event = typeof payload === 'object' && payload !== null ? { type, ...payload } : { type, message: payload };
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
