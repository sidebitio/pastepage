# PastePage security

This page explains how PastePage protects what you paste, what the server can and cannot see, and where the limits are. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

In short: notes are encrypted in the browser with a key that only the people in the session have. The server holds encrypted data in memory and forgets it when the session ends. You still have to trust whoever runs the server, because that server delivers the page's code.

## How the encryption works

**Session name and password.** Starting a session gives you a random session name, like `12-dancing-apes`, and a random 14-character password from a 31-character alphabet without look-alike characters (no `i`, `l`, `o`, `0` or `1`). That is about 69 bits of randomness. Both are made in your browser with its cryptographic random number generator.

**Key derivation.** Your browser feeds the password through PBKDF2 with SHA-256 and 600,000 iterations, salted with `pastepage/v1:` followed by the session name, to get 512 bits. The 600,000 iterations match the [OWASP recommendation](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) for PBKDF2-HMAC-SHA256. The 512 bits are split in two:

- the **first 256 bits** are the AES-GCM-256 encryption key, which never leaves the browser;
- the **second 256 bits** are the **access token**, which the browser sends (as 64 hex characters) to prove it knows the password.

The server stores only the SHA-256 hash of the access token, and compares hashes in constant time.

**Encryption.** Every note, reply, reaction, pin and "read" notice is encrypted separately with AES-GCM-256 and a fresh random 12-byte IV. The display name you type and the language you chose for highlighting are inside the encrypted part. So is which note a reply, reaction or pin belongs to.

