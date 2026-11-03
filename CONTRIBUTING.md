# Contributing

Thanks for working on Playwright Website Scraper Pro. Small, focused changes are the easiest to review.

## Ground rules

- Be respectful. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is the standard for this repo.
- Report security problems the way [SECURITY.md](SECURITY.md) describes. Do not open a public issue for them.
- Do not commit secrets, API keys, license tokens, `indus-license*.json`, or `data/indus_license_cache.json`.
- Do not commit browser profiles (`browser_profile/`), scrape output (`downloaded_site/`), or Actor storage (`apify-actor/storage/`).
- Crawl only pages you are allowed to access. Read the site's terms and robots.txt first.

## Setup

CI and the root Dockerfile use Node.js 20. [`apify-actor/package.json`](apify-actor/package.json) requires Node.js 20 or newer.

```bash
git clone https://github.com/mafzalkalwardev/playwright-website-scraper-pro.git
cd playwright-website-scraper-pro
npm install
```

`postinstall` runs `npx playwright install`. On Linux, Playwright may also need its system libraries (`npx playwright install-deps` with a privileged user) before Chromium will launch.

Start the Express UI:

```bash
INDUS_SKIP_LICENSE=1 npm start
```

The process listens on port 3000 unless `PORT` is set. The license check in `lib/indus_license.js` looks for `indus-license*.json` in the project directory or in `data/`. `INDUS_SKIP_LICENSE` values `1`, `true`, `yes`, and `on` skip that check.

Desktop GUI (Python 3 with Tkinter, which ships with most Python installs):

```bash
python desktop_app.py
```

Actor, from [`apify-actor/`](apify-actor/):

```bash
npm install
npx playwright install chromium
npm start
```

`npm start` there reads Apify local-storage input when it exists, and otherwise uses `INPUT.json`. Actor behavior is documented in [`apify-actor/README.md`](apify-actor/README.md).

`npm run build:exe` is the Windows-only packager in `scripts/build-exe.ps1`.

## Checks

```bash
npm test
```

`npm test` syntax-checks `server.js`, `scraper_engine.js`, `lib/indus_license.js`, `lib/indus_license_gate.js`, and `apify-actor/src/main.js`. There is no behavioral test suite in the repo yet. CI (`.github/workflows/ci.yml`) runs this on pull requests to `main`.

## Where things live

| Path | Role |
| --- | --- |
| `server.js` | Express UI and process control |
| `public/index.html` | Browser UI |
| `scraper_engine.js` | Headed Playwright capture |
| `desktop_app.py` | Tkinter UI |
| `lib/indus_license.js` | Startup license check |
| `apify-actor/` | Apify Actor (own `package.json`) |
| `scripts/build-exe.ps1` | Windows self-extracting build |
| `Dockerfile` | Root image, `node server.js` on port 5000 |

Two mismatches are worth knowing before you debug a fresh checkout:

- The server, the desktop app, the Windows build script, and `package.json` `"main"` name `Scraper.js`. The file in the tree is `scraper_engine.js`.
- `scraper_engine.js` mixes `require()` with a top-level `await`, so `node scraper_engine.js <url>` exits with `ERR_AMBIGUOUS_MODULE_SYNTAX`.
- `npm run app` calls `python app.py`. The GUI file that exists is `desktop_app.py`.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the change focused, and describe what changed and why.
3. Run `npm test`. If you touched `apify-actor/`, also run that package against a site you are allowed to crawl (the sample target in `INPUT.json` is `https://books.toscrape.com/`).
4. Open a pull request to `main`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
