# humanish — for the times your AI needs to act humanish

**Date:** 2026-05-14
**One-liner:** A small box you log into once via a real browser embedded in a dashboard tab, that then exposes itself to your AI agents through one-time, two-word, self-destroying prompt links. The link primitive — slug, single-use, paste-the-markdown-into-chat, MacGyver pattern — is **claude-magic**, lifted nearly verbatim from the May 12 design. The addition is the front door: a Playwright login jail that lets you provision cookie-based credentials for services that don't have an API at all (NotebookLM, your personal X, your work Slack), one named profile at a time.

---

## 1. What this writeup is, and what it isn't

This is humanish, drafted on the back of claude-magic.

claude-magic — sketched and planned in the small hours of May 12, plan at `plans/2026-05-12-claude-magic.md`, draft skill markdown at `reports/claude-magic-skill-draft.md`, riding on the existing `brightdata-proxy` Worker at `~/Downloads/files/` with KV namespace `19f8ec98…` already provisioned — already solved the hardest half of the problem. *How do you let a chat-shaped AI* (claude.ai web, no Claude Code, no MCP connector, no shell access) *borrow a credential for one specific task, without leaving anything sensitive in the chat history?* Its answers are good enough to lift entirely. Two-word slugs from the EFF Long wordlist. Single-use. Self-destroying. The slug renders a paste-able skill markdown that the user copies into their own chat. The advisor/executor MacGyver pattern that makes pasted skills feel like a coherent product instead of a tool call.

What claude-magic assumed was that the credential at the bottom of the stack was a long-lived API token someone had already preloaded onto a Worker — specifically the Bright Data MCP token. The receiving chat got a fresh short-lived bearer that proxied to that token. Everything between "user pastes the skill markdown" and "Worker forwards the upstream call" was the work, and it is done.

humanish picks up where claude-magic ends and asks the question one rung up the ladder: *what if there isn't a long-lived API token at the bottom?* What if the credential we are trying to broker is a Google session, an X login, a Slack workspace cookie — something that only exists because a human pressed buttons in a real browser five minutes ago? The chat-side surface is the same. The slug mechanic is the same. The MacGyver pattern is the same. What changes is the credential-provisioning step: instead of an admin pasting a token into a Worker secret once a year, the user opens a browser tab and logs in.

That is the whole pitch. **humanish is claude-magic with a Playwright login jail bolted to its front.**

## 2. The flow, drawn correctly

This has to be drawn correctly, because one of the load-bearing findings from May 12 is that the obvious shape *does not work*.

The obvious shape: user gets a URL, Claude fetches it, Claude gets the instructions inside. Dead. claude-magic's Phase 0 research turned up that Claude Code routes all non-allowlisted WebFetch calls through a Haiku pre-summarizer with explicit anti-instruction prompting. Any instructions inside the fetched body are summarized away, not executed. The same constraint applies in spirit to claude.ai web. You cannot smuggle a skill into a chat by having the AI fetch a URL. The fetch will be defanged before the instructions ever land in the context window.

The shape that works: **a human is the courier.**

1. User opens `humanish.example/banana-saxophone` in their own browser tab.
2. The page renders a *skill markdown* — a paste-able instruction set for the receiving chat. The page includes a "copy" button and a preview of what the chat will receive.
3. User copies, switches to claude.ai, pastes into the chat as ordinary user input.
4. Claude treats it as a trusted skill — because the user authorized it by pasting it. Whatever the user types into the chat is, by definition, an instruction from the user. The chat now has a time-boxed superpower window (claude-magic targets four hours; humanish can be shorter or longer depending on the action) scoped to one specific verb.
5. The slug dies on first browser visit. Anyone who screenshots the URL, sees it over a shoulder, or finds it in browser history gets a 410 Gone.

