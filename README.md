# Juzi 句子

Chinese sentence practice: read an English sentence, write it in simplified Chinese, and get it graded and explained by an AI model (OpenAI's GPT models or Claude, using your own API key). Sentences come from a stored bank of about 18,000 and are chosen to fit the characters and words you already know, taken from a Hanly progress export.

It is a static web app with no server. It can be installed on an iPad from Safari (Share → Add to Home Screen) or used in any desktop browser.

## How it works

- **First-run setup** – on first open, say which HSK level you already know and/or import a Hanly file, add the API key, pick the HSK level you are studying and set the new-character limit. It can be run again from Settings.
- **Practice** – choose a theme (shopping, eating out, travel and about 35 others) or a random mix, the number of sentences, the largest share of new characters and of new words allowed per sentence (0–100% each), an HSK cap for new characters and grammar, and optionally a grammar pattern. The app picks sentences from the bank that fit, and shows how many do. No AI is used to get sentences.
- **While answering** – new words in a sentence can be shown under the prompt, and a Hint button gives help in steps: the number of words and the grammar pattern, one key word, the first word, then the pinyin. Using a hint lowers the suggested rating. Return checks the answer.
- **Grading** – the model makes three separate judgements: whether the meaning came across, whether the Chinese is correct, and, for answers with no mistakes, whether it is how a native speaker would say it. A naturalness point is raised only when a named convention applies (for example 的 with family members: 我妈妈, not 我的妈妈) and is shown apart from mistakes, with the more natural wording. The score is worked out in code from those ratings (`js/grading.js`). "I disagree with this grade" grades the answer once more and keeps both verdicts. `tools/grader-eval/` holds a test set for the grader.
- **Feedback** – when your answer needed a correction you first tap what changed (can be turned off), then see a score out of 100, what to fix first, your answer with the changed characters marked against the correction, and a large reference answer with pinyin above each word (can be hidden), known words underlined and new words dotted, an HSK tag and Listen and Slower buttons. Tap a word for its meaning or to mark it as known. "Try again from memory" hides the answers so you can write the sentence once more; it is compared on the device. There is also a follow-up question box.
- **Self-rating and review** – after each sentence you rate it Forgot, Hard, Recalled or Easy (the AI's score suggests one; Return accepts it). Scheduling uses FSRS-6 with its default parameters and a 90% recall target (`js/fsrs.js`): each sentence has a memory stability and difficulty, and comes back when recall is expected to fall to the target. Forgot brings a sentence back in the same session. At most 40 reviews are given per day, most-at-risk first. A sentence whose gap has passed three weeks is sometimes reviewed through a different bank sentence that reuses its words.
- **Weak areas** – every mistake is labelled with a type by the grader. From a time-decayed log of attempts the app lists themes, grammar patterns, mistake types and words where you miss clearly more than usual, each with a "Practise this" button for a focused session (about 60% on the area, the rest ordinary sentences and due reviews). Missed words are also preferred in ordinary sessions until you recall them.
- **Progress** – recall rate on reviews over 30 days, average score by week, results by HSK level, theme, grammar pattern and mistake type, reviews due over the next seven days, a calendar of days practised, and known characters and words with how much of the bank is within reach.
- **Mixed patterns** – each sentence is tagged with the grammar patterns it uses. A session orders sentences so neighbours practise different patterns, and a pattern that has been going badly comes back in a few different sentences.
- **Summary** – the session's average (leaving out sentences where you chose Show answer), what the session showed against the last month (only when there is something true to say), sentences that were missed last time and recalled now, and a button to retry the missed sentences.
- **Weekly goal** – optionally, a number of practice days per week. The Practice screen shows the week so far; nothing is lost when a week falls short.
- **History** – every attempt with its feedback.
- **Settings** – model (Anthropic or OpenAI), API key, Hanly import, which Hanly score counts as "known" and its cut-off, HSK version, backup and restore.

## Accounts and sync (optional)

With a Supabase project connected (see [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md)), people can sign in with Google or a link sent by email, and their progress syncs across devices. Without it, or without signing in, everything stays on the device.

## Data and privacy

- Everything is stored in the browser's local storage on the device. Unless accounts are set up and you sign in, nothing is synced; use *Download backup* / *Restore* to move data between devices.
- API keys are stored on the device, are sent only to their own provider (`api.anthropic.com` or `api.openai.com`), and are left out of backups.
- The Hanly file is read on the device. Only the sentence being graded, your answer and your follow-up questions are sent to the selected provider.

## Running it

No build step. Serve the folder over HTTP:

```
npm run serve   # http://localhost:8080
```

To publish, enable GitHub Pages for the repository (deploy from a branch, root folder).

`vendor/anthropic-sdk.js` is the official `@anthropic-ai/sdk` bundled for the browser; rebuild it with `npm install && npm run vendor`.

## Sentence bank

`data/bank.json` holds the sentences, built by `tools/build_bank.py` (see `tools/README.md`) from HSK Sentences Audio, the Chinese Grammar Wiki, Tatoeba and sentences written for this app. Licences are listed in `data/BANK-LICENCES.md`; because Chinese Grammar Wiki content is included, the bank is for non-commercial use only.

Writing sentences with AI is switched off (`AI_SENTENCES` in `js/session.js`); the code is kept so it can be turned back on.

## Credits

HSK character levels in `data/hsk.js` are derived from the word lists in [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) by Yanis Zafirópulos (MIT licence).
