# Juzi 句子

Chinese sentence practice: read an English sentence, write it in simplified Chinese, and get it graded and explained by an AI model (Claude or OpenAI's GPT models, using your own API key). Sentences are built from the characters you already know, taken from a Hanly progress export.

It is a static web app with no server. It can be installed on an iPad from Safari (Share → Add to Home Screen) or used in any desktop browser.

## How it works

- **First-run setup** – on first open, import the Hanly file, add the API key, pick the HSK level you are studying and set the new-character limit. It can be run again from Settings.
- **Practice** – choose a theme (shopping, eating out, travel and about 35 others) or a random mix, the number of sentences, the largest share of new characters and of new words allowed per sentence (0–100% each), an HSK cap for new characters and grammar, and optionally a grammar pattern. Claude writes the sentences; the app checks each one against your known characters and words and asks for replacements when a sentence breaks a limit.
- **Feedback** – a score out of 100, your answer corrected, and a reference answer shown with pinyin above each word (can be hidden), the words you know underlined, an HSK tag and a short grammar note. Tap a word for its meaning or to mark it as known. Then what to fix, and a follow-up question box.
- **Review** – sentences scored below 80 come back after 1, 3, 7 and 14 days, mixed into later sessions.
- **History** – every attempt with its feedback.
- **Settings** – model (Anthropic or OpenAI), API key, Hanly import, which Hanly score counts as "known" and its cut-off, HSK version, backup and restore.

## Data and privacy

- Everything is stored in the browser's local storage on the device. There are no accounts and no sync; use *Download backup* / *Restore* to move data between devices.
- API keys are stored on the device, are sent only to their own provider (`api.anthropic.com` or `api.openai.com`), and are left out of backups.
- The Hanly file is read on the device. The list of known characters and words is sent to the selected provider as part of the sentence request.

## Running it

No build step. Serve the folder over HTTP:

```
npm run serve   # http://localhost:8080
```

To publish, enable GitHub Pages for the repository (deploy from a branch, root folder).

`vendor/anthropic-sdk.js` is the official `@anthropic-ai/sdk` bundled for the browser; rebuild it with `npm install && npm run vendor`.

## Credits

HSK character levels in `data/hsk.js` are derived from the word lists in [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) by Yanis Zafirópulos (MIT licence).
