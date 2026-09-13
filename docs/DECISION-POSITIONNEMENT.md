# Positionnement : client de messagerie ou surface de tri

**Cette question est ouverte et ne produit aucun commit.** Elle a été chiffrée
pendant le lot 4 pour être décidable, pas pour être exécutée. Rien de ce qui a
été livré dans ce lot n'en dépend.

La question : Lull Mail doit-il rester un client capable de composer,
répondre, transférer, étiqueter et classer — ou devenir une surface de tri qui
passe la main à un autre logiciel pour répondre ?

Tout ce qui suit a été lu et compté dans le code, pas estimé, sauf mention
contraire. Les positions intermédiaires sont en section 5, le tableau de
décision en section 7, et ce qui est irréversible en section 6 — c'est la
section à lire en premier, parce que le code se révoque et les données non.

---

All work read at `459c966` on `feat/cleanup-v2`. `git status --short` empty at start and end — no repo file touched. Measurements ran from a scratchpad harness that imports `scripts/ui_test_server.py` and `src.api` without modifying the tree: `C:\Users\Alexis\AppData\Local\Temp\claude\D--Donn-es-Utilisateur-Documents-GitHub-Lull-Mail-dev\7b0511db-f3f8-4a74-8deb-21e0d8908bc3\scratchpad\pos\`.

**[M]** = measured on this machine. **[C]** = counted from the code by brace/range matching, not estimated. **[D]** = derived. **[E]** = my estimate, labelled as such.

**One scoping note up front.** I could not find the September audit's "option A: triage" in the repo. `docs/AUDIT-UX-BOITE-MAIL.md` has 81 findings across 7 lots and never proposes dropping the composer; the only "Option A" in the tree is `docs/DESIGN-NETTOYAGE.md:662`, and it is about deleting the *cleanup rules engine*, not about positioning. So the framing below is built from the code as it stands, not from a document I could re-read. If the audit exists outside the repo, one of its arguments may not be represented here.

---

# 1. Exact inventory of what option A would remove

## 1.1 Headline totals

| Surface | Option A's four features | Whole file/area | Share |
|---|---:|---:|---:|
| `frontend/mailbox.js` | **~2 010 lines** **[C]** | 6 268 | 32.1 % |
| `frontend/style.css` | **108 rules / 714 lines** **[M]** | 5 623 | 12.7 % |
| `frontend/api.js` | **167 lines**, 17 methods **[C]** | 849 | 19.7 % |
| `src/api.py` | **494 lines**, **17 of 64 routes** **[C]** | 2 615 | 18.9 % |
| `src/database.py` | **393 lines**, 5 tables, 37 columns, 8 indexes, 26 helpers **[C]** | 3 031 | 13.0 % |
| `src/email_sender.py` | **526 lines** (the whole module) | 526 | 100 % |
| `frontend/i18n.js` | **~77 keys per locale = 154 strings** **[C]** | 815 keys / 1 630 | 9.4 % |
| `src/i18n.py` | **22 keys per locale = 44 strings** **[C]** | — | — |
| `src/agent_tools.py` | **2 of 15 tools**, ~55 lines | 523 | 10.5 % |
| pytest | **0 tests deleted, 5 tests edited** | 450 collected **[M]** | 1.1 % |
| Playwright | **2 specs edited, 1 snapshot rebaselined** | 36 tests | — |

The line counts come from brace-matched function ranges, not from grep hit counts. A looser identifier scan over `mailbox.js` finds 588 individual lines that *mention* one of these features; the 2 010 figure is the sum of whole blocks that would actually be cut.

## 1.2 Full composer (reply + fresh compose + attachments)

**JavaScript — `frontend/mailbox.js`, verified block ranges [C]**

| Block | Lines | Count |
|---|---|---:|
| `sendButtonStateFactory` | `frontend/mailbox.js:426-447` | 22 |
| comment + `buildComposerMetaHtml` | `:449-519` | 71 |
| comment + `bindComposerFromDropdown` | `:521-569` | 49 |
| sidebar "Nouveau message" CTA markup | `:655-658` | 4 |
| composer drag & drop (comment + 4 handlers + 4 listeners) | `:836-842`, `:866-895` | 37 |
| reply-composer markup inside `renderEmail` | `:3717-3760` | 44 |
| `bindComposerFromDropdown($('#read-pane'))` | `:3769` | 1 |
| **contiguous composer/drafts/forward wiring** — `openComposer` through the `#mb-composer-handle` drag-resize handler | `:3877-4617` | **741** |
| `#btn-ai-draft` SSE streaming into the composer textarea | `:4646-4705` | 60 |
| `renderComposeNew` + its 4 nested functions | `:5591-5911` | **321** |
| `$('#cta-compose')` handler | `:5913` | 1 |

Sub-total, composer proper: **~1 351 lines**. Inside the 741-line stretch, the individually verified pieces are `openComposer` `:3877-3938` (62), `closeComposer` `:4206-4284` (79), `renderAttachStrip` `:4297-4322` (26), `handleFilePick` `:4324-4346` (23), `sendCurrentMessage` `:4365-4425` (61).

**CSS** — 40 rules / 304 lines matching `mb-composer|mbc-|mb-compose` **[M]**, of which 3 rules are shared and must be edited rather than deleted: `frontend/style.css:1270` (focus-visible, shared with `.log-feed` and `.cmdk-*`), `:2856` (shared with `.mb-ai-draft-btn`), `:3903` (the `@media print` hide-list, 17 lines, shared with the label chip). Fully exclusive: **37 rules / 266 lines**.

