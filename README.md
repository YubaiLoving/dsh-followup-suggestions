**English** · [中文](README.zh.md)

# Follow-up Suggestions

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.1.7--rc.2-4D6BFE)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A DSH plugin that renders 1-3 follow-up suggestion chips directly under a session's **last completed reply**. The text is produced by **the model that session has selected**; a click fills the composer and puts your cursor in it, never sending anything. A small refresh icon next to the label asks for one fresh batch.

This repository carries the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic, which the DeepSeek Harness documentation requires of plugin repositories so they can be discovered; the link above is the inline, clickable form of that requirement.

```
assistant: The Luding Bridge assault happened in May 1935 …
[copy] [branch] …
Suggested ↻
┌──────────────────────────────┐ ┌──────────────────────────┐
│ Walk me through the assault  │ │ What is still debated?   │
└──────────────────────────────┘ └──────────────────────────┘
```

## What it does

- **Generates** on the Host: it reads the Session's logged request header (`session.requestHeader().config`) for the `provider/model` you picked in `/model` or the composer's model menu, and runs one **one-shot** `ctx.llm.stream()` call for 1-3 short lines.
- **Renders** into ui-chat's `conversation.chat.turnTail` seat on the Client, ordered with `order:1` so the row sits **below** the copy/branch action strip.
- **Only the last reply**: shown only when the Turn record is `status === "closed"` **and** it is the newest entry in `timeline.turnOrder`. Scrollback never requests or shows chips.
- **Click = fill the composer and enter the input state** through ui-conversation's `inputActions.setDraft()`, followed by a focus on the composer's contenteditable with the caret placed at the end of the text — so you can keep typing immediately. It never sends.
- **Refresh = one fresh batch**: the icon after the label asks the Host for this Turn's suggestions again, bypasses both caches on purpose, and replaces the chips on screen and the batch cached for that Turn. A refresh that fails or comes back empty changes nothing, so the chips you are reading stay. While it runs the icon spins, and the button is disabled.
- **Cached**: one completed Turn costs one model call. The Host remembers settled answers and shares calls already in flight; the browser stores answers per Turn in `localStorage`, so a reload, a view switch, or a second tab shows the same chips with **no request at all** — until you press refresh.
- **Silent on failure**: a gone Session, a Session with no logged route, a model error, a dead network, or an empty answer all render nothing; empty answers and failures are deliberately **not cached**, so the next visit retries.
- **No session pollution**: the call writes nothing to the Session log, never enters model history, and never affects the KV cache.

## Install

**Option 1 — plugin manager**

```
plugin_manager install_bundle target="github:YubaiLoving/dsh-followup-suggestions"
```

**Option 2 — manual**

The package directory must live under the profile's `node_modules`, with one Loader entry at the end of `cordis.patch.yml` (one row mounts **both** halves):

```
~/.dsh/profiles/desktop/node_modules/dsh-followup-suggestions/
```

```yaml
- insert:
    - id: followup-suggestions
      name: 'dsh-followup-suggestions'
```

DSH re-applies the patch layer in place: the **browser half needs a page refresh**, while the **Host half only picks up code changes after a DSH restart** (loaded modules are cached in the process). Changing the entry's `config`, however, **reloads the plugin immediately** (verified: setting `maxItems: 1` made the very next request return one chip). The refresh button is exempt from the restart rule: it also carries a cache-missing synthetic sequence, so pressing it regenerates for real even while the Host is still the older build that ignores `refresh`.

## Configuration (optional)

Add a `config` block to the entry in `cordis.patch.yml`:

```yaml
- id: followup-suggestions
  name: 'dsh-followup-suggestions'
  config:
    maxItems: 3           # 1-3; anything higher is clamped to 3
    maxTokens: 320        # output cap, not a target — unused budget costs nothing
    timeoutMs: 30000      # per-call timeout
    maxContextChars: 1200 # retained tail per context side
    reasoningEffort: off  # lowest effort; null / inherit follows the session route default
```

Every field may be omitted. `config` changes take effect immediately (the plugin reloads; no restart).

## How it works

