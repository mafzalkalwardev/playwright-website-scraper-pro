# Playwright Website Scraper

Crawl public pages in a headless browser and extract structured fields with CSS selectors. Built with the [Apify SDK](https://docs.apify.com/sdk/js) and [Crawlee](https://crawlee.dev/) `PlaywrightCrawler`.

Each run opens your start URLs, optionally follows a pagination or other link selector on the same hostname, and stops after **Max pages**. Repeating blocks such as product cards can be split into one dataset item each. Full-page PNG screenshots are optional and are stored in the run's key-value store.

Use this Actor for pages you are allowed to access: catalogs, documentation, public listings, and other sites that permit automated collection.

## What it does

1. Opens each start URL in Chromium via Playwright.
2. Extracts the fields you define. With an **item selector**, each match becomes its own dataset row and field selectors run inside that element. Without one, the Actor saves a single row per page.
3. Enqueues links that match the **link selector** (same hostname only) until the page limit is reached.
4. When screenshots are on, saves `SCREENSHOT-<hash>.png` for each page and writes that key on the dataset items from the page.

A single CSS match is stored as a string. Several matches are stored as an array of strings. `href` and `src` attributes are resolved to absolute URLs.

## Input

| Field | Required | Description |
| --- | --- | --- |
| Start URLs | yes | One or more `http` or `https` URLs. |
| Max pages | no | Page loads to perform, including start URLs. Default `10`. |
| Fields | no | List of `{ name, selector, attribute }`. `attribute` is optional; empty means visible text. |
| Selectors | no | API alternative to Fields: an object whose keys are field names and whose values are a CSS selector string or `{ selector, attribute }`. |
| Item selector | no | CSS selector for a repeating block. One dataset item per match. |
| Link selector | no | CSS selector for links to follow, such as `li.next a`. Same hostname only. |
| Save screenshots | no | `true` stores a full-page PNG per crawled page. Default `false`. |

### Example input

This sample crawls the public [Books to Scrape](https://books.toscrape.com/) sandbox: two catalogue pages, one dataset row per book.

```json
{
  "startUrls": [
    { "url": "https://books.toscrape.com/" }
  ],
  "maxPages": 2,
  "itemSelector": "article.product_pod",
  "linkSelector": "li.next a",
  "fields": [
    { "name": "title", "selector": "h3 a", "attribute": "title" },
    { "name": "price", "selector": ".price_color" },
    { "name": "availability", "selector": ".availability" }
  ],
  "saveScreenshots": true
}
```

The same fields can be passed as a `selectors` object:

```json
{
  "startUrls": ["https://books.toscrape.com/"],
  "maxPages": 1,
  "itemSelector": "article.product_pod",
  "selectors": {
    "title": { "selector": "h3 a", "attribute": "title" },
    "price": ".price_color"
  },
  "saveScreenshots": false
}
```

## Output

Results are written to the default dataset. One object per extracted item:

```json
{
  "url": "https://books.toscrape.com/",
  "pageTitle": "All products | Books to Scrape - Sandbox",
  "screenshotKey": "SCREENSHOT-3060d727707e.png",
  "title": "A Light in the Attic",
  "price": "£51.77",
  "availability": "In stock"
}
```

`screenshotKey` is present only when **Save screenshots** is on. Download the PNG from the run's key-value store under that key.

Field names you define are added next to `url` and `pageTitle`. Names that are not in this example still appear in the dataset JSON.

## Run locally

From this directory, with Node.js 20 or newer:

```bash
npm install
npx playwright install chromium
npm start
```

`npm start` reads Apify local storage input when it exists, and otherwise uses `INPUT.json`. To call the Apify CLI instead:

```bash
apify run
```

## Deploy

From this directory, after `apify login`:

```bash
apify push
```

The image is `apify/actor-node-playwright:22-1.64.1`. Push builds it on the Apify platform. Set the Actor's pricing in Apify Console after the first push (see below).

## Pricing

Pricing: set in Apify Console.

## Legal

You must respect each target site's terms of service, robots.txt, and access rules, and you must follow applicable law (including copyright, privacy, and computer-misuse rules). Crawl only pages you are allowed to access. Do not use this Actor to break access controls, evade rate limits, or collect personal data without a lawful basis.

You are responsible for the URLs you submit and for how you use the extracted data. The author and Apify are not responsible for misuse.