The user is the integration. The user is the thing that crosses the security boundary, because the user is the only thing the chat is *built* to trust unconditionally. The slug doesn't have to outsmart Claude's anti-injection layer; it just has to render a page a human can copy from. Once the user pastes it into their own conversation, it is user input — and user input is, by design, treated as an instruction.

This is the part that took claude-magic two architecture revisions to nail. We should not rediscover it the hard way.

## 3. Two-word slugs, EFF Long wordlist, single-use

The slug format is two words from the EFF Long wordlist — the same family-friendly list that backs Diceware, ~7,776 words. Two words give roughly **60 million combinations**. With a short TTL and a single-use guarantee, that is plenty of entropy and plenty of legibility.

The aesthetic: `banana-saxophone`, `dusty-koala`, `polite-tiger`, `wobbly-pancake`. Easy to read aloud. Easy to type. Hard to brute-force. Memorable in a way a base64 token isn't. Most importantly, *legible to humans glancing at the URL bar* — a user knows what is about to happen because they can read the name of the thing.

The TTL is short: minutes, not hours. The slug is single-use: the first browser visit consumes it, dead-link table after that. The lifetime is "long enough to walk from one tab to another." Not long enough to leave on a sticky note. Not long enough to phish someone.

The link broker on the Worker side is straight claude-magic. The substrate already exists in the `brightdata-proxy` Worker. The delta from brightdata-proxy to claude-magic was small — drop the owner-key gate on `/code`, replace 32-hex-char tokens with two-word slugs, make `GET /<slug>` a browser-facing HTML page instead of a JSON `/redeem`, overlay the MacGyver section. The delta from claude-magic to humanish on *the link-broker side* is even smaller: add a profile selector. It's the credential-provisioning side that is new.

## 4. The MacGyver pattern goes with the skill, not the product

The MacGyver pattern is the part of claude-magic that makes a pasted skill feel like a coherent product instead of a one-shot tool call. It carries over to humanish unchanged, and it is part of the skill markdown by default — not an optional overlay.

The pasted skill markdown puts the receiving chat into two internal roles.

**Advisor.** Drafts a stateful plan before any execution. The plan is a markdown artifact with frontmatter (`id`, `question`, `params`, `tools_used`) and a body describing intent, dependencies, and a state block to be filled in. The plan is an artifact the user keeps, edits, reruns with different params, hands to a friend. It outlives the chat conversation.

**Executor.** Runs the plan step by step. Captures state in the state block as it goes. Doesn't make decisions the plan didn't anticipate. If the plan calls for one action invocation, the Executor invokes once and stops.

claude-magic introduces a hard mint-time gate I want to keep: the **two-input sanity test.** A freshly minted plan must be runnable twice with deliberately different parameter values, and the two runs must produce observably different output. If they don't, the plan's parameters are decorative — they are being silently ignored by the upstream — and the mint refuses to issue the slug. The gate exists because parameterized LLM-driven work has a quiet failure mode where the model "writes a plan" that strips its own inputs out, and the only honest test is "does feeding different inputs produce different outputs." This isn't BrightData-specific or NotebookLM-specific. It's a discipline for using LLMs to drive parameterized work at all, and every humanish action benefits from it.

## 5. What humanish actually contributes: the browser jail

This is the part that isn't claude-magic.

claude-magic works because there is already a long-lived API token sitting on a Worker. Someone, once, put it there. The proxy fans that one credential out across many short-lived slugs. Fine. But what happens when the credential at the bottom isn't an API token but a *browser session* — Google cookies for NotebookLM, X cookies for posting a tweet, Slack cookies for sending a message? You can't put cookies on a Worker. You can't refresh them programmatically. You can't get them without a human in a real browser doing the login dance. They are tied to a logged-in browser tab in a way an API token is not.

humanish's contribution is the front door for that.