**i18n** — `mb.composer.*` 14, `mb.compose` 1, `mb.send` 1, `mb.send.sending`, `mb.send.sent` = **18 keys per locale**, 36 strings **[C]**. Plus `mb.toast.upload_fail`, `mb.toast.uploading`, `mb.toast.send_fail`.

**API routes** — `POST /api/emails/send` `src/api.py:662-747` (86 lines, `@limiter.limit("30/minute")` at `:663`); outbound uploads `POST /api/uploads` `:1073`, `GET /api/uploads/{id}` `:1141`, `DELETE /api/uploads/{id}` `:1149`, with their helpers `_outbox_upload_path` `:1038`, `_safe_upload_filename` `:1017`, `_read_upload_metadata` `:1052`, `_OUTBOX_MAX_SIZE` `:999`, `_OUTBOX_BLOCKED_EXTS` `:1006` — the whole section `src/api.py:991-1160` is **170 lines**.

**Python module** — `src/email_sender.py`, **526 lines**, 12 module-level functions (`_resolve_account:52`, `_resolve_smtp_settings:72`, `_resolve_password:115`, `_split_addrs:135`, `_validate_addr:148`, `_resolve_upload:161`, `_cleanup_uploads:188`, `_build_message:206`, `_open_smtp:329`, `send_message:364`, `new_message_id:522`), 1 exception class with **16 distinct `stage` values** and 18 raise sites.

**Database** — `outbox` table `src/database.py:356-373` (15 columns), indexes `:374`, `:375`; helpers `insert_outbox_pending:2642`, `mark_outbox_sent:2670`, `mark_outbox_failed:2686` — section `:2639-2699`, 61 lines.

**frontend/api.js** — `sendEmail` `:312-356` (45), uploads `:243-281` (39).

**Tests** — **zero**. `grep -rF "/api/emails/send" tests/*.py` → 0. `grep -rF "/api/uploads" tests/*.py` → 0. `grep -rl "email_sender" tests/` → no match. The 526-line SMTP module and the 170-line upload handler have no test at any level. The only tests that name sending assert its *absence* from the agent: `tests/test_agent.py:24 test_no_send_tool_exposed`, `tests/test_mcp_tools.py:32 test_mcp_has_no_send_tool`.

## 1.3 Forward

**JS** — `buildForwardBody` `frontend/mailbox.js:3500-3514` (15), `#btn-forward` markup `:3696-3699` (4), click handler `:4457-4470` (14) = **33 lines** **[C]**.
**CSS** — none of its own (it reuses `.read-action-btn`).
**i18n** — `mb.action.forward`, `mb.forward.header`, `mb.forward.date` = **3 keys per locale**.
**Routes/DB/Python/agent** — **none**. Forward shares `POST /api/emails/send` entirely.
**Tests** — `frontend/tests/e2e/read-pane.spec.mjs:16` lists `btn-forward` in `EXPECTED`; the snapshot `frontend/tests/e2e/read-pane.spec.mjs-snapshots/read-pane-1400-light-win32.png` would need rebaselining. 1 test edited, 1 snapshot.

## 1.4 Labels (personal)

**JS — `frontend/mailbox.js` [C]**

| Block | Lines | Count |
|---|---|---:|
| sidebar ÉTIQUETTES section markup | `:694-711` | 18 |
| selection-bar `data-act="tag"` button | `:779-781` | 3 |
| `renderUserLabels` (+ comment) | `:1055-1109` | 55 |
| `loadUserLabels` | `:1111-1121` | 11 |
| `LABEL_PALETTE` (+ comment) | `:1123-1135` | 13 |
| `openLabelModal` | `:1137-1287` | **151** |
| `openTagPopover` | `:3028-3143` | **116** |
| read-pane chips + `#btn-label-add` markup | `:3642-3649` | 8 |
| `#btn-label-add` handler | `:3786-3800` | 15 |
| `onSelBarClick` tag dispatch | `:3201` | 1 |
| `state.userLabels` / `state.labelFilter` + view persistence | `:826-827`, `:608-631` | ~5 |

Sub-total **~396 lines**.

**CSS** — 50 rules / 316 lines **[M]**: `.mb-label-chip*` 5 rules/48, `.mb-label-modal*`+`swatch`+`palette` 23/134, `.mb-tag-popover*` 15/84, `.mb-userlabel*` 7/50. **`.mb-label` itself is NOT removable** — `frontend/style.css:513-572` is shared with the *category* sidebar list (`renderLabels` `frontend/mailbox.js:1003-1053`), which lot 3 explicitly kept.

**i18n** — 21 keys per locale: `mb.label.*` 16, `mb.tag_pop.head`, `mb.action.tag`, `mb.sidebar.labels`, `mb.toast.tagged`, `mb.toast.fail_tag`. Plus `cmdk.tool.list_labels`, `cmdk.tool.label_email`. **[C]**

**Routes** — 5: `GET /api/labels` `src/api.py:842`, `POST` `:847`, `PATCH /api/labels/{id}` `:862`, `DELETE` `:884`, `PUT /api/emails/{id}/labels` `:893`. Section `:827-908` = 82 lines. Plus `_attach_counts_and_labels` `:271-283` calls `db.get_labels_for_emails` on **every** `/api/emails` and `/api/emails/search` response.

**DB** — `labels` `src/database.py:406-413` (5 cols) + `idx_labels_position:414`; `email_labels` `:421-428` (3 cols, composite PK, FK CASCADE) + `idx_email_labels_label:429`, `idx_email_labels_email:430`. 8 helpers, section `:2798-2937` = 140 lines. Plus the `label:` clause in `search_emails` `:969-974` (6 lines) and the thread-level clause in `get_threads` `:1030-1039` (10 lines) plus its `label` parameter `:1011`.

