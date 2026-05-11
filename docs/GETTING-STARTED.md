# Getting started with Lull Mail

After installing Lull Mail (see the [Download section in the README](../README.md#download)),
the setup wizard opens automatically. This guide walks through it
and covers what to expect on the first run.

## 1. OpenAI API key

Lull Mail needs a key for the AI triage engine. Create one at
[platform.openai.com/api-keys](https://platform.openai.com/api-keys).
Expect to pay roughly **$0.15 per 100 emails** analysed with the
default `gpt-4o-mini` model.

The key is stored in your OS keyring, never in plain text. You can
change the model later in *Settings → Intelligence artificielle*
(e.g. switch to `gpt-4o` for finer triage, or disable AI on a
per-mailbox basis).

## 2. Mail accounts

The wizard handles the most common providers with a one-click
*"Create an app password"* shortcut:

| Provider | What you need |
|---|---|
| Gmail / Google Workspace | App password (2-step verification must be enabled) |
| Outlook / Microsoft 365 | App password |
| iCloud | App password |
| Yahoo | App password |
| ProtonMail | A running [Proton Mail Bridge](https://proton.me/mail/bridge). Paste the Bridge-generated password manually. |
| Orange / OVH / Free / any IMAP | Host, port, username, password (no shortcut, fill in manually) |

## 3. (Optional) Push notifications

Lull Mail can fire a push notification when something genuinely urgent
arrives. It uses [ntfy.sh](https://ntfy.sh): free, no account,
anonymous.

1. Pick a topic name only you know (e.g. `lull-mail-<random>`).
2. Install the ntfy app on your phone and subscribe to the topic.
3. Paste the topic into the onboarding wizard.

The default urgency threshold is **importance ≥ 7** on a 1–10 scale.
You can tune it during onboarding or later in the main Settings.

## 4. First sync

By default, Lull Mail fetches the **500 most recent emails** per
mailbox on first sync. After the initial pass, new mail is triaged
in real time as it arrives. Adjust `initial_fetch_count` in the
configuration if you want a deeper history.

The first sync may take a few minutes depending on the size of your
mailboxes and the number of accounts.

---

- **Privacy & data location** → [README → Privacy](../README.md#privacy)
- **Security model** → [`SECURITY-ROADMAP.md`](SECURITY-ROADMAP.md)
- **Build & developer mode** → [`DEVELOPING.md`](DEVELOPING.md)

[← Back to the README](../README.md)