A small dashboard with a single button: **log into a service.** Click it and a real Chromium pops up *inside your dashboard tab* via a WebRTC viewport — you see the browser and you drive it with your real mouse and keyboard, like a screen-share session with yourself. You navigate to whatever service. You log in normally. Passwords, MFA, captchas, the lot. When you're in, you click "save profile" and name it (`google-personal`, `founder-twitter`, `acme-internal`). The server snapshots the browser's `storage_state` into a named profile and tears the live tab down. The storage state is encrypted at rest with a key the dashboard never sees — only the action runner can decrypt it, only when it has a live request to do so.

Now the box is authenticated to that service. It can act *as you* against that service. The link broker — claude-magic, with a profile selector — mints slugs scoped to `(profile, action, payload-shape, ttl, max-calls=1)` against any of your named profiles. Everything downstream of the credential is claude-magic. The only new component is the browser jail and the named-profile abstraction.

## 6. Where claude-magic and humanish meet

Cleanest framing:

- **claude-magic** is "rent one specific superpower to your chat" — Bright Data scraping. One backend. One credential. Mint slugs against it.
- **humanish** is the same primitive, generalized. Many backends. Many credentials. The user provisions credentials by driving a real browser; the link broker is unchanged.

They probably *should* be the same product surface, with claude-magic as one of the actions humanish exposes. `claude-magic.lol/banana-saxophone` is a humanish mint with the Bright Data action pre-baked and the brand chosen for recognizability. `humanish.example/dusty-koala` is the same mint surface for any other action. The brand choice depends on positioning — "claude-magic" as the recognizable name for the most popular action, "humanish" as the platform behind it.

The MVP doesn't have to resolve that question. It can sit at `humanish.example` for the box itself and ship NotebookLM as its first action. claude-magic.lol can continue to exist as the Bright Data special case until someone decides to merge the surfaces. The architecture supports either choice.

## 7. How the server works under the hood

Three small services on one box.

**The browser jail.** Headful Playwright Chromium in an isolated user namespace, exposed via WebRTC to the dashboard. Captures `storage_state.json` per named profile. Encrypted at rest. Reauth (cookies expired, need to log in again) is one click and drives the same flow over the same machinery.

**The action runner.** Given `(profile, action_id, payload)`, spawns a fresh Playwright instance, restores the named profile's storage state, runs the action's script (a recorded macro, a typed Playwright script, or a known CLI like `notebooklm-py`), captures the result, returns it. One profile, one action, one ephemeral browser per call. Initial catalog: `notebooklm.generate-deck`, `x.post-thread`, `slack.send-message`, `youtube.pull-transcript`. Actions are tiny typed programs with declared input and output shapes. The catalog grows by user demand.

**The link broker.** The HTTP front door. Mints two-word slugs from the EFF Long wordlist. Renders the slug URL as an HTML page with the skill markdown ready to copy. Burns slugs on first browser visit. Hits the action runner on demand. Returns results inline in the chat via the bearer carried in the skill markdown. Authenticates dashboard traffic with Resend magic links (reused from wooow.now). Audit-logs every action. Dead-link table for already-used slugs.

The link broker is a Cloudflare Worker — `brightdata-proxy`, lightly modified, plus a profile selector and a few action routes. The browser jail and action runner are a long-running container the user controls. Two-tier, same shape as wooow's NotebookLM sidecar, same shape as humanctl's MVP, same shape we keep arriving at independently.

## 8. The MVP

Single user. One operator (you). One humanish box, accessible only from your dashboard.

The MVP ships *one* action: `notebooklm.generate-deck`. Why NotebookLM? Three reasons. The CLI exists (`notebooklm-py`). The auth flow is well understood (Playwright `storage_state.json`). The downstream consumer is ready and waiting — the wowerpoint → wooow.now pipeline currently asks the user's laptop to drive NotebookLM, which is the precise use case humanish exists to replace. Shipping NotebookLM first means a humanish slug immediately replaces the awkward "open a Claude Code session and run wowerpoint" dance with "paste this into claude.ai web and wait ninety seconds." That is a real product win on day one.