**Agent/MCP** — `list_labels` `src/agent_tools.py:152-157`, `label_email` `:177-197`, their `TOOL_SPECS` entries `:373-380` and `:457-473`, the `label:` operator in `SEARCH_OPERATORS_DOC` `:264`. 2 of 15 tools. `src/mcp_server.py` needs no edit — it enumerates `TOOL_FUNCS` at `:44-46`.

**Tests** — 1 pytest edited: `tests/test_threading.py:125 test_get_threads_honors_label_filter` (uses `db.create_label` `:133`, `db.set_email_labels` `:136`) would be deleted outright. 1 Playwright edited: `frontend/tests/e2e/search-help.spec.mjs:52` lists `label` among the 11 operators the help panel may show. `frontend/tests/i18n.test.mjs:140 'no key is defined that nothing renders'` fails unless the 21 keys go in the same commit — that is the guard that makes the removal testable.

## 1.5 Local (custom) folders

**JS — `frontend/mailbox.js` [C]**: `#btn-add-folder` markup `:668-671` (4), custom rows in `renderFolders` `:941-950` (10), `[data-edit-folder]` wiring `:971-984` (14), `loadCustomFolders` `:988-999` (12), `openFolderModal` `:1291-1375` (**85**), custom entries in `openMovePopover` `:3170-3175` (6), `state.customFolders` `:828` (1) = **~132 lines**.

**CSS** — exclusive: 3 rules / 17 lines (`.mb-folder-edit` `frontend/style.css:2373-2387`, `:2388`, `:2389`) **[M]**. Everything else under `.mb-folder` is the built-in sidebar row and stays.

**i18n** — 12 keys per locale (`mb.folder.create`, `edit_title`, `modal.*` ×5, `toast.*` ×4, `confirm.delete`). `mb.folder.inbox|sent|draft|favourite|deleted` are built-ins and stay. Plus `cmdk.tool.list_folders`, `cmdk.tool.move_email` survive in reduced form. **[C]**

**Routes** — 4: `GET /api/folders` `src/api.py:935`, `POST` `:940`, `PATCH` `:953`, `DELETE` `:982`; helpers `_FOLDER_NAME_RE:913`, `_folder_to_api:916`, `_validate_folder_name:925`. Section `:910-989` = 80 lines. Plus `_valid_folders()` `:107-109`, which runs `db.custom_folder_names()` on **every** `PATCH /api/emails/{id}` that sets a folder (`:437`).

**DB** — `folders` `src/database.py:439-445` (4 cols) + `idx_folders_position:446`; 6 helpers `:2938-3031` = 94 lines including `custom_folder_names:3028`.

**Agent** — `list_folders` `src/agent_tools.py:160-162` and `move_email` `:217-226` shrink to `_BUILTIN_FOLDERS` (`:21`); neither tool disappears.

**Tests** — `tests/test_cleanup_suggestions.py:75` and `:331` call `db.create_folder("Archive")`; `:66` parametrises `("in a folder of their own", {"folder": "Archive"})`. 2 tests edited, 1 parametrisation case dropped. `tests/test_agent.py:57 test_tool_move_and_mark` uses `move_email(iid, "deleted")` — a built-in, unaffected.

## 1.6 Drafts (the table, the Brouillons folder, the AI draft box)

Not one of the four named items, but it dies with the composer and is the largest hidden dependency.

**JS** — draft box markup `frontend/mailbox.js:3561-3588` (28), `replyDraft` state + capture `:3939-3973` (35), `refreshDraftBox` `:3975-4023` (49), draft lookup IIFE `:4025-4049` (25), `saveReplyDraft` `:4051-4139` (89), `scheduleReplyDraftSave` `:4141-4147` (7), `deleteReplyDraft` `:4158-4204` (47), `bindReplyAutosave` `:4499-4512` (14), `#btn-draft-edit`/`#btn-draft-discard` `:4473-4497` (25), `#btn-draft-send` `:4525-4540` (16), negative-id draft route in `openEmail` `:4790-4800` (11), draft branch in `bulkSetTarget` `:2844-2878` (35), draft-list shim in `loadEmails` `:5245-5282` (38) = **~419 lines** **[C]**.
**CSS** — 12 rules / 81 lines (`.mb-draft*`) **[M]**.
**i18n** — 17 keys per locale.
**Routes** — 4: `src/api.py:771, 780, 799, 818`; section `:750-825` = 76 lines. **Tests: 0** (`grep -rF "/api/drafts" tests/*.py` → 0).
**DB** — `drafts` `src/database.py:384-396` (10 cols) + 2 indexes + 5 helpers `:2700-2797` (98 lines).

---

# 2. What is load-bearing and not obvious

### 2.1 Nettoyage does not structurally depend on custom folders — but a user-facing opt-out does

`tests/test_cleanup_suggestions.py:66` asserts `("in a folder of their own", {"folder": "Archive"})` produces no card. The mechanism is **not** a "not a custom folder" clause: `src/database.py:77` is

```python
_CLEANUP_LIVE = "folder = 'inbox' AND is_favourite = 0 AND needs_reply = 0"
```

a *positive* predicate. Any value other than `'inbox'` is out of reach, so deleting custom folders leaves the invariant byte-identical, the four partial indexes built on it (`src/database.py:514-528`) unchanged, and `tests/test_cleanup_perf.py:53` and `:136` green. Only that one parametrisation case is removed.

