# Playwright's image already has Chromium and its system libraries. Keep the tag in step with the
# exact "playwright" version in package.json.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.0-noble
FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${PLAYWRIGHT_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PORT=8788 PROFILE_DIR=/data/profiles
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data/profiles && chown -R pwuser:pwuser /data
USER pwuser
VOLUME /data
EXPOSE 8788
CMD ["node", "dist/index.js"]