| Concern | Detail |
| --- | --- |
| Model choice | Routing comes entirely from the Session's own request header — the plugin has **no** model setting of its own, so switching models with `/model` switches the suggestions too |
| Context | `session.deriveMessages()`: the last user text plus the last assistant text, each trimmed to 1200 characters of tail |
| Call | `ctx.llm.stream({ provider, model, maxTokens, reasoningEffort, sessionId, messages, signal })` with an `AbortSignal.timeout` guard; `BlockAssembler` collects the stream |
| Transport | Host registers `POST /api/dsh-followup-suggest` through `ctx.connection.fetch.register()`; the Client uses a same-origin `fetch` |
| Placement | `ctx.slots.inject("conversation.chat.turnTail", …)`. The seat's outlet wrapper is `display:contents`, so this row is a sibling of the action strip and `order:1` puts it below (if that container ever stops being a flex column the declaration is ignored and the row falls back above the strip) |
| Effort | The lowest effort is requested with a `maxTokens` cap. A route that does not know the effort answers `UNSUPPORTED_REASONING_EFFORT`; the call is then repeated without it and that route is remembered as effortless |
| "Newest" test | The Turn seat has no "am I latest" prop, so the standard `useChat()` seat reads `timeline.turnOrder`; when that seat is missing the row stays hidden |
| Cache key | `Session + Turn + closing final node seq`. The closing sequence makes entries self-invalidating: a retry, a branch, or a later Turn all move it |
| Host cache | Settled-answer map (256 entries / 24h) plus an in-flight promise map, so two concurrent requests for one key share a single model call. Empty answers and failures are never stored. A request carrying `refresh: true` skips both shortcuts, calls the model again, and replaces the settled answer for the key it was handed |
| Browser cache | In-page map, then `localStorage: dsh.followupSuggestions.v1` (40 entries / 7 days). The first render reads it through a lazy initializer, so a reload paints the chips with the reply. Only a refresh rewrites an entry |
| Click focus | `inputActions` exposes no focus verb (only `setDraft`/`insertText`/`submit`/attachments), so the composer is resolved by `[data-conversation-content][data-conversation-session="…"] [data-composer-input]` and focused directly, with an explicit caret at the end — a bare DOM focus would land at the start, because ui-conversation restores the caret through Lexical's own `focus()`. Both attributes belong to ui-conversation; if they are renamed the lookup misses and a click only writes the draft |
| Refresh transport | The refresh request carries `refresh: true` *and* a synthetic closing sequence (`seq + REFRESH_SEQ_STEP × n`). A current Host reads the flag; a Host build already loaded before the flag existed ignores it, and the synthetic sequence is what makes its settled-answer key a miss without a restart |
| Stylesheet | Injected once per document, and **rewritten when this build's rules differ** from the tag already in the page. A plugin reload (HMR or re-mount) does not reload the document, so without that comparison a changed size or gap would never reach the page until a hard refresh |
| Dependencies | Host: `@deepseek-ai/dsh-llm`; Client: `react` only |

## Performance

There are two costs: the **model call** (the only significant one) and **rendering**. Measured locally, on real sessions with a real model:

| Scenario | Before | After |
| --- | --- | --- |
| Repeated request for one Turn (Host cache hit) | ~1.5–2.4 s, unstable text | **~5 ms**, identical text |
| Reload / switch away and back | One model call each time | **0 calls** (painted with the reply) |
| First load (a call is unavoidable) | ~2 s of nothing, then a pop-in | Three **placeholder pills** immediately, replaced when the answer lands |
| Two tabs asking at the same instant | Two model calls | **One** (shared in-flight promise) |

On the lowest reasoning effort: an interleaved A/B (2×5 calls per arm against the same live Host, toggling the entry's `config`) found **no measurable latency difference** — median 1413 ms inherited vs 1495 ms `off`, inside the noise, because first-token time from the provider dominates. It is kept for reliability: the answer is very short, so a route that inherits a high effort spends the output budget thinking and can truncate below three lines when `maxTokens` is small (4 of 10 calls in the inherited arm returned fewer than three chips; the `off` arm returned three 10 times out of 10). Per-call latency is unchanged; what this plugin optimizes is **repeated work** and **perceived latency**.

## Known limitations

- **Only the last reply of the session you are viewing**: intentional (fewer calls, no noise), not precomputed per session.
- **Two DOM/seat contracts**: a Turn record carrying `status`/`turn`, and `useChat().timeline.turnOrder`. If ui-chat changes either, `lib/client.js` needs the matching update.
- **Depends on ui-conversation's `inputActions` and composer DOM**: without that seat the chips still render but clicking does nothing; if `data-conversation-content`/`data-conversation-session`/`data-composer-input` are renamed, a click still fills the draft but no longer moves the keyboard.
- **Cached chips live 7 days by default**: one Turn's suggestions stay stable that long, and the refresh icon is the way to ask for a new batch. Clearing `dsh.followupSuggestions.v1` from `localStorage` does the same thing by hand.
- **A refresh costs one model call**: by design — it is the only action that bypasses both caches.
- **The Host cache is process memory**: nothing is written to disk and it empties on restart.
- **Host-side code changes need a restart**: loaded modules are cached in the process (entry `config` changes are the exception — those reload immediately, and the refresh button still works because its request misses the old Host's cache key by construction).
- **No session pollution**: suggestions live only in browser `localStorage` and Host memory, never in the Session log, so they never appear in an export.

## Test

```
node test/smoke.mjs
```

No DSH runtime required: a stub module loader drives `lib/index.js` (real `Request`/`Response`, stub `ctx.llm`), and a minimal hook runtime mounts the component `lib/client.js` registers. 99 assertions cover route registration and path, the model route coming from the session header, list-marker and quote stripping, over-long line dropping, the item cap, empty results for failures/routeless/unknown sessions, live Turns rendering nothing and requesting nothing, older Turns rendering nothing, the placeholder-then-chips flow on the newest Turn, click-only-fills-the-draft plus the composer focus and end-of-draft caret, silent Host failure, a missing seat not crashing, and the injected stylesheet being rewritten when the build's rules change while an identical one is left alone; prompt and budget behavior, including the default lowest effort, `null` inheritance, the single no-effort retry per route, and the context bound; caching, including Host cache hits, one model call for concurrent identical requests, self-invalidation on a new sequence, failures not being cached, the Host refresh flag bypassing the settled answer and replacing it (with a non-boolean flag left alone), the synthetic sequence missing the answer on a Host that has no flag at all without disturbing the real key, plus the browser side's persistent hit, write-back, no-request remount, re-request on a new sequence, empty answers staying uncached, the refresh button's place in the label row, its disabled/busy states, the one request it issues with the flag and a cache-missing sequence, the batch it replaces in both tiers, and an empty or failed refresh leaving the shown chips and the cached batch untouched.

## License

[MIT](LICENSE) © 2026 YubaiLoving