**What is genuinely lost** is the second user-controlled opt-out. Today a message escapes every Nettoyage card by being starred (`is_favourite`), by being flagged `needs_reply` by the AI, or by being filed anywhere the user chooses. `docs/DESIGN-SIMPLE-PAR-DEFAUT.md` already names the star as the documented protection and kept the Favoris folder for exactly that reason. Remove custom folders and, with the AI off, the star is the *only* remaining shield. That is a real reduction in user control over a destructive feature, and it is not visible from the test name.

### 2.2 The search grammar references labels in three places, and one of them is a test

`src/search_query.py` accepts `label:` (`:22`, `:35`, `:53`, `:94-95`). It is consumed by `src/database.py:969-974` (a subquery join on `email_labels`), and the thread view has a second, different clause at `src/database.py:1030-1039` that keeps whole threads containing a labelled message. The operator is advertised in three user-facing places: the search help panel (`frontend/mailbox.js:743`), `SEARCH_OPERATORS_DOC` injected into the agent prompt (`src/agent_tools.py:264`), and `frontend/tests/e2e/search-help.spec.mjs:52`, which asserts the panel only shows operators the parser actually accepts. The docstring at `src/search_query.py:26-27` states the contract: "Consumed by BOTH the mailbox search bar and the AI agent's search_emails tool." Removing `label:` is a four-site edit, all four mechanical.

`in:<folder>` is a different matter: `src/search_query.py:71` lowercases the value, and `src/database.py:949-951` compares it to `emails.folder`. Custom folder names are user-typed with arbitrary case (`_FOLDER_NAME_RE` at `src/api.py:913` allows `[\w\- ]{1,40}`), so `in:Factures` already fails today for any folder whose name is not all-lowercase. That is a pre-existing bug that removing custom folders would incidentally delete.

### 2.3 The agent's tool surface does not break, and it already refuses to send

`TOOL_FUNCS` (`src/agent_tools.py:227-243`) has 15 entries. Option A removes exactly 2 — `list_labels` and `label_email`. `list_folders` and `move_email` survive on `_BUILTIN_FOLDERS` (`:21`). `draft_reply` (`:199-208`) writes `emails.draft_response` and `needs_reply`, not the `drafts` table, so it survives the drafts removal untouched. `src/mcp_server.py:44-46` iterates `TOOL_FUNCS.items()`, so the MCP server needs no edit at all.

The more interesting fact is the standing invariant: `src/mcp_server.py:9` says "Read + draft only; there is no send tool", and two tests enforce it by regex (`tests/test_agent.py:24`, `tests/test_mcp_tools.py:32`). The product has *already decided* the AI may not send. Option A extends that rule from the agent to the human.

### 2.4 The offline queue never touches labels or custom folders

`pending_ops` (`src/database.py:451-466`) carries exactly three operations — `seen`, `flagged`, `trash` — and `_drain_pending_ops` (`src/scheduler.py:325-375`) dispatches only those. Labels are never pushed to IMAP; custom folders are never pushed to IMAP. `set_email_folder_tx` (`src/database.py:1436-1456`) only queues an op when the target is `'deleted'`, and for any other target it *cancels* a pending trash op (`:1454`). So moving a mail to a custom folder is the app's undo-a-pending-delete path — but so is moving it to `inbox`, which stays. **The offline queue is entirely unaffected.** One consequence worth stating plainly: a mail "archived" into `Factures` is still sitting in INBOX on the server (`src/email_fetcher.py:1022` only ever selects INBOX), invisible to every other client the user owns.

### 2.5 Removing SMTP removes the ability to reply — there is no separate reply path

Exactly two call sites reach the network: `frontend/mailbox.js:4390` (the reply composer's `sendCurrentMessage`) and `:5872` (`renderComposeNew`'s send). Both call `api.sendEmail` (`frontend/api.js:318`) → `POST /api/emails/send` (`src/api.py:662`) → `email_sender.send_message` (`src/email_sender.py:364`). **Deleting SMTP deletes reply, forward and compose in one cut.** "Keep reply, drop compose" is a frontend-only change; it does not shrink `email_sender.py` by one line.

### 2.6 Forward *is* the fresh composer

`frontend/mailbox.js:4457-4470` handles `#btn-forward` by calling `renderComposeNew({draft: {...body_text: buildForwardBody(em)}})`. So "reply and forward but no fresh compose" keeps the entire 321-line `renderComposeNew` and deletes only 5 lines (`:655-658` markup + `:5913` handler). This is the single most counter-intuitive finding in the inventory: the cheapest meaningful reduction is nearly free, and the expensive deletion (`renderComposeNew`) is blocked by forward, not by compose.

### 2.7 The local Sent copy is the only copy

`src/email_sender.py:485-504` inserts a row into `emails` with `uid: None`, then `update_email_folder(..., "sent")`. There is **no IMAP APPEND anywhere in the codebase** — I grepped `src/email_sender.py` and `src/email_fetcher.py` and every `append` hit is a Python list operation. A message sent from Lull Mail therefore never appears in the user's Sent folder on Gmail / Proton / OVH; it exists in this SQLite file and nowhere else. Two consequences: `outbox` + those `emails` rows are irreplaceable user data (§6), and the Sent folder's own design already concedes it (`frontend/mailbox.js:921-926` hides Sent until `sentCount > 0`; `frontend/tests/e2e/chrome.spec.mjs:46` asserts it is absent on a first run).

### 2.8 `outbox` is write-only

