# Deploying PastePage

This guide takes PastePage from "it runs on my laptop" to "my colleagues use it at `https://paste.example.com`". It assumes you have run a website before, but never a Node.js app.

The setup is the usual one for self-hosted Node apps:

```
  visitors' browsers
          │  https://paste.example.com
          ▼
  your web server: Caddy, nginx or Apache
  (ports 80 and 443, the HTTPS certificate)
          │  http://127.0.0.1:3000, inside the server only
          ▼
  PastePage (Node.js), sessions in memory
```

PastePage is a program that keeps running and listens on a port, like a database server. systemd keeps it running. Your web server stays in charge of ports 80 and 443 and the HTTPS certificate, and passes PastePage's traffic through. That arrangement is called a reverse proxy.

The commands below are for Debian and Ubuntu. On other Linux systems the ideas are the same; the package commands differ.

Contents:

1. [Install Node.js](#1-install-nodejs)
2. [Install PastePage](#2-install-pastepage)
3. [Run it as a systemd service](#3-run-it-as-a-systemd-service)
4. [Put it behind your web server](#4-put-it-behind-your-web-server): [Caddy](#caddy), [nginx](#nginx), [Apache](#apache)
5. [HTTPS and Let's Encrypt](#5-https-and-lets-encrypt)
6. [Hosting under a path](#6-hosting-under-a-path)
7. [Web server on another machine](#7-web-server-on-another-machine)
8. [Updating](#8-updating)
9. [Troubleshooting](#9-troubleshooting)
10. [What was tested](#10-what-was-tested)

## 1. Install Node.js

PastePage needs Node.js 22 or newer. Node 22 is the oldest Node.js line that still gets security fixes, until 30 April 2027. Node 24 is supported until 30 April 2028. Node 20 reached its end of life on 30 April 2026. (Dates from the Node.js [release schedule](https://github.com/nodejs/Release#release-schedule).) The automated tests are set up to run on Node 22 and 24.

Your distribution's own package is often too old: Ubuntu 24.04's `nodejs` package is version 18. Check what you have with `node --version`.

**On Debian and Ubuntu, use NodeSource.** [NodeSource](https://github.com/nodesource/distributions) provides current Node.js packages for apt. For Node 24:

```sh
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
sudo -E bash nodesource_setup.sh
sudo apt install -y nodejs
node --version
```

The setup script adds NodeSource's package repository; you can read `nodesource_setup.sh` before running it. Use `setup_22.x` instead for Node 22. This puts `node` in `/usr/bin`.

**Elsewhere,** see [nodejs.org/en/download](https://nodejs.org/en/download), which also offers ready-made Linux binaries.

**Install Node system-wide for the service.** Version managers such as nvm install Node inside your own home directory (`~/.nvm`). That is fine for trying PastePage, but the service in step 3 runs as its own user, cannot see home directories, and only looks for programs in `/usr/local/bin`, `/usr/bin` and the matching `sbin` directories. With NodeSource, or with Node's binaries installed so that `node` is in `/usr/local/bin`, it works.

## 2. Install PastePage

Pick one route.

**With npm** (the simplest):

```sh
sudo npm install -g pastepage
command -v pastepage
```

`command -v pastepage` prints where the `pastepage` command was installed, for example `/usr/bin/pastepage`. Note it down for step 3. (npm puts global commands in the `bin` folder of its "prefix", which by default is where Node itself is installed.)

**With git:**

```sh
sudo git clone https://github.com/sidebitio/pastepage.git /opt/pastepage
cd /opt/pastepage
sudo npm install
command -v node
```

`/opt/pastepage` is a good place: the service can't read home directories. `command -v node` prints where Node is, for example `/usr/bin/node`. Note it down for step 3.

Either way, you can try it right away with `pastepage` (or `npm start` in `/opt/pastepage`). It prints `PastePage running at http://127.0.0.1:3000/`. Stop it with Ctrl+C before you continue.

## 3. Run it as a systemd service

A systemd service starts PastePage when the server boots, restarts it if it crashes, and collects its log.

**Create a user** for it, so it doesn't run as root:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pastepage
```

That is a system account with no home directory that can't log in.

**Install the service file.** Copy [`deploy/pastepage.service`](../deploy/pastepage.service) from this repository (the npm package includes it too, in the `deploy` folder; for the npm route copy it with `sudo cp "$(npm root -g)/pastepage/deploy/pastepage.service" /etc/systemd/system/`) to `/etc/systemd/system/pastepage.service` and open it in an editor:

- **npm route:** set `ExecStart=` to the path from `command -v pastepage`, for example `ExecStart=/usr/bin/pastepage`.
- **git route:** remove the npm `ExecStart=` line and uncomment the two git lines. Set the `node` path to the one from `command -v node`:
  ```ini
  WorkingDirectory=/opt/pastepage
  ExecStart=/usr/bin/node /opt/pastepage/bin/pastepage.js
  ```

Use a full path in `ExecStart`. systemd does not use your login shell's search path; a bare name is only looked up in a fixed set of directories (`/usr/local/bin`, `/usr/bin` and their `sbin` counterparts, see `systemd.service(5)`), so a `pastepage` installed elsewhere would not be found.

The file, line by line:

| Line | Meaning |
|---|---|
| `Description=PastePage` | The name shown by `systemctl status`. |
| `After=network.target` | The usual ordering for network services: at shutdown, PastePage is stopped before the network is. |
| `User=pastepage` | Runs PastePage as the user you created. |
| `Environment=PORT=3000`, `Environment=HOST=127.0.0.1` | Settings. Add more `Environment=` lines for the other settings in the [README](../README.md#configuration). |
| `ExecStart=…` | The command that starts PastePage. |
| `WorkingDirectory=/opt/pastepage` | (git route) The directory it runs in, so a `.env` file there is read. |
| `Restart=on-failure` | Starts it again if it exits with an error or crashes. |
| `NoNewPrivileges=true` | PastePage and anything it starts can never gain more privileges. |
| `ProtectSystem=strict` | The whole file system (apart from `/dev`, `/proc` and `/sys`) is read-only for PastePage. It never writes files, so that's fine. |
| `ProtectHome=true` | `/home`, `/root` and `/run/user` are invisible to it. |
| `PrivateTmp=true` | It gets its own `/tmp` and `/var/tmp`, separate from other programs. |
| `WantedBy=multi-user.target` | `systemctl enable` makes it start at boot. |

**Start it:**

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pastepage
systemctl status pastepage
```

`daemon-reload` makes systemd read the new file. `enable --now` starts it now and at every boot. `status` should say `active (running)`, followed by the latest log lines, including `PastePage running at http://127.0.0.1:3000/`.

**Logs:**

```sh
sudo journalctl -u pastepage -f
```

PastePage logs only when it starts and stops, and unexpected errors. It never logs what people paste, session names or passwords.

**Settings.** With systemd, put settings in the service file as `Environment=NAME=value` lines, then run `sudo systemctl daemon-reload` and `sudo systemctl restart pastepage`. PastePage also reads a `.env` file from the directory it runs in. For a system service that is `/` unless `WorkingDirectory=` is set, so on the npm route use `Environment=` lines. On the git route a `.env` file in `/opt/pastepage` works too.

**Stopping and restarting:** `sudo systemctl stop pastepage` and `sudo systemctl restart pastepage`. systemd stops services with the SIGTERM signal, which PastePage handles by closing cleanly. Stopping or restarting deletes all sessions, because they only exist in memory.

## 4. Put it behind your web server

Pick the section for the web server you already have. If you don't have one yet, [Caddy](#caddy) is the easiest: it handles HTTPS by itself.

Only the Caddy sub-path setup has been tried behind a running web server; the nginx and Apache examples have not (see [What was tested](#10-what-was-tested)). Each line was checked against the web server's official documentation, which is linked.

PastePage needs four things from the web server:

- **Pass every request through** to `127.0.0.1:3000`, including the live connection at the path `ws`, which is a WebSocket.
- **Say who the visitor is** with the `X-Forwarded-For` header, so the abuse limits work per visitor (see [TRUST_PROXY](security.md#trust_proxy)).
- **Allow request bodies up to about 1.5 MB**, the largest encrypted note.
- **Keep long-lived connections open.** Each open page keeps one WebSocket. PastePage sends a ping on it every 20 seconds, so it is never idle for long.

### Caddy

Example file: [`deploy/Caddyfile`](../deploy/Caddyfile). On Debian and Ubuntu the Caddy package reads `/etc/caddy/Caddyfile`; after editing it, run `sudo systemctl reload caddy`.

**On its own subdomain:**

```
paste.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

- `paste.example.com {` is the site address. Caddy gets an HTTPS certificate for this name and redirects `http://` to `https://` ([automatic HTTPS](https://caddyserver.com/docs/automatic-https)).
- `reverse_proxy 127.0.0.1:3000` passes all requests to PastePage. According to the [reverse_proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), it supports WebSocket connections with no extra settings, and it sets `X-Forwarded-For` to the visitor's address while ignoring any `X-Forwarded-*` values the visitor sends.

**Under a path of an existing site** (`https://example.com/pastepage/`), add these lines to your site's block:

```
	redir /pastepage /pastepage/ 308
	handle_path /pastepage/* {
		reverse_proxy 127.0.0.1:3000
	}
```

- `redir /pastepage /pastepage/ 308` sends visitors who leave off the final slash to the right address ([redir](https://caddyserver.com/docs/caddyfile/directives/redir)). See [Hosting under a path](#6-hosting-under-a-path) for why the slash matters.
- `handle_path /pastepage/* { … }` handles everything under `/pastepage/` and removes the `/pastepage` prefix before passing the request on, so PastePage sees `/`, `/ws`, `/api/add` and so on ([handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path)).

Caddy closes open WebSocket connections when you reload its configuration. Open PastePage pages reconnect by themselves and catch up.

If you have limited request sizes in Caddy (the `request_body` directive), allow at least 2 MB for PastePage.

### nginx

Example file: [`deploy/nginx.conf`](../deploy/nginx.conf), for a path of an existing HTTPS site. The `location` blocks go inside your existing `server { }` block for that site. On Debian and Ubuntu, nginx reads the site files in `/etc/nginx/sites-enabled/`.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Sets `$connection_upgrade` to `upgrade` when the browser asks to switch to a WebSocket, and to `close` otherwise. This is the pattern from nginx's [WebSocket proxying](https://nginx.org/en/docs/http/websocket.html) guide. A `map` must be at the `http` level, outside any `server { }` block ([map](https://nginx.org/en/docs/http/ngx_http_map_module.html#map)). On Debian and Ubuntu, `/etc/nginx/nginx.conf` includes the files in `sites-enabled/` and `conf.d/` inside its `http { }` block, so the top of your site's file is fine. If your configuration already defines `$connection_upgrade`, for another app, don't add it a second time.

```nginx
location = /pastepage {
    return 308 /pastepage/;
}
```

An exact match (`=`) for the path without the final slash, redirected with a 308 to the path with it. nginx supports 308 as a redirect code since version 1.13.0 ([return](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#return)).

```nginx
location /pastepage/ {
    proxy_pass http://127.0.0.1:3000/;
```

Everything under `/pastepage/` goes to PastePage. Because `proxy_pass` ends in `/`, nginx replaces `/pastepage/` with `/`, so PastePage sees `/ws`, `/api/add` and so on ([proxy_pass](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)).

```nginx
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
```

What WebSockets need. nginx doesn't pass the `Upgrade` and `Connection` headers on by itself, so these lines do. A WebSocket also needs HTTP/1.1 between nginx and PastePage; nginx only uses 1.1 by default since version 1.29.7 ([proxy_http_version](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_http_version)). Ubuntu 24.04 ships nginx 1.24, so keep the line.

```nginx
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
```

`$proxy_add_x_forwarded_for` is whatever `X-Forwarded-For` the browser sent, with the visitor's real address added at the end ([embedded variables](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#var_proxy_add_x_forwarded_for)). PastePage reads that list from the end, so a fake address a visitor puts in front is ignored. `X-Forwarded-Proto` tells the app whether the visitor used `https`. PastePage doesn't read it at the moment; it is part of the usual set of proxy headers and does no harm.

Note that `proxy_set_header` lines in a `location` replace any `proxy_set_header` lines from the `server` level; nginx doesn't combine them ([proxy_set_header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)).

```nginx
    proxy_read_timeout 1h;
```

nginx closes a proxied connection when PastePage sends nothing for 60 seconds, the default ([proxy_read_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)). PastePage's ping every 20 seconds already counts as sending something, which nginx's WebSocket guide mentions as the alternative; the longer timeout is a safety margin.

```nginx
    client_max_body_size 2m;
}
```

nginx refuses request bodies over 1 MB by default ([client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)). PastePage accepts notes up to about 1.5 MB once encrypted, so without this line notes of more than roughly 780 KB of text fail. If you raise `MAX_NOTE_BYTES`, raise `client_max_body_size` as well.

**On its own subdomain** instead, use a `server { }` block for `paste.example.com` with your usual `listen` and certificate lines, the same `map`, and one location:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    # the same proxy_http_version, proxy_set_header, proxy_read_timeout
    # and client_max_body_size lines as above
}
```

Here `proxy_pass` has no path, so nginx passes the address on unchanged. The redirect block isn't needed.

Check and apply: `sudo nginx -t`, then `sudo systemctl reload nginx`.

### Apache

Example file: [`deploy/apache.conf`](../deploy/apache.conf), for a path of an existing HTTPS site. Put the lines inside the `<VirtualHost *:443>` block of that site.

You need Apache 2.4.47 or newer (Ubuntu 24.04 ships 2.4.58; check with `apachectl -v`) and four modules. On Debian and Ubuntu:

```sh
sudo a2enmod proxy proxy_http headers alias
sudo systemctl restart apache2
```

`a2enmod` doesn't mind if a module is already enabled.

```apache
RedirectMatch 308 ^/pastepage$ /pastepage/
```

Redirects the path without the final slash to the path with it ([RedirectMatch](https://httpd.apache.org/docs/2.4/mod/mod_alias.html#redirectmatch), from `mod_alias`).

```apache
ProxyPass        /pastepage/ http://127.0.0.1:3000/ upgrade=websocket
ProxyPassReverse /pastepage/ http://127.0.0.1:3000/
```

`ProxyPass` sends everything under `/pastepage/` to PastePage, with `/pastepage/` replaced by `/`. Both addresses end in `/`, as the [ProxyPass documentation](https://httpd.apache.org/docs/2.4/mod/mod_proxy.html#proxypass) asks. `upgrade=websocket` lets `mod_proxy_http` pass the WebSocket through; that option exists since Apache 2.4.47 ([Protocol Upgrade](https://httpd.apache.org/docs/2.4/mod/mod_proxy.html#protoupgrade)). `ProxyPassReverse` fixes up the address in redirect headers coming back from the app. PastePage doesn't send redirects today; the line is the usual companion of `ProxyPass`.

Apache adds `X-Forwarded-For` with the visitor's address by itself (`ProxyAddHeaders` is on by default, see [Reverse Proxy Request Headers](https://httpd.apache.org/docs/2.4/mod/mod_proxy.html#x-headers)), appended after any value the visitor sent.

```apache
RequestHeader set X-Forwarded-Proto "https"
```

Tells the app the visitor used `https` (from `mod_headers`). PastePage doesn't read it at the moment; it does no harm.

Apache's default request body limit is 1 GiB (unlimited before 2.4.54), so large notes need no extra line ([LimitRequestBody](https://httpd.apache.org/docs/2.4/mod/core.html#limitrequestbody)).

**On its own subdomain** instead, use a `<VirtualHost *:443>` for `paste.example.com` with your usual certificate lines and:

```apache
ProxyPass        / http://127.0.0.1:3000/ upgrade=websocket
ProxyPassReverse / http://127.0.0.1:3000/
RequestHeader set X-Forwarded-Proto "https"
```

**Apache older than 2.4.47** has no `upgrade=websocket`; there the separate module [`mod_proxy_wstunnel`](https://httpd.apache.org/docs/2.4/mod/mod_proxy_wstunnel.html) handles WebSockets. The commented lines at the end of `deploy/apache.conf` show that variant. It is untested, and Apache's documentation says `ProxyAddHeaders` only applies to `mod_proxy_http`, so the live connection may reach PastePage without the visitor's address. Then every visitor's live connection would seem to come from the web server, and the per-address limits on live connections would apply to all visitors together (see [security](security.md#limits-and-the-lockout)). Upgrading Apache is the better fix.

Check and apply: `sudo apachectl configtest`, then `sudo systemctl reload apache2`.

## 5. HTTPS and Let's Encrypt

The encryption in PastePage runs in the browser, and browsers only allow it on HTTPS pages and on the local machine (`localhost` and `127.0.0.1`) ([secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)). So everyone else must reach PastePage over HTTPS.

PastePage never handles certificates. The web server does:

- **Caddy** gets and renews certificates by itself, from Let's Encrypt or ZeroSSL. It needs the domain's DNS record (A and/or AAAA) to point at the server and ports 80 and 443 to be reachable from the internet ([automatic HTTPS](https://caddyserver.com/docs/automatic-https)).
- **nginx and Apache:** Let's Encrypt recommends the [Certbot](https://certbot.eff.org) client for most people ([Getting Started](https://letsencrypt.org/getting-started/)). Certbot's site gives instructions for your web server and operating system. If your site already has HTTPS, add PastePage to that site or set up the subdomain the same way.

The connection between the web server and PastePage is plain HTTP to `127.0.0.1`, which never leaves the machine.

## 6. Hosting under a path

PastePage works at `https://example.com/pastepage/` as well as on its own subdomain. The page uses relative addresses (`api/add`, `ws`, `style.css`), and the web server removes the `/pastepage` prefix, so PastePage itself always sees `/`. Invite links are built from the page's own address, so they include the path.

**The final slash matters.** At `/pastepage` (no slash) the browser would resolve `api/add` to `/api/add` instead of `/pastepage/api/add`. That's why every example redirects `/pastepage` to `/pastepage/`.

You can use any path; replace `pastepage` everywhere in the example.

## 7. Web server on another machine

By default PastePage listens only on `127.0.0.1`, so only programs on the same machine can reach it, and it trusts `X-Forwarded-For` only from that same machine (`TRUST_PROXY=loopback`).

If your web server runs on a different machine, **change both**:

- `HOST`: an address of the PastePage machine that the web server can reach, such as its private network address. (`0.0.0.0` listens on all of the machine's IPv4 addresses.)
- `TRUST_PROXY`: the web server's IP address, exactly as PastePage sees it. For several, separate them with commas: `TRUST_PROXY=10.0.0.5,10.0.0.6`.

For example, PastePage on `10.0.0.10` behind a web server on `10.0.0.5`:

```ini
Environment=HOST=10.0.0.10
Environment=TRUST_PROXY=10.0.0.5
```

And in the web server's configuration, use `10.0.0.10:3000` instead of `127.0.0.1:3000`.

If you change only `HOST`, PastePage sees every visitor as the web server's address. They then share one wrong-password lockout, one limit on new sessions and one share of live connections: 30 new sessions an hour and 20 open pages at once, for everyone together.

Things to know:

- Write each address in its standard short form, the way Node.js reports it: `::1`, not `0:0:0:0:0:0:0:1`. IPv4 addresses written as `::ffff:10.0.0.5` count as `10.0.0.5`.
- Ranges such as `10.0.0.0/8` are not supported. PastePage refuses to start with them.
- Don't use `TRUST_PROXY=true`. It trusts everyone, so any visitor can claim any address. See [docs/security.md](security.md#trust_proxy).
- Between the machines the traffic is plain HTTP. Use a firewall so that only the web server can reach PastePage's port.

## 8. Updating

**npm route:**

```sh
sudo npm install -g pastepage@latest
sudo systemctl restart pastepage
```

**git route:**

```sh
cd /opt/pastepage
sudo git pull
sudo npm install
sudo systemctl restart pastepage
```

Restarting, and so updating, ends all open sessions, because they only exist in memory. Pages that are still open reconnect and show "This session has ended." Restart when nobody is using it.

Check `pastepage --version` (or `git log -1`) and [CHANGELOG.md](../CHANGELOG.md) to see what changed.

## 9. Troubleshooting

Start with the log: `sudo journalctl -u pastepage -e`.

**The page says it "must be opened over HTTPS (or on localhost)".** You opened it at a plain `http://` address. The browser then doesn't allow the encryption, so PastePage can't start or join sessions. Open it through your web server at its `https://` address. On the server itself, `http://127.0.0.1:3000/` also works.

**The web server shows "502 Bad Gateway".** It couldn't get an answer from PastePage. Check:

- Is PastePage running? `systemctl status pastepage`. If it keeps restarting, the log says why.
- `status=203/EXEC` in the status output means systemd couldn't run the `ExecStart` program: the path is wrong, or `node` isn't in `/usr/local/bin` or `/usr/bin` (see [Install Node.js](#1-install-nodejs)).
- `Cannot listen on 127.0.0.1:3000: listen EADDRINUSE` means another program already uses port 3000. Set `PORT` to a free port, and use the same port in the web server's configuration.
- Do the address and port in the web server's configuration match `HOST` and `PORT`?

**The page loads, but the header keeps saying "Connecting…" or "Reconnecting…", and joining says "No connection to the server".** Normal requests work but the live connection (the WebSocket at `ws`) doesn't get through. Check:

- nginx: the `map` block and the `proxy_http_version`, `Upgrade` and `Connection` lines.
- Apache: `upgrade=websocket` on the `ProxyPass` line and Apache 2.4.47 or newer.
- Under a path: the address ends in `/pastepage/`, with the final slash.
- Another proxy or CDN in front of your web server must also pass WebSockets.

In the browser's developer tools (Network tab), the request to `ws` should have status `101`.

**Sending a large note fails with "Something went wrong on the server".** With nginx, add `client_max_body_size 2m;` (see [nginx](#nginx)). The default 1 MB limit rejects notes over roughly 780 KB.

**Everyone gets "Too many wrong attempts from your network".** PastePage probably sees all visitors as one address. Check `HOST` and `TRUST_PROXY` (see [Web server on another machine](#7-web-server-on-another-machine)), and that your web server sends `X-Forwarded-For`. The lockout ends by itself after 15 minutes (`LOCK_SECONDS`), or when PastePage restarts.

**Pages say the session or server is busy, or keep saying "Reconnecting…".** Many people behind one office network, or a wrong `TRUST_PROXY` that makes every visitor look like one address, can reach the per-address limits on live connections (20 open pages at once). If `TRUST_PROXY` is the cause, set it correctly so that each visitor is seen separately (see [Web server on another machine](#7-web-server-on-another-machine)). The limits are described in [docs/security.md](security.md#limits-and-the-lockout).

**A session vanished while everyone's laptop was asleep.** That is by design: a session is deleted roughly 2-3 minutes after the last open page disconnects, and a sleeping device stops counting as connected. Use a fresh session.

## 10. What was tested

This section says exactly what has been checked so far, and will be updated as more is tested.

- **Test suite:** `npm test` passes on Node.js 22 (v22.17.0), 24 (v24.22.1) and 25.9.0, all on macOS. Node 25 itself reached its end of life on 1 June 2026. CI (`.github/workflows/test.yml`) is set up to run the suite on 22 and 24, and will do so once the repository is on GitHub.
- **npm package:** `npm pack` produced the package, which was installed globally into a temporary folder on macOS. The installed `pastepage` command started and printed its address. The package is not yet published on npm, so `npx pastepage` and `npm install -g pastepage` from the npm registry have not been tried.
- **In the browser:** sessions with two tabs, on the same machine, at `http://127.0.0.1` without a web server in front and (for the Caddy check) at `http://localhost:8080/pastepage/` behind Caddy, in a Chromium-based browser driven by Playwright. The app itself has so far been tried in Chromium only; Firefox and Safari have not been tested yet. (Firefox 156 and WebKit were used only to check which request headers they send, and Firefox 156 also what it keeps in its history; see [docs/security.md](security.md).) Line-ending preservation was tested in Chromium on macOS; not yet on Windows.
- **Caddy:** the sub-path setup (`redir` plus `handle_path` with `reverse_proxy`, as in `deploy/Caddyfile`) was verified live with Caddy 2.11.7 on macOS, on plain http at `:8080` in front of PastePage. `/pastepage` redirected with 308 to `/pastepage/`; two browser tabs created, joined, and sent and received notes live through the proxy; a tab left idle for 70 seconds still received a new note, so the WebSocket stays alive through Caddy; and the wrong-password lockout was keyed on the forwarded client address (the 11th bad request through `localhost` got 429 `LOCKED`, while the same request through the Mac's LAN address got 404). `deploy/Caddyfile` itself passes `caddy validate`. The subdomain option and automatic HTTPS were not run.
- **nginx:** the nginx example has not yet been verified against a running nginx. It was only checked against the documentation.
- **Apache:** the Apache example has not yet been verified against a running Apache.
- **systemd:** the service file has not yet been run on a Linux server.

All examples were checked line by line against the official documentation linked above. If you run PastePage behind one of these web servers, please let us know how it went.