End-to-end demo target: a user signs up for humanish, logs into NotebookLM through the dashboard (one click, completes Google OAuth in the embedded tab), names the profile `google-personal`, generates a `banana-saxophone`-style share link with a magic prompt scoped to `notebooklm.generate-deck`, pastes the skill markdown into a fresh claude.ai chat, asks Claude "turn this paper into a kawaii deck," and ninety seconds later gets back a `https://wooow.now/<slug>` URL inside the same conversation. Zero shell. Zero Claude Code. Zero local setup. Zero MCP connector. The user did the login once in a real browser; everything after that flowed through a paste.

## 9. The cloud version, sketched

Multi-tenant humanish puts back every boundary the single-user MVP collapsed. Same conceptual move as humanctl: every auth feature you remove for the single-user MVP, you put back for multi-tenancy.

Each user gets a dedicated container, not a shared one — browser sessions are too sensitive to colocate. The container's `storage_state` files are encrypted with a per-user key derived from the user's login. The link broker fans out across users with per-tenant slug namespaces. The audit log becomes a billable feature (security teams will pay real money for "what did the agent do on my X account last week"). There is an enterprise SKU where the customer brings their own VPS and humanish becomes a control plane, not a host. Free tier: one profile, ten links a day, slugs expire in five minutes. Paid tier: five profiles, unlimited links, slugs configurable up to 24 hours, audit log retained for a year. Enterprise: audit log retained forever, SAML SSO into the dashboard, BYO VPS.

None of this matters in the MVP. The MVP is one box, one user, one service. The cloud version is the same architecture with the trust boundary moved out one level.

## 10. The risks, named honestly

A humanish server is a single-point-of-pwn for everything its operator has logged into. The link mechanism limits what *agents* can do; it does not limit what *attackers* can do once they're inside the box. The whole product lives or dies on "is this box more secure than the laptop you'd otherwise run these scripts on?" Honest answer for a self-hosted single-user box: probably yes if you do nothing terrible, definitely no if you forget about it for six months. For hosted multi-tenant: aggressively yes, and that is real engineering investment.

The Haiku-pre-summarizer finding is a permanent architectural constraint, not a temporary bug. The paste-the-markdown flow exists *because* Claude.ai web cannot be trusted to receive instructions through a URL fetch. If Anthropic ever loosens that gate — or if a new chat surface arrives that doesn't have it — humanish should still keep the paste flow as the default, because it's also the right user-experience choice (the user sees, in their own URL bar and their own clipboard, exactly what they are authorizing). The paste flow isn't a hack around the Haiku gate. It's the correct security posture independent of the gate.

Every upstream service has a TOS that probably prohibits cookie-based automated access. We are deliberately impersonating a logged-in browser. Most services do not care if a user does this for themselves; some have aggressive bot-protection that will flag datacenter IPs. Mitigation: residential proxy support per profile. The product has to be honestly framed as "use this on your own accounts, never on someone else's."

Cookies expire. There is no architecture that prevents this. The humanish UX has to make re-auth feel like one click — open the jail, navigate, log back in, click save — because users will be doing it forever.

And the dangerous part: humanish is structurally close to the thing every phishing kit wants to be. "Paste this `dusty-koala` link into your bank's customer-service chat for a refund" must not be a thing that works. The product needs hard guardrails on what services it can be plugged into — an allowlist of known-good upstreams, not "anything you can log into." That's unsatisfying at MVP time and it is the right constraint anyway.

## 11. The pitch in one sentence

**humanish is claude-magic generalized to cookie-jar credentials, with a Playwright login jail as the front door.** Users log into services once, in real browsers, on a box that exists to be authenticated. Agents borrow that authentication through two-word self-destroying links the user mints per task and *pastes* — never *fetches* — into any chat that accepts user input. The credentials never leave the box. The links never live past their use. The advisor/executor MacGyver pattern enforces stateful, parameterized, audit-able work inside the receiving chat. Your AI gets to be humanish for the length of one specific request, and only that request.

That's the product.