`insert_outbox_pending` (`src/api.py:695`), `mark_outbox_failed` (`:721`, `:739`), `mark_outbox_sent` (`:742`). Nothing ever reads the table — no retry job, no UI, no diagnostics route. The comment at `src/database.py:350-352` admits it: "the table exists for diagnostics … and so a future retry job can re-pick up `status='failed'` rows." That job does not exist. A send that fails while offline fails *immediately*, toasts, and is never retried — the mutation queue that lot 2 built for seen/flagged/trash was never extended to outbound mail.

### 2.9 Labels cost almost nothing at runtime — do not argue the reduction on performance

`_attach_counts_and_labels` (`src/api.py:258-283`) runs `db.get_labels_for_emails` on every list and search response. Measured on the 21 300-row / 3-account DB, 500-row page **[M]**:

| | median | p95 |
|---|---:|---:|
| `get_labels_for_emails(500)`, no labels defined | **1.60 ms** | 2.01 ms |
| `get_labels_for_emails(500)`, 3 labels, 1 per row | **2.33 ms** | 2.95 ms |
| `attachment_counts_for_messages(500)` | 1.99 ms | 3.98 ms |
| `GET /api/emails?limit=500` with the label attach | **180.8 ms**, 21 220 373 B | 184.5 ms |
| same, label attach stubbed out | **175.5 ms**, same bytes | 185.4 ms |

