/**
 * Apify Actor: open start URLs with Playwright, follow an optional link
 * selector, and push one dataset item per page or per repeating element.
 * Screenshots are stored in the default key-value store when enabled.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Actor } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

await Actor.init();

try {
    const input = await readInput();
    const startUrls = normalizeStartUrls(input.startUrls);
    const maxPages = normalizeMaxPages(input.maxPages);
    const fields = normalizeFields(input.fields, input.selectors);
    const itemSelector = typeof input.itemSelector === 'string' ? input.itemSelector.trim() : '';
    const linkSelector = typeof input.linkSelector === 'string' ? input.linkSelector.trim() : '';
    const saveScreenshots = Boolean(input.saveScreenshots);

    if (!startUrls.length) {
        throw new Error('At least one start URL is required.');
    }

    const proxyConfiguration = input.proxyConfiguration
        ? await Actor.createProxyConfiguration(input.proxyConfiguration)
        : undefined;

    let itemCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: maxPages,
        maxConcurrency: 1,
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 120,
        launchContext: {
            launchOptions: {
                headless: true,
                args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
            },
        },
        async requestHandler({ page, request, enqueueLinks, log }) {
            const pageUrl = request.loadedUrl || request.url;
            const pageTitle = await page.title();
            let screenshotKey;

            if (saveScreenshots) {
                screenshotKey = screenshotKeyFor(pageUrl);
                const png = await page.screenshot({ fullPage: true, type: 'png' });
                await Actor.setValue(screenshotKey, png, { contentType: 'image/png' });
            }

            const extracted = await page.evaluate(extractFromDocument, {
                fields,
                itemSelector,
                pageUrl,
            });

            if (itemSelector && extracted.length === 0) {
                log.warning(`Item selector matched nothing on ${pageUrl}: ${itemSelector}`);
            }

            const rows = extracted.length > 0 ? extracted : [blankRow(fields)];
            for (const row of rows) {
                await Actor.pushData({
                    url: pageUrl,
                    pageTitle,
                    ...(screenshotKey ? { screenshotKey } : {}),
                    ...row,
                });
                itemCount += 1;
            }

            log.info(`Saved ${rows.length} item(s) from ${pageUrl}`);

            if (linkSelector) {
                await enqueueLinks({
                    selector: linkSelector,
                    strategy: 'same-hostname',
                });
            }
        },
    });

    await crawler.run(startUrls);
    console.log(`Finished. Saved ${itemCount} dataset item(s) from up to ${maxPages} page(s).`);
    await Actor.exit();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Actor.exit({ exitCode: 1, statusMessage: message });
}

async function readInput() {
    const fromStore = await Actor.getInput();
    if (fromStore && typeof fromStore === 'object') return fromStore;

    try {
        const raw = await readFile(new URL('../INPUT.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch {
        // No local sample input. The platform always supplies Actor input.
    }

    return {};
}

function normalizeStartUrls(value) {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    const sources = [];

    for (const entry of list) {
        if (typeof entry === 'string' && entry.trim()) {
            sources.push(assertHttpUrl(entry.trim()));
            continue;
        }
        if (entry && typeof entry.url === 'string' && entry.url.trim()) {
            sources.push({ ...entry, url: assertHttpUrl(entry.url.trim()) });
            continue;
        }
        if (entry && typeof entry.requestsFromUrl === 'string' && entry.requestsFromUrl.trim()) {
            assertHttpUrl(entry.requestsFromUrl.trim());
            sources.push({ ...entry, requestsFromUrl: entry.requestsFromUrl.trim() });
        }
    }

    return sources;
}

function assertHttpUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`Invalid URL: ${value}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Only http and https URLs are supported: ${value}`);
    }
    return value;
}

function normalizeMaxPages(value) {
    if (value == null || value === '') return 10;
    const maxPages = Number(value);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error('maxPages must be a positive integer.');
    }
    return maxPages;
}

function normalizeFields(fields, selectors) {
    const byName = new Map();

    if (Array.isArray(fields)) {
        for (const field of fields) addField(byName, field);
    }

    if (selectors && typeof selectors === 'object' && !Array.isArray(selectors)) {
        for (const [name, spec] of Object.entries(selectors)) {
            if (typeof spec === 'string') {
                addField(byName, { name, selector: spec });
            } else if (spec && typeof spec === 'object') {
                addField(byName, { name, selector: spec.selector, attribute: spec.attribute });
            }
        }
    }

    return Array.from(byName.values());
}

function addField(byName, field) {
    if (!field || typeof field !== 'object') return;
    const name = String(field.name || field.key || '').trim();
    const selector = String(field.selector || field.css || '').trim();
    if (!name || !selector) return;
    if (RESERVED_NAMES.has(name) || !FIELD_NAME.test(name)) {
        throw new Error(`Field name "${name}" must start with a letter or underscore and contain only letters, numbers, and underscores.`);
    }
    const attribute = field.attribute == null ? '' : String(field.attribute).trim();
    byName.set(name, { name, selector, attribute });
}

function blankRow(fields) {
    return Object.fromEntries(fields.map((field) => [field.name, null]));
}

function screenshotKeyFor(url) {
    const digest = createHash('sha1').update(url).digest('hex').slice(0, 12);
    return `SCREENSHOT-${digest}.png`;
}

/**
 * Runs in the browser. Returns one object per item selector match,
 * or a single object for the whole document when no item selector is set.
 */
function extractFromDocument({ fields, itemSelector, pageUrl }) {
    const readNode = (node, field) => {
        if (field.attribute) {
            const raw = node.getAttribute(field.attribute);
            if (raw == null) return null;
            const value = raw.trim();
            if (!value) return null;
            if (field.attribute === 'href' || field.attribute === 'src') {
                try {
                    return new URL(value, pageUrl).href;
                } catch {
                    return value;
                }
            }
            return value;
        }
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        return text || null;
    };

    const readField = (root, field) => {
        let nodes;
        try {
            nodes = Array.from(root.querySelectorAll(field.selector));
        } catch {
            return null;
        }
        const values = nodes.map((node) => readNode(node, field)).filter((value) => value != null);
        if (values.length === 0) return null;
        if (values.length === 1) return values[0];
        return values;
    };

    let roots = [document];
    if (itemSelector) {
        try {
            roots = Array.from(document.querySelectorAll(itemSelector));
        } catch {
            return [];
        }
    }

    return roots.map((root) => {
        const row = {};
        for (const field of fields) row[field.name] = readField(root, field);
        return row;
    });
}
