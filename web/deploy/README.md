# Shopping list __VERSION__: Docker Compose package

This folder runs the shopping list from a ready-made image (`__IMAGE__`). Nothing is built on your server.

| File | What it's for |
|---|---|
| `docker-compose.yml` | The container: port, data folder, settings |
| `.env` | Your settings (a copy of `.env.example`) |
| `shopping-list.xml` | Optional: an Unraid template, if you'd rather use Unraid's own Docker page |
| `VERSION` | Which release this is |

After it starts, open `http://<server-ip>:8080`.

## Unraid with Compose Manager (recommended)

1. In **Apps**, install **Docker Compose Manager** (by dcflacon).
2. Go to **Docker**, scroll to **Compose**, and click **Add New Stack**. Name it `shopping-list`.
3. Click the stack's gear icon → **Edit Stack** → **Compose File**. Paste in `docker-compose.yml` from this folder and save.
4. Gear icon → **Edit Stack** → **Env File**. Paste in `.env` and change anything you need (usually nothing). Save.
5. Click **Compose Up**. The first start downloads the image.
6. Open `http://<unraid-ip>:8080`.

The list is stored in `/mnt/user/appdata/shopping-list`, so the **Appdata Backup** plugin backs it up with everything else.

**Update:** gear icon → **Update Stack** (pulls the newest image and restarts). Your list is kept.

## Unraid without plugins (Docker template)

1. Copy `shopping-list.xml` to the flash drive at `/boot/config/plugins/dockerMan/templates-user/my-shopping-list.xml`. For example, open **Terminal** and run:
   ```sh
   cp /path/to/shopping-list/shopping-list.xml /boot/config/plugins/dockerMan/templates-user/my-shopping-list.xml
   ```
2. **Docker** → **Add Container** → **Template**: choose **shopping-list**. Check the port and data folder, then **Apply**.

## Any machine with Docker Compose

```sh
unzip shopping-list-unraid-__VERSION__.zip
cd shopping-list
nano .env          # set DATA_DIR (e.g. ./data) and PUID/PGID to your user: `id -u`, `id -g`
docker compose up -d
docker compose logs -f        # Ctrl+C to stop watching
```

| Task | Command |
|---|---|
| Update to the newest image | `docker compose pull && docker compose up -d` |
| Stop | `docker compose down` (your list stays in `DATA_DIR`) |
| Back up | Copy the `DATA_DIR` folder (stop the container first for a clean copy) |
| Check it's healthy | `curl http://localhost:8080/api/health` |

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port the list is on |
| `DATA_DIR` | `/mnt/user/appdata/shopping-list` | Where the list is stored |
| `PUID` / `PGID` | `99` / `100` | Owner of `DATA_DIR` (Unraid's nobody:users) |
| `TZ` | `Europe/Dublin` | Time zone |
| `PUBLIC_URL` | (empty) | The address you open the list at, if a reverse proxy or Tailscale changes it. The browser helper uses it to update itself |
| `TESCO_SEARCH_URL`, `DUNNES_SEARCH_URL` | (empty) | Only if a store changes its search page. `{q}` is the search term |

## If the image won't download

If the GitHub repository is private, so is the image. Either make the package public on GitHub (**your profile → Packages → shopping-list-web → Package settings → Change visibility**), or sign in once on the server with a token that has `read:packages`:

```sh
docker login ghcr.io -u <your-github-username>
```

## The browser helper

In the list, open **Shop online** and follow **Install the browser helper**. It fills your Tesco or Dunnes basket from your list and stops at a full basket. It never checks out, pays or books a slot.

More: https://github.com/__REPO__/tree/main/web
