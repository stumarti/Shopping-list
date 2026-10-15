# 1. Build the React app. It's plain files, so build it once on the build machine for every platform.
FROM --platform=$BUILDPLATFORM node:22-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# 2. FastAPI serves the API, the built app and the browser helper script
FROM python:3.12-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="Shopping list" \
      org.opencontainers.image.description="A shared shopping list with Tesco and Dunnes basket filling" \
      org.opencontainers.image.version=$VERSION
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DB_PATH=/data/shopping.db \
    APP_VERSION=$VERSION FORWARDED_ALLOW_IPS=* PUID=10001 PGID=10001
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY userscript/shopping-list.user.js ./userscript/
COPY --from=frontend /frontend/dist ./static
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health')"
ENTRYPOINT ["entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