Deleting labels saves **~2–5 ms of a 181 ms request and 0 bytes of the 21.2 MB**. (This also independently reproduces the baseline's 182.4 ms / 21 192 541 B — the two runs agree to 1 %.) The 21.2 MB problem is `SELECT *` at `src/database.py:875` shipping bodies, which is untouched by option A.

### 2.10 The AI half of the product exists to produce a reply

If the app cannot send, these all become dead weight: `POST /api/emails/{id}/draft` (`src/api.py:463`), `POST /api/emails/{id}/draft/stream` (`:560`), `src/draft_verify.py` (87 lines), the `auto_draft` per-account setting (`src/config.py:263`, `src/setup_api.py:322`, `src/scheduler.py:917-940`, `frontend/settings.js:526`), `db.mark_auto_draft` (`src/database.py:707`), the `#mb-draft` box, **7 tests in `tests/test_auto_draft.py`**, 5 in `tests/test_draft_verify.py`, and **3 drafter models in the catalogue** (`src/llm/catalog.py:66`, `:93`, `:112`) with their `DrafterServer` (`src/llm/local_provider.py:49`). `docs/DESIGN-SIMPLE-PAR-DEFAUT.md` states the second local model "ne sert qu'à la rédaction automatique". Kill sending and you kill roughly half the local-LLM investment.

---

# 3. The honest case FOR the reduction

**3a. The biggest untested, unlocalised surface in the app is the one option A deletes.** `src/email_sender.py` (526 lines) + `POST /api/emails/send` (86) + `/api/uploads` (170) = **782 lines of security- and network-sensitive Python with zero test coverage**, out of a 450-test suite. Inside it: a second, independent filename sanitiser (`_safe_upload_filename`, `src/api.py:1017`) and path-traversal guard (`_outbox_upload_path`, `:1038`) that duplicate `src/attachment_security.py` — which *is* tested (`tests/test_attachment_security.py:10`, `:75`). And all 18 `SendError` messages are hardcoded French (`src/email_sender.py:62`, `:67`, `:108`, `:352`, `:431`, …); `src/i18n.py` carries only 4 send keys, so an English user who fails to send reads French. In an app whose audit's opening praise was "919 clés, parité FR/EN parfaite" (`docs/AUDIT-UX-BOITE-MAIL.md:39`), sending is the hole.

**3b. It deletes a real amount of frontend.** 2 010 of 6 268 lines of `mailbox.js` (32 %), 108 CSS rules / 714 lines (12.7 %) **[M]**, 154 i18n strings. `renderEmail` is 1 192 lines (`frontend/mailbox.js:3516-4707`) and **741 of them — 62 % — are the composer** (`:3877-4617`). The function that renders a message is mostly not about rendering a message.

**3c. It removes three tables and their migration weight.** `outbox` (write-only, §2.8), `drafts`, `labels`+`email_labels` — 33 of 37 columns, 7 of 8 indexes.

**3d. What the third complaint actually pointed at, quantified.** Lot 3 measured 29 → 22 visible controls in the view. I re-measured on the same hermetic server (`scripts/ui_test_server.py`, 1400×900, one account, AI on, 18 messages) **[M]**:

| Zone | controls now | of which option A's |
|---|---:|---:|
| Sidebar, no custom folder, no personal label | **15** | **4** — `#cta-compose`, `#btn-add-folder`, `#btn-add-label`, `[data-folder="draft"]` |
| List header | **7** | 0 |
| Rail | **8** | 0 |
| Read pane, one message open | **9** | **2** — `#btn-label-add`, `#btn-forward` |
| Read-pane toolbar proper (the "6" lot 3 claims) | **6** | **1** — `#btn-forward` |
| Selection bar, select-all | **6** | **1** — `data-act="tag"` |

15 + 7 = 22, which reproduces lot 3's headline number exactly, and the toolbar's 6 likewise. So: **of the 11 controls the complaint was about, lot 3 removed 7 and option A would remove the remaining 4 from the view** (22 → 18), plus 2 of 9 in the read pane and 1 of 6 in the selection bar.

**3e. The ceiling is much higher for a user who actually uses the features.** With 2 custom folders and 3 personal labels created, the sidebar goes **15 → 26 controls** **[M]** — folders and labels add 11 (2 per folder, 2 per label, plus the "Toutes" row). Opening the reply composer takes the read pane from 9 → 17 **[M]**. The fresh-compose screen is 7 controls of its own. So the complaint's ceiling is not 4 controls; for an engaged user it is closer to 20.

**3f. It is consistent with a decision the product already made.** Two tests enforce "the AI may never send" (`tests/test_agent.py:24`, `tests/test_mcp_tools.py:32`), and `src/mcp_server.py:9` states it in prose. `docs/MARKETING.md:11` positions the product as "Your inbox, on mute. Silent by default." Nothing in the marketing document sells composing.

**3g. The i18n orphan test makes the removal provable.** `frontend/tests/i18n.test.mjs:140 'no key is defined that nothing renders'` fails if the 154 strings are not deleted with the code, and `:25` fails if FR and EN drift. Combined with a grep gate in CI (the pattern `docs/DESIGN-NETTOYAGE.md:724` already established for the rules removal), "nothing is left behind" is a testable claim, not an assertion.

---

# 4. The honest case AGAINST

**4a. Lot 3 deliberately made the product shout "reply here".** `frontend/mailbox.js:3698-3701`: Répondre is the only accent-filled control in the read pane, and the only one with a word instead of an icon. Three tests pin this: `frontend/tests/e2e/read-pane.spec.mjs:63 'Répondre is the only filled control, and it says so in words'`, the `EXPECTED` toolbar list at `:10-18`, and the visual snapshot. The design brief argues for it in prose: "Group 2 — answering … the only one worth a word" (`frontend/mailbox.js:3694-3695`). Five months of design work converged on making reply *the* action; option A deletes the thing the whole read pane points at.

**4b. "Triage only" for someone who must answer 1 mail in 50.** `docs/MARKETING.md:37` — "You get 80 emails a day. Three of them actually matter." Take the harsher 1-in-50: on 80 mails/day that is still ~1.6 replies a day, ~600 a year. The workflow becomes: triage in Lull, then open Gmail/Outlook, find the message *again* (it is still in INBOX because Lull's filing is local, §2.4), and reply there. The app has saved the user the reading and cost them a context switch per reply. The mail the user cares most about is precisely the mail Lull would refuse to handle.

**4c. It orphans the AI's output.** §2.10: the drafter models, `auto_draft`, `draft_verify.py`, 12 tests and the `#mb-draft` box all exist to hand the user a reply. A local LLM that writes a reply the app cannot send is a feature that ends in "now copy this into your other mail client". `frontend/i18n.js:376` currently promises "Préparé pour les mails qui attendent une réponse — jamais envoyé sans vous" — the reassurance stops making sense when there is no "envoyé".

**4d. Labels are the only personal taxonomy that survives the AI being wrong.** `src/database.py:400-404`: "Distinct from `category` (a fixed enum from AI classification): labels are personal, multi-valued, and **never modified by the AI loop**." `wipe_ai_analyses` (`:763`) and `requeue_emails_by_reason` (`:793`) rewrite categories wholesale; nothing rewrites a label. Lot 3 already kept them for a stated reason (`docs/DESIGN-SIMPLE-PAR-DEFAUT.md`: hiding them would leave the tagging popover, which cannot create a label, with no exit).

**4e. Custom folders are the user's only escape from a destructive automated feature.** §2.1. With the AI off — a first-class supported mode (`tests/test_no_ai_mode.py`, `frontend/tests/e2e/ai-off.spec.mjs`) — `needs_reply` is never set, so a starless, AI-less user has exactly one opt-out left.

**4f. Removing `label:` shrinks the one thing the audit praised.** The search grammar is 11 operators, documented in a native `<details>` panel that lot 3 built specifically to replace a filter bar that filtered nothing (`docs/DESIGN-SIMPLE-PAR-DEFAUT.md`). Going to 10 is a small regression in the feature lot 3 *added*.

**4g. The first-run gain is 4 controls.** §3d. For the user who has never created a folder or a label — the user the complaint came from — option A removes 4 sidebar controls, 1 toolbar button, 1 chip and 1 selection-bar button. That is real but modest against deleting ~2 000 lines of JS, 782 lines of untested Python, 3 tables and the product's ability to answer mail. The larger gain (§3e) accrues only to users who opted into the features being removed — i.e. the removal hurts most exactly the people it declutters most.

**4h. There is no coming back cheaply.** §6.

---

# 5. Five positions between "full client" and "triage only"

I have priced these in commits and days as **[E]**, my estimates, using the shipped lots as the unit (lot 3 = 14 commits).

### M1 — "Hide what a first run cannot use" (lot 3's own method, extended)
**Keeps** everything. **Drops from the screen**: `#btn-add-folder` when `folders` is empty; the ÉTIQUETTES section entirely when `labels` is empty (today `renderUserLabels` `frontend/mailbox.js:1062-1065` renders an empty-state div instead of hiding); `[data-folder="draft"]` when `drafts` is empty — the same rule `renderFolders` `:921-926` already applies to Sent. That is **3 of the 4 remaining option-A controls**, at zero capability cost. **Build**: ~30 JS lines, 1 commit. **[E]** **Proof**: extend `frontend/tests/e2e/chrome.spec.mjs:43` with three `toHaveCount(0)` assertions and one "they come back once you create one".
**Catch**: `docs/DESIGN-SIMPLE-PAR-DEFAUT.md` explicitly rejected a page that "diffère pour des raisons invisibles". Conditional chrome is exactly that — though Sent already does it, so the precedent is the project's own.

### M2 — Drop fresh compose, keep reply and forward
**Keeps**: reply composer, forward, SMTP, attachments, drafts (reply-scoped), Sent, the AI drafter. **Drops**: the "Nouveau message" CTA — `frontend/mailbox.js:655-658` and `:5913`, **5 lines**. `renderComposeNew` stays because forward calls it (§2.6). The Brouillons folder keeps working (reply autosave writes the same table with `in_reply_to_int` set, `src/database.py:2729-2751`). **Build**: 1 commit, half a day. **[E]** **Removes**: 1 sidebar control, and the app stops advertising itself as a place you start mail.
**This is the highest ratio of positioning change to code changed anywhere on this list.**

### M3 — Reply-only, no forward, no compose, no attachments
**Keeps**: the reply composer, SMTP, the AI drafter, reply drafts, Sent. **Drops**: `renderComposeNew` (321), forward (33), `#cta-compose` (5), `/api/uploads` ×3 + helpers (`src/api.py:991-1160`, 170), `frontend/api.js:243-281` (39), the attach buttons and staged-attachment code (`frontend/mailbox.js:4295-4364`, `:5668-5751`, ~120), composer drag & drop (`:836-895`, 37), `_resolve_upload`/`_cleanup_uploads` (`src/email_sender.py:161-205`, 45), the Brouillons folder shim (`:5245-5282`, `:2844-2878`, `:4790-4800`, 84). **~880 JS + ~255 Python lines.** **Build**: 4–6 commits, 2–3 days. **[E]**
Rationale: a triage reply is "oui, jeudi 14h" — it does not carry a 25 MB PDF. This deletes the entire outbound-file attack surface (§3a) while keeping the product able to answer.

### M4 — Triage + handoff (`mailto:`), no SMTP at all
**Keeps**: triage, Nettoyage, search, labels/folders if wanted. **Drops**: `src/email_sender.py` (526), `POST /api/emails/send` (86), `/api/uploads` (170), `outbox` (15 cols + 2 idx + 61 helper lines), the drafts table and routes, ~1 350 JS lines of composer, the SMTP fields in `src/config.py:254-257` and `src/setup_api.py:314-317` and the 9 presets' SMTP keys.
**Adds**: Répondre becomes `window.open('mailto:…?subject=Re:…&body=' + quoted)`. **The codebase already has this pattern**: `unsub_one` returns `action_required: "open_mailto"` (`src/api.py:1919-1932`) and the frontend already `window.open`s it. `buildForwardBody` (`frontend/mailbox.js:3500-3514`) already builds the quoted block. **Build**: ~80 new JS lines plus the deletions — 5–8 commits, 3–4 days. **[E]**
**What it costs the user**: the reply leaves no trace in Lull (no local Sent copy), the AI drafter's text has to survive a URL-encode into another app, and `mailto:` bodies are capped at ~2 000 characters on Windows. **What it buys**: the app never holds an SMTP session, never stores an outbound file, and the 782 untested lines go away.

### M5 — Replace personal labels with the flag that already exists
**Keeps**: everything about mail handling. **Drops**: `labels` + `email_labels`, 5 routes, 8 DB helpers, `openLabelModal` (151), `openTagPopover` (116), the sidebar section, 49 CSS rules, 21 i18n keys, 2 agent tools, the `label:` operator, `tests/test_threading.py:125` — **~396 JS + ~250 Python lines**.
**Replaces with**: nothing new. `is_favourite` already exists, is already pushed to IMAP as `\Flagged` (`src/scheduler.py:357`, unlike labels), already has a sidebar folder, already has `is:starred` in the grammar, and is already the Nettoyage opt-out. **Build**: 3–5 commits, 1.5–2 days plus a migration. **[E]**
**Cost**: multi-valued becomes single-valued; colour and name are lost. **Gain**: the surviving marker is the one that syncs to the user's other clients.

*(A sixth, for completeness: **M6 — local folders → nothing**, because `folder` already holds `sent`/`draft`/`deleted` and only custom *values* are removed; ~132 JS + ~174 Python lines, 2–3 commits. It composes freely with any of M1–M5.)*

---

# 6. What is irreversible about each

| Deleted | Irreversible loss | Recoverable? | A migration must… |
|---|---|---|---|
| `drafts` table | Unsent text the user typed. Never pushed to IMAP (`insert_draft` `src/database.py:2729` writes locally only; no APPEND exists). | **No.** Nowhere else. | Export every row to a `.txt`/`.eml` per draft before dropping, or refuse to drop while `COUNT(*) > 0`. |
| `outbox` + the local Sent copies in `emails` | **The only record of what the user sent.** §2.7 — no IMAP APPEND anywhere, `uid: NULL`, never refetched. | **No.** Not from the mail server, not from any other client. | Keep `folder='sent'` rows in `emails` even with the composer gone, or export them as `.eml`. This is the sharpest single irreversibility in option A. |
| `labels` + `email_labels` | The user's personal taxonomy. Never written to IMAP keywords; `insert_email` (`src/database.py:563-640`) never reads them back. | **No.** | Either map each label to a `folder` value, or dump `name,color,email_int_id` to CSV. Silently `DROP` destroys hand-curation with no signal. |
| `folders` table | The folder *names*. The **mail** is safe: `delete_folder(fallback_name="inbox")` (`src/database.py:3011-3025`) already re-files every row before dropping the folder. | Mail yes, filing no. | Call the existing `delete_folder` per row rather than `DROP TABLE`; otherwise `emails.folder='Factures'` is stranded in a value no view lists (`renderFolders` `frontend/mailbox.js:919` would not render it, `get_emails` would never match it). |
| SMTP config | **Not credentials.** `src/config.py:254-257` is `smtp_host/port/ssl/starttls` only; `src/email_sender.py:115-130` resolves the password from the **IMAP** keyring entry (`secrets_store.SERVICE_IMAP`), and `_resolve_smtp_settings:72-113` falls back to the provider preset when host is blank. | **Yes, trivially.** A user on Gmail/OVH/Orange/Free/Proton typed nothing — the preset supplies it. Only a custom-relay user loses 4 typed fields. | Nothing, but the brief's assumption that "deleting SMTP config loses credentials the user typed" is **wrong** and should not weigh on the decision. |
| Composer/forward/labels/folders **code** | Nothing. | Yes — it is in git. | — |

**The irreversibility asymmetry that should drive the sequencing:** deleting *code* is free to undo (it is a revert), deleting *rows* is not. Every one of M1–M6 can ship as code-only first, with the `DROP TABLE` deferred — the pattern `docs/DESIGN-NETTOYAGE.md:666` already chose for `custom_rules`: `ALTER TABLE … RENAME TO …_removed_v2`, with the real `DROP` two versions later. "One dead table in a single-user SQLite file buys a reversible release."

---

# 7. Decision table

| Option | Keeps | Loses | Build cost **[E]** | Risk |
|---|---|---|---|---|
| **Status quo** | Everything | Nothing | 0 | 782 untested Python lines stay; 4 first-run controls stay; the complaint is 64 % answered (7 of 11 controls) |
| **M1 — hide-when-empty** | Everything | Nothing | ~30 JS lines, 1 commit | Very low. Conflicts with "no invisible state", though Sent already does it |
| **M2 — no fresh compose** | Reply, forward, SMTP, drafts, Sent, AI drafter | The "start a new mail" affordance | **5 lines**, 1 commit | Very low. Product reads as a triage surface; nothing is deleted |
| **M3 — reply-only, no attachments** | Reply, SMTP, AI drafter, Sent | Forward, compose, all outbound files | ~880 JS + ~255 Py deleted, 4–6 commits | Low–medium. Deletes the whole untested upload path. User who must forward an invoice is stuck |
| **M4 — triage + `mailto:` handoff** | Triage, Nettoyage, search | SMTP, Sent, drafts, all outbound; the AI drafter becomes copy-paste | ~80 new JS lines + ~2 100 deleted, 5–8 commits | **High.** Contradicts lot 3's accent-on-Répondre; ~2 000-char `mailto:` cap; no record of replies. Handoff pattern is already proven in-repo (`src/api.py:1919`) |
| **M5 — labels → the star** | All mail handling | Multi-valued + coloured tagging | ~650 lines deleted + migration, 3–5 commits | Medium. Irreversible for the taxonomy; the survivor syncs to IMAP, which labels never did |
| **M6 — drop custom folders** | All mail handling | User-named local filing; one Nettoyage opt-out | ~306 lines deleted, 2–3 commits | Low. `delete_folder` already re-files safely; Nettoyage's invariant is untouched (§2.1) |
| **Full option A** | Triage, Nettoyage, search, categories, star | Compose, reply, forward, labels, folders, drafts, Sent, the AI drafter's purpose | ~2 010 JS + ~1 400 Py + 714 CSS + 154 i18n deleted; 12–18 commits | **Highest.** Every risk above, at once, plus four irreversible data losses |

---

# 8. My view — clearly marked as mine, with the strongest argument against it

**My view.** The evidence supports removing the *periphery* and keeping the *answer*. Concretely: M2 + M6 + M1, and M3 if the outbound-file surface is judged unacceptable. I would not take full option A.

Three reasons. (i) The measured first-run gain of option A over what lot 3 already shipped is **4 sidebar controls, 1 toolbar button, 1 chip and 1 selection-bar button** — 22 → 18 in the view **[M]** — while its cost includes four irreversible data losses and the product's only way to answer a message. (ii) M2 achieves most of the positioning signal — no "Nouveau message" CTA, no pretence of being where you start mail — for **5 lines** and zero deletion, and is revertible in a commit. (iii) The strongest argument in option A's favour is not decluttering at all, it is that 782 lines of untested, unlocalised, security-sensitive send/upload code exist (§3a) — and M3 removes the untested *upload* half (170 + 45 lines) without removing the ability to reply. Testing `email_sender.py` is a smaller, more honest job than deleting it.

**The strongest argument against my view.** A product that can reply is a mail client, and a mail client is judged against Gmail. Keeping reply means keeping SMTP forever, and that means keeping 526 untested lines, 16 error stages, an unbuilt outbound retry queue (§2.8), a Sent folder that lies to every other client the user owns (§2.7), and 3 drafter models whose only output is text the user must send. Half-measures ship half a mail client: a user who can reply but not compose, who can answer but whose reply is invisible in Gmail's Sent, is worse off than a user who was told clearly "this app triages, answer in your mail app". M4's handoff is the only position where every one of those debts is retired at once, and the codebase already proves the pattern works (`src/api.py:1919-1932`). If the goal is a product that is *finishable* by one person, M4 is the coherent end state and my incrementalism just defers the decision by a year — with more data locked in the SQLite file by then, which makes the eventual migration harder, not easier.

**One correction to the brief's premises, for the record.** "Deleting SMTP config loses credentials the user typed" is not true here: SMTP reuses the IMAP keyring password (`src/email_sender.py:115-130`) and falls back to a per-provider preset when host is blank (`:72-113`). The credential risk in this decision is zero; the data risk is `drafts`, `outbox`, the local Sent copies, and `email_labels`.