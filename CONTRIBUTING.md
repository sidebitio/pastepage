# Contributing to PastePage

Thanks for helping! Bug reports, fixes and translations are all welcome. For anything bigger, please open an issue first so we can agree on the approach before you put in the work.

Security problems: please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Running it

You need Node.js 22 or newer.

```sh
git clone https://github.com/sidebitio/pastepage.git
cd pastepage
npm install
npm start      # PastePage running at http://127.0.0.1:3000/
npm test       # runs every test with node --test
```

Open the printed address in two browser windows to try a session. There is no build step: edit a file, then reload the page (or restart `npm start` for server changes).

## Code style

- **Plain modern JavaScript, ES modules, no build step.** The browser loads the files in `public/` as they are, and the server runs `src/` directly.
- **Minimal dependencies.** The only runtime dependency is [`ws`](https://github.com/websockets/ws), and there are no dev dependencies. Tests use Node's built-in `node:test` and `node:assert/strict`. Each dependency is code every user has to trust, so a new one needs a very good reason.
- **Nothing from other sites.** The page must not load scripts, styles, fonts or anything else from third parties, and must not use inline scripts (the Content Security Policy forbids them).
- **Never change pasted text**, and never log or store content, names, tokens or session names.
- Each file starts with a short comment saying what it's for. Exported functions get a brief JSDoc comment.
- Tests go in `test/` (server) and `test/client/` (the browser modules that run in Node). Add or update tests with every change, and run `npm test` before you open a pull request.
- Any test data uses the names "Ada" and "Linus".

## Translations

The interface texts live in `public/i18n/`, one JSON file per language: `en.json` (English, the reference), `nl.json`, `de.json`, `fr.json`, `es.json` and `ja.json`. Everything except English was drafted without a native speaker, so corrections are very welcome. Japanese most of all.

**To fix a translation,** edit the file and run `npm test`. The locale tests check that every language file:

- has exactly the same keys as `en.json`;
- keeps the same `{placeholders}` as English, such as `{name}` or `{count}`;
- has valid plural forms for that language (`one` and `other` in most languages, only `other` in Japanese);
- has no empty texts;
- doesn't contain the product name (it is inserted through the `{app}` placeholder).

**To add a language:**

1. Copy `public/i18n/en.json` to `public/i18n/<code>.json`, using a two-letter language code such as `pt` or `it`, and translate the texts. Leave the keys and `{placeholders}` as they are.
2. Add the code to `LOCALES` in `public/js/i18n.js`.
3. Add the language's own name to `LANGUAGE_NAMES` in `public/js/menus.js`, for example `pt: 'Português'`.
4. Run `npm test`, then check the page in your language.

The page picks a language from the browser's settings by the first part of the language code (`pt-BR` becomes `pt`), so use the plain two-letter code.

## Pull requests

- Keep each pull request to one topic. It is squash-merged into `main` as a single commit, so a short, clear title helps; that title becomes the commit message.
- Describe what changed and how you tested it.
- Add a line to the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md) for anything users will notice.

## License

PastePage is source-available under the MIT license with the Commons Clause (see [LICENSE](LICENSE)). By contributing, you agree that your contribution is released under the same license.
