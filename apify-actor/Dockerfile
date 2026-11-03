# Playwright Actor base image (Chromium, Firefox, and WebKit) on Node.js 22.
# Pinned to the Playwright revision declared in package.json.
# https://docs.apify.com/actors/development/actor-definition/dockerfile
FROM apify/actor-node-playwright:22-1.64.1

# Install dependencies before copying source so image rebuilds stay cached.
COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
