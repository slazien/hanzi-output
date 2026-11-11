# Juzi 句子

Chinese sentence practice: read an English sentence, write it in simplified Chinese, and get it graded and explained by Claude. Sentences are built from the characters you already know, taken from a Hanly progress export.

It is a static web app with no server. It can be installed on an iPad from Safari (Share → Add to Home Screen) or used in any desktop browser.

## How it works

- **First-run setup** – on first open, import the Hanly file, add the API key, pick the HSK level you are studying and set the new-character limit. It can be run again from Settings.
- **Practice** – choose the number of sentences, the largest share of new characters allowed per sentence (0–100%), an HSK cap for new characters and grammar, and optionally a grammar pattern. Claude writes the sentences; the app checks each one against your known characters and asks for replacements when a sentence breaks the limit.
- **Feedback** – a score out of 100, your answer corrected, a reference answer (tap a word for pinyin and meaning), what to fix, and a follow-up question box.
- **Review** – sentences scored below 80 come back after 1, 3, 7 and 14 days, mixed into later sessions.
- **History** – every attempt with its feedback.
- **Settings** – Anthropic API key, model, Hanly import, which Hanly score counts as "known" and its cut-off, HSK version, backup and restore.

## Data and privacy

- Everything is stored in the browser's local storage on the device. There are no accounts and no sync; use *Download backup* / *Restore* to move data between devices.
- The Anthropic API key is stored on the device, is sent only to `api.anthropic.com`, and is left out of backups.
- The Hanly file is read on the device. The list of known characters and words is sent to Anthropic as part of the sentence request.

## Running it

No build step. Serve the folder over HTTP:

```
npm run serve   # http://localhost:8080
```

To publish, enable GitHub Pages for the repository (deploy from a branch, root folder).

`vendor/anthropic-sdk.js` is the official `@anthropic-ai/sdk` bundled for the browser; rebuild it with `npm install && npm run vendor`.

## Credits

HSK character levels in `data/hsk.js` are derived from the word lists in [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) by Yanis Zafirópulos (MIT licence).