**No secrets in addresses.** The invite link carries the password after the `#`. Browsers never send that part of an address to the server ([MDN](https://developer.mozilla.org/en-US/docs/Learn_web_development/Howto/Web_mechanics/What_is_a_URL)). But opening a link with the password puts that full link, password included, in the browser's history: we saw this in Chrome 155 and Firefox 156. From there it can show up as an address-bar suggestion, and if the browser syncs history, on your other devices too. After joining, PastePage removes the password from the address bar and from the tab's current history entry ([`history.replaceState`](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState)), but it can't remove what the browser has already stored in its history. If that matters, send the link without the password, and the password separately. The access token and the session name travel only inside request bodies and as the first message on the live connection, never in a URL. So web-server access logs show only paths such as `/api/add` and `/ws`, plus visitors' IP addresses.

**In your browser.** So that a page reload doesn't ask for the password again, the tab keeps the derived key material and the password in its `sessionStorage`, which the browser clears when the tab is closed ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)). Your display name, theme, language and highlighting choice are kept in `localStorage`. Anyone with access to that browser tab can read the session.

**Browser requirements.** The browser's encryption functions (Web Crypto) are only available on HTTPS pages and on the local machine ([secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)). Over plain `http://`, PastePage shows an error instead of starting.

## What the server can and cannot see

The server **never** sees:

- the text of notes, replies or burn-after-reading notes;
- the pictures themselves, their captions, file types or pixel sizes;
- the names people type;
- the password, or the encryption key.

The server **does** see:

- **session names**, because they identify sessions;
- **sizes**: the length of each encrypted event. Encryption does not hide length, and small events are not padded. The server can't read a reaction, pin or read notice, but from its size it can often tell which of the three it is, whether it was switched on or off, and sometimes which emoji was used. The size also gives hints about which note a reply, reaction or pin refers to, because the note's number is inside and longer numbers take more space. A read notice also follows the server-visible "burn note opened" action from the same client id;
- **timing**: when each event arrives (events carry a server timestamp), when pages connect and disconnect, and how many are connected;
- **event kinds**: a note, an image note, a burn-after-reading note, or a small event (a reaction, pin or "read" notice; by kind alone it can't tell them apart, but their sizes often differ, see above); and the actions that make it delete data: delete a note, clear all, open a burn note, change the expiry, end the session;
- **client ids**: a random id per browser tab, attached to each event, so the page can show who sent what;
- **which notes are images, and which tab saved which image**: see [Images](#images) below;
- **IP addresses** of visitors. They are used for the wrong-password lockout and the limit on new sessions, and kept in memory for the length of the limit window and cleaned up afterwards (entries are removed when later requests come in, not on a timer). They are also used to count each address's open live connections, for as long as those are open.

The same applies to anyone who can read the server's memory while a session is open.

PastePage doesn't write sessions to disk and doesn't log request bodies, tokens, session names or content. It logs only when it starts and stops, and the stack trace of unexpected errors. Your web server's own access log is separate and is yours to configure.

## Images

An image is encrypted in the sender's browser, together with its type, the picture's size and the caption, so the server never sees the picture. Unlike text, though, an image is not an ordinary note to the server: it is stored as a separate kind, with a small preview next to the full image, and it is handled differently. When a large image is made smaller first, that happens in the sender's browser too.

- **Only four formats.** A note can carry a PNG, JPEG, WebP or GIF image. The sending browser checks the file's first bytes rather than its name or claimed type, so an SVG (which can contain scripts) or any other file is refused, even if it is named `.png`.
- **Checked on arrival.** A received image is shown only if its type is one of those four, its data is valid base64 and starts with that format's own signature, and its width and height are positive whole numbers. Otherwise the note is shown as unreadable.
- **Shown only as a picture.** A received image reaches the page only as the source of an `<img>` element, as a `data:` URL put together from the checked type and data. The Content Security Policy allows images from the page itself and `data:` URLs only (`img-src 'self' data:`). Download hands the browser a temporary `blob:` link to save the file; that link is never loaded into the page, so the policy needs no `blob:`.
- **No hidden data.** Before anything is encrypted, the sending browser removes what a picture file carries besides the picture: GPS location, camera and lens details, dates, names, comments, XMP and IPTC, and any extra pictures stored behind the main one. The picture itself is not touched, and the colour profile stays. A rotated photo keeps only its rotation, so it still shows upright. A file that can't be read this way is redrawn instead (as is every converted image), which keeps none of it. GIFs lose their comments and XMP but keep their loop setting.

**What the server learns because of this.** It sees which notes are images (the event kind is `image`) and how large each preview is. It also sees which tab saved which image: a browser that has stored an image sends a receipt (a `got` message) over the live connection, and one that can't store images, such as a private window, sends none. The server still sees no image, caption, name or key.

- **The full image waits on the server only until it is delivered.** When an image is sent, the server keeps the encrypted full image and its encrypted preview, and passes both on to every open page. It remembers which tabs are in the session at that moment, apart from the sender. A tab that closes its connection on purpose (close code 1000, 1001 or 1005: the tab was closed or navigated away) is gone. A tab whose connection simply dropped (any other code: a network failure, a sleeping laptop, a phone app in the background) still counts as in the session, because it may come back, and gets the full image when it does. When every one of those tabs has sent its receipt, or has left on purpose, the server deletes the full image from memory and keeps only the preview. A page sends its receipts again each time it reconnects, in case one was lost with a dying connection. The server remembers at most 50 dropped tabs per session (as many as a session can have live connections); when one more drops, the one that dropped longest ago counts as gone. There is no timer: if a tab never comes back, the full image stays in memory until it rolls off, the session ends, or 50 other tabs have dropped after it.
- **Previews.** The sender's browser makes a preview of at most 480 pixels on the long side (WebP at quality 0.7, JPEG where the browser can't write WebP; for a GIF, its first frame). If that is larger than 50 KB, it tries 360 and then 240 pixels. People who join later see the preview, marked as a low-resolution preview. If the encrypted preview would still be over `MAX_PREVIEW_BYTES` (96,000 characters by default; the page learns the server's value when it connects), the image is sent as an ordinary note and kept in full on the server, as before. The caption travels in both the full image and the preview, so a very long caption can push an image onto this path too. A burn-after-reading image has no preview.
- **Local copies.** A browser that receives a full image saves it on its own disk, in IndexedDB (database `pastepage`, store `images`), so the image is still there after a reload. The copy is encrypted with a key derived (HKDF-SHA-256) from the session's encryption key and a random value, `share`, that the server creates with the session, hands to everyone who joins, and holds only in memory. When the session ends, `share` is gone, and so the copies can no longer be decrypted, even by someone who has the invite link and the computer. The server never has the session key, so `share` alone decrypts nothing. Anyone who has the password while the session is running can still derive the key.
- **What stays on disk.** Copies that have become unreadable are not necessarily deleted at once. A browser removes them when it sees the session end, when the note is deleted, on "Clear all", when the note rolls off the session (a reload couldn't show it again), when their session's expiry has passed the next time PastePage is opened, and, oldest first, when all copies together go over 500 MB per browser. The note itself (image, caption, name) is encrypted, but until a copy is removed, its record also keeps the session name, the note's number, its size, and when it was saved and when the session expires, in plain form. A browser that is never opened on PastePage again, or whose page never learns that the session ended, keeps unreadable leftovers until you open PastePage in it again or clear its site data. Text notes are not stored locally at all.
- **Without storage,** the image is shown while the page is open, and the server keeps the full image for that browser until that tab is reloaded or closed, which counts as leaving on purpose. After a reload, that tab may get only the preview.

The server also sends strict security headers with every response: a Content Security Policy that allows only PastePage's own scripts, styles and connections (`'self'`) and forbids framing, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. The page loads nothing from other sites.

## Limits and the lockout

**Wrong-password lockout per IP address.** Each request to PastePage's API with a wrong session name or password counts against the visitor's IP address. After 10 such failures within 15 minutes, that address is locked out for 15 minutes (`MAX_FAILS`, `LOCK_SECONDS`): its requests and its live connections are refused. IPv6 addresses are counted by their /64 network, because a home or office gets at least a whole /64 ([RFC 6177](https://www.rfc-editor.org/rfc/rfc6177.html)) and can use any address in it. The lockout is per address, not per session, so someone guessing can't lock everyone else out of a session. People behind one office network share an address, and so share the lockout.

**Joining doesn't count toward the lockout.** A page joins a session over the live connection. A wrong name or password there gets the same answer as on the API, but it isn't counted. Counting it did more harm than good: a page on another website could use it to lock out its visitors' networks (see below), and after a restart every open page fails at once. It also adds little protection. PastePage makes the password in your browser: 14 random characters from a 31-character alphabet, about 69 bits. To try a password, a guesser first has to turn it into an access token with 600,000 iterations of PBKDF2. That long random password is the real protection; the lockout is only a second layer. If you write your own client and let it use short passwords, keep in mind that guesses over the live connection are not limited.

**Other websites.** A page on another website can make your browser send requests to PastePage, but it can't use them to lock out your network. The API refuses them before they count. It accepts only JSON (`Content-Type: application/json`), and a browser asks for permission before sending JSON to another site (a [CORS preflight](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)), which PastePage never gives. Requests that the browser marks as coming from another site (the `Sec-Fetch-Site` header) are refused too, and so are live connections marked that way. Not every browser marks live connections, though. In our tests, Chrome 155 sent no `Sec-Fetch-Site` header when opening one, while Firefox 156 and WebKit, Safari's engine, did (see also [WebKit bug 237550](https://bugs.webkit.org/show_bug.cgi?id=237550)). So in Chrome, and probably in other Chromium-based browsers, a page on another website can still open live connections to PastePage from your browser. Wrong passwords there aren't counted, so this can't lock you out. But while that page is open, its connections can take up your address's share of live connections (see below), so that your own PastePage pages can't connect until it is closed.

**Same answer for "no such session" and "wrong password".** Outsiders can't use joining to find out which session names exist. Starting a session with a name that's already in use does say "taken". That reveals that the name exists, so it counts as a failed attempt, and it is limited too.

**New sessions per IP address.** At most 30 per hour by default (`CREATE_PER_HOUR`).

**Size limits.** The encrypted data the server stores is limited per note (`MAX_NOTE_BYTES`), per image preview (`MAX_PREVIEW_BYTES`), per session (`MAX_SESSION_BYTES`, `MAX_EVENTS`) and for the whole server (`MAX_TOTAL_BYTES`, `MAX_SESSIONS`); see the configuration table in the [README](../README.md#configuration). When the server as a whole is full, new notes or sessions are refused, and so is a note that is too large. A session that reaches its own limit does not refuse a note for that reason: it rolls over (see below). A single note larger than the whole session limit is still refused as too large, and a note can still be refused because the server as a whole is full.

**Rolling over.** When a new event would take a session over `MAX_SESSION_BYTES` or `MAX_EVENTS`, the server deletes the oldest events of that session, whatever their kind, until the new one fits. This also deletes burn-after-reading notes nobody has opened yet. The server tells the pages that older events are gone. A page that is already open keeps showing the notes it has, on a slightly different background, until it is reloaded; a page that joins or reloads afterwards doesn't get them. The server also sends how full the session is (a number from 0 to 1000) with every event, which the page shows as a thin line under the header.

**Live connections.** Sending notes to open pages takes memory too, so the live connections have their own limits. They are built-in defaults, not settings:

- **per IP address** (for IPv6, per /64 network): at most 20 open connections, and at most 10 that haven't sent their session name and password yet;
- **per session:** at most 50 open connections;
- **for the whole server:** at most 1,000 open connections, at most 200 that haven't sent their session name and password yet, and at most 256 MiB of welcomes waiting to be sent. A page that joins gets the whole session in one welcome message, which can be as large as the session itself. Until that message has been passed on to the network, it counts toward the 256 MiB.

The server-wide limits can be filled by just a handful of addresses. That is a deliberate trade-off: during such an attack people see "busy" or "No connection to the server", instead of the server running out of memory.

A page that is turned away by one of these limits keeps trying again: after 1, 2 and 5 seconds, then every 10 seconds. Meanwhile a page that was already connected shows "Reconnecting…", a page that has not yet received its first welcome shows "Connecting…", and a page that is joining says that the session or server is busy. There is one exception. A connection refused before it has sent its session name and password looks to the browser like any failed connection, because browsers don't tell the page why ([WebSockets Standard](https://websockets.spec.whatwg.org/)). A page that is joining then says "No connection to the server" and stops, unless it was already told that the session or server is busy. When more than 16 MiB is already waiting to be sent to a page that has stopped reading, the server disconnects that page instead of queueing more. The server also disconnects pages that stop answering its ping, which it sends every 20 seconds. If you raise `MAX_SESSION_BYTES` or `MAX_EVENTS`, the 16 MiB and the 256 MiB grow where needed, so that they always fit the largest possible welcome: `MAX_SESSION_BYTES`, plus 256 bytes per `MAX_EVENTS`, plus 1 MiB.

**Known limitation:** the notes queued for slow or non-reading pages have no server-wide budget. Each page can have up to the per-page limit waiting (16 MiB at the defaults, more if you raise `MAX_SESSION_BYTES` or `MAX_EVENTS`; raising `MAX_EVENTS` raises that limit) before it is disconnected, and the ping check disconnects a page that stops answering within about 20 to 40 seconds. Many such pages together can therefore use more memory than the 256 MiB for welcomes.

### TRUST_PROXY

Behind a reverse proxy, every request reaches PastePage from the proxy's address. The visitor's real address is in the `X-Forwarded-For` header, which the proxy adds. Anyone can also put a fake `X-Forwarded-For` in their own request, so PastePage only reads it when the request comes directly from a trusted proxy, set by `TRUST_PROXY`:

- `loopback` (the default): trust only proxies on the same machine (addresses `127.x.x.x` and `::1`). Right for the standard setup.
- A comma-separated list of exact IP addresses, for a proxy on another machine, e.g. `TRUST_PROXY=10.0.0.5`. Write each one in its standard form, the way Node.js reports it (`::1`, not `0:0:0:0:0:0:0:1`). Ranges such as `10.0.0.0/8` are not supported; PastePage refuses to start, with a message, if the value is not understood.
- `false`: never read the header.
- `true`: trust every hop. **Not recommended.** Then any visitor can send `X-Forwarded-For` with a made-up address and dodge the lockout and limits, or get someone else locked out.

PastePage reads the `X-Forwarded-For` list from right to left, skipping trusted proxies, and uses the first address that isn't one. nginx (with `$proxy_add_x_forwarded_for`) and Apache add the address they see to the end of the list, so a fake entry from the visitor stays in front and is ignored. Caddy, by default, ignores the visitor's own `X-Forwarded-For` and sends just the address it sees.

**If your web server runs on a different machine,** change both `HOST` and `TRUST_PROXY` (see [deployment](deployment.md#7-web-server-on-another-machine)). If PastePage doesn't trust the proxy, it sees every visitor as the proxy's address: everyone then shares one lockout, one limit on new sessions and one share of live connections. Then 10 failed requests by anyone lock everybody out, and 20 open pages use up the live connections for everyone.

## Session lifetime

Sessions exist only in the server's memory. A session is deleted, with all its notes, when:

- someone in it ends it;
- its expiry passes (1 hour to 7 days, 24 hours by default; anyone in the session can change it);
- **nobody has had it open for roughly 2-3 minutes** (`IDLE_SECONDS` is 120 seconds, checked every 10 seconds, and a dead connection can take up to about 40 seconds to be noticed). This includes everyone's devices going to sleep: the server pings each open page every 20 seconds and drops connections that stop answering;
- the server restarts.

"Delete" on a note and "Clear all" remove the encrypted data from the server's memory right away; only a marker that something was deleted stays.

## Burn after reading

A burn-after-reading note is shown to the others as a covered card. What it guarantees:

- The server never sends its encrypted text over the live connection, which every page in the session receives. Pages get only a placeholder with its size.
- The encrypted text is released by one explicit "open" request. The server hands it over and deletes it in the same step, so two people can never both open it.
- The server refuses the open request from the tab that sent the note.
- After it's opened, everyone sees that it was opened, and normally also the reader's name.

What it doesn't guarantee:

- **The reader can keep it.** They can copy the text, take a screenshot or photograph the screen. Burn after reading only means the server can't hand it out a second time.
- **The first person to open it wins.** Anyone in the session with the password can open it, not necessarily the person you meant.
- **An unopened burn note is deleted with its session.** Until then the server holds it, encrypted, like any other note.

## What the people in a session can do

Everyone in a session has the same key. They can read everything in it, and they are trusted not to misbehave. Some details rely on that:

- **Client ids are self-declared.** The "Read by …" notice and the rule that a burn note can only be opened by someone other than its sender rely on the random per-tab client id that each page reports. Someone who already has the password could deliberately send a different id: for example, open their own burn note from another tab, or make the "Read by" notice name someone else. An outsider without the password can do neither.
- **Names are typed, not verified.** Anyone in the session can type any display name.
- **Anyone in the session can delete notes, clear all, change the expiry or end the session.**

So share the password only with people you'd let read and manage the whole session.

## You trust whoever runs the server

This is true of every web app that encrypts in the browser, not just PastePage: the encryption code is part of the web page, and the server delivers that page each time it's opened. Whoever controls the server, or can change the files it serves, could deliver a modified page that sends your text or password somewhere else. Encryption protects against the server *storing* or *leaking* readable data, not against a server operator who decides to change the code.

Self-hosting means that operator is you. If someone else runs the PastePage you use, you're trusting them.

## Reporting a problem

Please report vulnerabilities privately, as described in [SECURITY.md](../SECURITY.md).
