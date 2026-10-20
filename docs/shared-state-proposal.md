# Proposal: shared team state via the GitHub repository

**Status:** proposal for discussion
**Audience:** the three solution architects who use the Gantt planner
**Date:** 2026-10-20

## 1. Summary

Today each of us has a private copy of the plan in our browser's `localStorage`, and we share it by pasting JSON at each other. This proposal moves the plan into the repository as **one JSON file per person** under `data/people/`, and teaches the app to **read and write those files directly through the GitHub Contents API** from the browser. Saving in the app becomes a commit on `main`; opening the app pulls everyone's latest commits.

What that gives us:

- **One shared view.** Open the app, see everyone's current work. No pasting.
- **No pull requests, no git commands.** Each save is a direct commit to `main` made by the app on your behalf.
- **Almost no conflicts.** Each person's tasks live in their own file, so our everyday edits never touch the same file. Where two people do edit the same file, the API detects it and the app resolves it.
- **History for free.** Every change is a commit with the author's name, so "who moved that date?" is answered by `git log`.
- **Five-minute setup per person.** Accept a repo invite, create a token, paste it into the app once.

The app and data will live in a **new private repository under Jonathan's own account on the company's GitHub Enterprise**, not in the public `jjdevine/Gantt` repo. The public copy stays exactly as it is until everyone has moved. [Section 7](#7-decisions-and-things-to-be-aware-of) lists what to confirm about the enterprise before building, and [section 8](#8-implementation-and-migration-plan) is the migration plan that keeps the current users undisturbed.

## 2. Where we are today

The whole app is a single `index.html` served from GitHub Pages (https://jjdevine.github.io/Gantt/) or opened from a clone.

- State is one JSON object `{ "tasks": [ ... ] }` held in the textarea and persisted to `localStorage` under the key `gantt_tasks_v1`.
- Every edit path ends by writing that key: "Save & Render", the quick add/edit modal, delete, and "Person import/export".
- "Person import/export" already models the data as **a set of tasks per person**, and import replaces one person's tasks wholesale. That is exactly the shape the shared model below uses, so the mental model does not change.
- Sharing today means Download JSON or Person export, send the text to a colleague, they Person import it. Everyone's copy drifts between exchanges and nobody knows which copy is newest.
- Two team members use the public Pages site daily. Nothing in this proposal touches that site until the cutover step in section 8, and even then only to add a banner.

## 3. Goals and non-goals

Goals:

1. The repository is the single source of truth for the plan.
2. Team members do not need git, a terminal, or pull requests to read or write the plan.
3. The app keeps working exactly as it does now for viewing, filtering, editing and exporting.
4. Concurrent edits by two people do not silently lose data.
5. Setup for a new team member takes minutes, not an afternoon.

Non-goals:

- Real-time collaborative editing. Refresh-on-open plus a periodic poll is plenty for a planning view that changes a few times a day.
- A backend. Nothing to host, nothing to pay for, nothing to keep patched.
- Changing the task schema. Existing fields stay as they are.

## 4. Recommended design

### 4.1 Data layout in the repository

```
data/
  people/
    jonathan.json
    alice.json
    bob.json
  README.md          # one paragraph: "edited by the app, hand-edit if you must"
index.html
docs/
```

Each file holds exactly what Person export produces today:

```json
{
  "tasks": [
    {
      "person": "jonathan",
      "task": "Payments platform target architecture",
      "workItemType": "Feature",
      "description": "",
      "start": "2026-10-06",
      "end": "",
      "durationWeeks": 6,
      "capacityImpact": "high",
      "utilisationPercent": 50,
      "complete": false,
      "milestones": { "HLD signed off": "2026-11-13" }
    }
  ]
}
```

Why one file per person rather than one `tasks.json`:

- **Conflict avoidance.** Git and the Contents API work at file granularity. If we all wrote `tasks.json`, every pair of saves within a few minutes of each other would conflict. With per-person files, the normal case (I edit my tasks, you edit yours) never conflicts.
- **It matches the app.** Person import/export is already "replace this person's task set". The file is that task set.
- **Readable diffs.** A commit touching `data/people/alice.json` is self-describing.

The file name is the lower-cased `person` value. On load, the app sets `person` on every task from the file name, exactly as Person import does, so the two can never disagree.

### 4.2 How the app reads

On page load, and again on a timer and when the tab regains focus, the app:

1. Lists `data/people/` with `GET /repos/{owner}/{repo}/contents/data/people?ref=main`. The response gives each file's name and blob `sha`.
2. Fetches each file with `GET /repos/{owner}/{repo}/contents/data/people/{name}.json?ref=main` and the `Accept: application/vnd.github.raw+json` header, sending `If-None-Match` with the ETag from last time. Unchanged files come back as `304` and do not count against the API rate limit.
3. Merges the per-person arrays into the single `{ tasks: [...] }` the rest of the app already consumes, sorts with the existing `sortTasksArray`, and renders.
4. Remembers the `sha` of each file. That sha is what makes writes safe (next section).

The app reads through the API rather than from the Pages site or `raw.githubusercontent.com` because those are cached for minutes after a push. The API is fresh.

### 4.3 How the app writes

Every code path that currently calls `localStorage.setItem(STORAGE_KEY, ...)` instead calls one function, `persist(data)`, which:

1. Splits `data.tasks` by person.
2. For each person whose task set differs from the last-loaded snapshot, issues
   `PUT /repos/{owner}/{repo}/contents/data/people/{person}.json` with body
   `{ "message": "Update tasks for alice", "content": "<base64 JSON>", "sha": "<last known sha>", "branch": "main" }`.
3. Stores the new `sha` from the response.
4. Updates the sync indicator in the toolbar.

That `PUT` is a commit on `main`, authored by whoever's token made the call. No clone, no branch, no PR. One save in the app equals one commit per changed person file.

Writes are **debounced by about two seconds** so that a burst of edits (adding three milestones, say) becomes one commit rather than three. A "Sync now" button forces an immediate write for the impatient.

Files are capped at 1 MB by the Contents API. A person's task list is a few kilobytes, so this is not a concern.

### 4.4 Concurrency and conflicts

The `sha` in the `PUT` is an optimistic lock. If someone else committed to the same file since we loaded it, GitHub refuses the write with `409 Conflict` and nothing is lost. The app then:

1. Re-fetches that one file.
2. If the conflict is in **someone else's file** (you edited one of Alice's tasks while Alice was also editing), shows a small dialog: *Alice updated her tasks while you were editing. Reload hers and re-apply my change / Keep mine and overwrite / Show both.* "Show both" drops the two JSON blobs into the existing textarea side by side so you can fix it by hand with tools you already have.
3. If the conflict is in **your own file**, which only happens if you have the app open in two places, same dialog.

Because the normal case is "I edit my file", this dialog should be a rare sight. Everything else in the app is unaffected.

The app also polls (every five minutes, and on tab focus) so that the view you are looking at is rarely more than a few minutes stale, which further shrinks the conflict window.

### 4.5 Authentication: a personal access token per person

Browsers cannot push to GitHub without credentials, and there is no backend to hold them. Each team member therefore creates a **fine-grained personal access token** scoped to this one repository with a single permission: *Contents: Read and write*. The app stores it in `localStorage` alongside the data it already keeps there, and sends it as `Authorization: Bearer <token>` on API calls.

Why this is acceptable:

- The token grants no access the person does not already have through the GitHub UI, and the collaborator role on the repository is what decides read versus write. A fine-grained token narrows this further to just this repo; see 7.2 for who can use which.
- The data the token protects is the same data already sitting unencrypted in `localStorage` today.
- Commits are attributed to the token's owner, so we get authorship without any extra UI.
- Revoking a token is one click on GitHub and takes effect immediately.

Because the repository is owned by a personal account, only its owner can create a fine-grained token for it. Everyone else uses a classic token with `repo` scope. Section 7.2 explains why that is fine.

Why not alternatives:

- **GitHub OAuth "Login with GitHub"** needs a server to exchange the code for a token. That is the backend we are avoiding.
- **Deploy keys / SSH** are not usable from a browser.

Tokens expire (fine-grained tokens allow up to a year). The app checks the expiry header on each response and shows a "token expires in 14 days" nudge in the toolbar, so renewal is a paste, not an outage.

### 4.6 UI changes

Small and additive. Nothing that exists today is removed.

- **An optional `config.js` beside `index.html`.** It sets the defaults: API base URL, repository owner and name, branch, data path. The enterprise copy ships with it filled in, so team members only ever type a token. If the file is absent, as it is in the public repo, the app has no repository configured and behaves exactly as it does today. This one file is what lets the same `index.html` be safe in both places during the transition.
- **Settings (gear icon) modal.** Shows the values from `config.js` (editable, in case the repo moves) plus the token. A *Test connection* button that lists the directory and reports *Connected as jonathan, 3 people found, write access*. Shown automatically on first visit if a repository is configured but no token is stored. A *Forget token* button for shared machines.
- **Sync indicator in the top bar.** One of: *Synced 10:32*, *Saving…*, *2 changes not yet saved*, *Offline, changes kept locally*, *Conflict, click to resolve*, *Read-only access*, *Not connected, click to set up*. Hidden entirely when no repository is configured, so the public copy looks unchanged.
- **Refresh button** next to the indicator, in addition to the automatic poll.
- **"Sync now"** next to Save & Render.
- **Everything else unchanged:** Download JSON, Export filtered, Person import/export, quick add, delete, the filters, and the textarea all keep working. Person import now writes that person's file to the repo, which is a handy bulk-edit path.

### 4.7 What `localStorage` becomes

It stops being the source of truth and becomes two things:

1. **A cache**, so the app paints instantly with the last-seen data before the API responds.
2. **An outbox.** If a write fails (no network, GitHub down, token expired) the change stays in `localStorage` flagged as unsaved, the indicator says so, and the app retries on the next successful connection. Nothing you typed is lost by closing the tab.

The existing `gantt_tasks_v1` key is read once on first run as a migration source (section 8) and then ignored.

## 5. What this looks like for a team member

### One-time setup (about five minutes)

1. Accept the collaborator invitation to the repository on the enterprise GitHub.
2. On the enterprise GitHub: *Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token.* Scope: `repo`. Expiry: the maximum allowed. Copy the token. (The repository owner can use a fine-grained token scoped to just this repo instead. See 7.2.)
3. Open the app. The Settings modal appears with the repository already filled in. Paste the token, click *Test connection*, see *Connected as alice, write access*. Done.

### Day to day

- Open the app (bookmark the Pages URL or the file in a clone). It shows everyone's plan as of right now.
- Edit as you do today. The indicator flicks to *Saving…* then *Synced*.
- Leave the tab open and it refreshes itself every few minutes and whenever you come back to it.
- If someone else's change collides with yours, a dialog asks what to do. Expect this roughly never.

No terminal, no git, no PRs, no "can you send me your JSON".

### If you prefer the command line

Nothing stops you. `data/people/you.json` is a plain file. Edit it, commit, push. The app picks it up on its next poll. The GitHub web editor works too, and is a reasonable fallback if your token has expired and you are in a hurry.

## 6. Why this is low friction and what it costs

| Concern | Answer |
|---|---|
| Infrastructure to run | None. Static page plus GitHub. |
| Per-user setup | One token paste. |
| Per-edit effort | Same as today. Save is a commit. |
| Visibility of others' changes | Within one poll interval, or instantly on refresh. |
| Risk of losing someone's data | Optimistic locking on every write. Local outbox on failure. |
| Audit trail | Full git history with real authors. |
| Rate limits | 5,000 API calls/hour per token. Three people polling every five minutes with conditional requests uses a few dozen. |
| Code change size | One new module of roughly 200 lines (list, get, put, conflict handling) plus the settings modal and indicator. The chart and task logic are untouched. |

## 7. Decisions and things to be aware of

### 7.1 Hosting: a personal repository on the company's GitHub Enterprise

The app and data move to a new private repository under Jonathan's own account on the enterprise GitHub. The engineering organisation's rulesets block direct commits to `main`, which would defeat the whole approach, and a personal repository has no such rules. It is private to the enterprise, and team members and stakeholders are invited as collaborators with Write or Read roles. This also settles the privacy question from the first draft: nothing here is public.

Four things to confirm on the enterprise before the code moves there. Each is a few minutes and all are part of phase C in section 8.

- **API base URL.** On github.com Enterprise Cloud it is `https://api.github.com`. On GitHub Enterprise Server it is `https://<host>/api/v3`. On Enterprise Cloud with data residency it is `https://api.<subdomain>.ghe.com`. Whichever it is goes into `config.js`.
- **CORS from the browser.** The GitHub REST API sends permissive CORS headers on all three flavours, but a corporate proxy in front of a self-hosted instance can strip them. Open the browser console on any page and run a `fetch` of `<api base>/user` with a token. If that fails with a CORS error, this approach needs a rethink, so test it on day one.
- **Which token types the enterprise allows.** Enterprise policies can restrict classic tokens, fine-grained tokens, or both. Check *Settings → Developer settings* shows the option to create a classic token with `repo` scope. If SAML SSO is enforced, a token may need to be authorised for SSO after creation. Personal repositories are usually outside that requirement, but the *Test connection* button will tell us.
- **GitHub Pages.** On Enterprise Server it exists only if the admin has enabled it. On Enterprise Cloud it is available and can be set to *private*, so only enterprise members with access to the repo can open the site. If Pages is not available, everyone opens `index.html` from a local clone instead. The app works identically from `file://` because the API allows requests from any origin and nothing in the page depends on being served from Pages.

### 7.2 Tokens on a personally owned repository

A fine-grained token can only be scoped to repositories whose owner is the token holder's own account or an organisation they belong to. So Jonathan can create a fine-grained token limited to this one repo, but team members and stakeholders cannot. They use a **classic token with `repo` scope** instead.

That is less precise than ideal but not a real exposure. The token authenticates; the **collaborator role on the repository authorises**. A stakeholder invited with Read access cannot write no matter what scope their token has, and a `repo` scope token gives a person no access they did not already have through the enterprise UI. The app should treat a `403` on `PUT` as *read-only access* and say so in the sync indicator, rather than showing an error. Stakeholders then get a live read-only view with the same setup as everyone else.

If the enterprise turns out to forbid classic tokens, the fallback is to ask for a small dedicated organisation for the team, which restores fine-grained tokens for everyone and can be created without the engineering organisation's rulesets. Only pursue that if the check in 7.1 forces it.

### 7.3 `main` must accept direct commits

Branch protection rules that require PRs or reviews would break the whole point. Leave `main` unprotected, or protect it only with rules that do not block direct pushes.

### 7.4 Pin the D3 dependency

`index.html` loads `https://d3js.org/d3.v7.min.js`, an unpinned script from a third-party host. Today that is a mild risk. Once the page holds a token that can write to our repo, a compromised or changed script could exfiltrate it. Vendor `d3.v7.min.js` into the repo (it is about 280 KB) and load it relatively. This is a two-line change and should be part of the same piece of work. It also removes a dependency on the corporate network allowing `d3js.org`, which an enterprise proxy may not.

### 7.5 Each data commit triggers a Pages rebuild

Harmless, but noisy in the Actions tab. If it bothers us, switch Pages to a workflow-based deploy with `paths-ignore: ['data/**']`. Not needed for v1.

### 7.6 Token hygiene

- Tokens live only in each person's browser. They are never committed.
- Shared or public machines: use *Settings → Forget token* before leaving. Add that button.
- Diarise the expiry date when you create the token. The in-app nudge helps, but a calendar reminder is cheaper.

## 8. Implementation and migration plan

The constraint: two people use the public Pages site every day and must not notice anything until they are deliberately moved. The plan below never changes the public site except for one banner at the very end, and nothing before that banner is irreversible.

The design decision that makes this easy is in 4.6: **with no `config.js` present, the app is the app we have today.** The storage layer becomes pluggable, and the `localStorage`-only adapter is the default. The public repo never gets a `config.js`, so even if the new `index.html` were copied there, nobody would see a difference. That gives one codebase, two deployments, no branching of features.

The work happens in three places, in order: a **private test repository on github.com** where the feature is built and proven with dummy data, then a **fresh repository on the enterprise GitHub** created from the finished code, and only then the real users move. The public `jjdevine/Gantt` repo is never developed in again.

### Phase A: create a test repository on github.com (half an hour, zero user impact)

1. Create a new **private** repository under your own github.com account, for example `gantt-shared`. Private is right because the data layout and token flow are being tested there, and private repos are free. Git history does not matter, so either push the current `main` to it or just copy `index.html` and `docs/` in and commit.
2. Create a fine-grained token for it. You own the repo, so the narrow token works for you here.
3. Decide how you will open the app during testing. Pages on a private personal repo needs GitHub Pro, so the default is to open `index.html` from your local clone over `file://`. That is a valid deployment, not a workaround, since the app talks to the API and nothing depends on the serving origin. If you would rather test the Pages experience, make the test repo public and keep the dummy data obviously fake.
4. Commit a `config.js` pointing at the test repo (`https://api.github.com`, your user, `gantt-shared`, `main`, `data/people`).

The public repo is untouched. Nobody's day changes.

### Phase B: build and test in the test repository (one to two days build, then as long as you like testing)

All development happens against the test repo. Commit straight to its `main` or use the Copilot branch-and-PR flow for code, whichever you prefer; it makes no difference to anyone else.

Build order, each step leaving the app working:

1. **Storage abstraction.** Introduce `load()` and `persist()` and route the four existing `localStorage.setItem(STORAGE_KEY, ...)` call sites and the one `getItem` through them. Behaviour identical to today. This is the step to be careful with; everything after it is additive.
2. **`config.js` and the Settings modal** with *Test connection*. During testing `config.js` points at the test repo; in phase D it is swapped for the enterprise values. Either way team members only ever enter a token.
3. **Read path** (4.2): list, fetch, ETag, merge, poll on timer and on focus. Sync indicator.
4. **Write path** (4.3, 4.4, 4.7): `PUT`, debounce, `409` handling with the conflict dialog, outbox for failed writes, `403` shown as read-only.
5. **Vendor D3** (7.4).
6. **Migration helper.** On first load with a token configured, if `gantt_tasks_v1` exists in this browser's `localStorage` and the repo has no file for that person yet, offer *Upload my local tasks*. Note that `localStorage` is per origin, so the enterprise site will not see data saved on the public site. The upload helper matters only for people who opened the app from a local clone. Everyone else migrates with Download and Person import in phase F.

**Automated check first.** `npm test` runs `test/harness.mjs`, which loads the page in jsdom against a mock of the Contents API and covers every item below except the real network and the real Pages origin. Run it after any change to `index.html`.

**Test plan in the test repo**, with two or three made-up people and dummy tasks:

- **Behaves like today with no config.** Delete `config.js`, open the page, confirm it is byte-for-byte the current app. Restore `config.js`. This is the guarantee that the public copy would be safe even if the new code reached it.
- **Round trip.** Add, edit, delete, Person-import. After each, confirm the commit appears on the test repo and the file content is what you expect. Reload and confirm the chart is rebuilt from the repo, not from `localStorage`.
- **Second viewer sees the change.** Open the app in a second browser profile or a private window with the same token. Edit in one, refresh the other.
- **Conflict.** In both windows load the same person, edit in window one and save, then edit in window two and save. Window two must get the conflict dialog, and whichever choice you make must leave the repo file valid and the other window able to continue.
- **Offline outbox.** Disconnect the network, make an edit, confirm the indicator shows it unsaved and the edit survives a tab close. Reconnect, confirm it syncs.
- **Bad token and read-only.** Paste a wrong token and confirm a clear message. If you want to test read-only, invite a second github.com account with Read access, or just temporarily use a fine-grained token with Contents: Read only.
- **Setup walkthrough.** Optionally invite one team member to the test repo now. They would use a classic `repo` scope token, because the repo is yours. Have them follow section 5 cold and time it. That is the dress rehearsal for the real cutover and the best way to find rough edges in the Settings modal.

### Phase C: enterprise checks, in parallel with phase B (half an hour)

The four checks in 7.1 need only a browser and a token on the enterprise GitHub, not a repository. Do them while phase B is in progress so that any surprise, especially a CORS failure, is known before the test repo work is finished: API base URL, CORS from the browser console, which token types members can create, and whether Pages is available and can be private.

### Phase D: create the enterprise repository from the finished code (an hour, zero user impact)

1. On the enterprise GitHub, create a new private repository under your own account. Leave it empty.
2. From the test repo clone, copy the files across without history. Either `git init` a fresh clone of the enterprise repo and copy `index.html`, `d3.v7.min.js`, `docs/`, and an empty `data/people/` directory in, or push the test repo's `main` if you decide history is useful after all. Both are fine.
3. Replace `config.js` with the enterprise values: the API base URL from phase C, your enterprise username, the new repo name, `main`, `data/people`. This is the only file that differs between the two copies. Commit and push.
4. Create your token on the enterprise (fine-grained, scoped to this repo), open the app, *Test connection*. If phase C was clean this just works.
5. Enable Pages if it is available, private if the option exists, and note the URL. Otherwise the team opens `index.html` from a local clone, which is the same experience you have been having in testing.
6. Invite the two team members as Write collaborators and any stakeholders as Read collaborators.

The test repo on github.com can be kept as a scratch environment for future changes or deleted. Nothing depends on it after this step.

### Phase E: dogfood alone on the enterprise copy (one to two weeks)

- Use the enterprise app as your daily tool, writing your own file with real data. The two team members keep using the public app and keep sending you their JSON as they do now. Person-import each snapshot into the enterprise app, which writes their files to the repo. By cutover the repo already holds everyone's current data and the write path has been exercised with real changes on the real host.
- Optionally bring one team member in a week early as a second writer on the enterprise copy, keeping the public app as their source of truth for that week.
- Give a stakeholder a Read invite and a token and confirm the read-only indicator behaves on the enterprise host.

### Phase F: cutover (one short session, everyone on the same day)

1. **Freeze.** Ask both team members to stop editing the public app for an hour.
2. **Seed.** Either you Person-import each person's final export into the enterprise app, or each person does it themselves: *Download JSON* on the public site, open the enterprise site, Settings, paste token, *Person import* their own tasks. The second route doubles as their setup walkthrough and takes five minutes.
3. **Verify.** All three open the enterprise app and see the same chart. Each person makes one trivial edit and the others see it after a refresh.
4. **Retire the public site.** Commit a one-line banner to the top of the public `index.html`: *This copy is retired. Use <enterprise URL>.* Leave the site serving, so old bookmarks land on the banner and *Download JSON* still works as a safety net. This is the only change the public repo ever receives.
5. **Two weeks later,** archive the public repository on github.com. Archiving makes it read-only and keeps Pages serving. Delete it after that if you want the data gone from the public internet.

### Rollback

Up to step F.4 nothing has happened to the public app, so rollback is "keep using it". After F.4 rollback is reverting one commit. If the enterprise checks in phase C fail, the work so far still lives in the test repo and nobody has moved.

### Phase G: optional polish, after the team has moved

Token-expiry nudge, Pages `paths-ignore` for data commits, a `data/README.md` explaining the layout, and the stakeholder tokenless view below.

**Stakeholder view without tokens.** If the enterprise offers private Pages, the Pages site serves `data/people/*.json` itself, protected by the viewer's GitHub session rather than a token. A read-only mode could fetch from there instead of the API, trading a few minutes of staleness for zero setup. Only worth doing if stakeholders turn out to be more than a couple of people.

## 9. Alternatives considered

**Local clone + File System Access API + a sync script.** The app writes `data/people/you.json` straight to disk via `showSaveFilePicker`, and a `sync.ps1` does `git pull --rebase && git commit -am && git push`. Works, needs no tokens, but every save still needs a terminal step and a git merge now and then, which is the friction we are trying to remove. Also Chromium-only. Kept as the "I prefer git" path in section 5, not as the main path.

**A single `data/tasks.json`.** Fewer files, but every near-simultaneous save conflicts and the conflict dialog becomes a daily event. Rejected.

**A secret GitHub Gist as the shared blob.** Simpler API, but it is not the repository, has no per-file locking for our purposes, and gives nobody any reason to look at the data's history. Rejected.

**GitHub OAuth device flow or a GitHub App.** Nicer login experience, but the token exchange needs a server or a serverless function. The moment we have a backend we have hosting, secrets and maintenance. Rejected for a three-person tool.

**Commit via a GitHub Action triggered by an Issue or `repository_dispatch`.** Still needs a token in the browser to trigger it, and adds a minute of latency plus a moving part. Rejected.

## Appendix A: the three API calls

List the people directory:

```http
GET https://api.github.com/repos/{owner}/{repo}/contents/data/people?ref=main
Authorization: Bearer <token>
Accept: application/vnd.github+json
```

Fetch one file (raw body, conditional):

```http
GET https://api.github.com/repos/{owner}/{repo}/contents/data/people/alice.json?ref=main
Authorization: Bearer <token>
Accept: application/vnd.github.raw+json
If-None-Match: "<etag from last fetch>"
```

Write one file (commit to `main`):

```http
PUT https://api.github.com/repos/{owner}/{repo}/contents/data/people/alice.json
Authorization: Bearer <token>
Accept: application/vnd.github+json
Content-Type: application/json

{
  "message": "Update tasks for alice",
  "content": "<base64 of the pretty-printed JSON>",
  "sha": "<blob sha from the last read>",
  "branch": "main"
}
```

A `200` or `201` returns the new blob `sha` in `content.sha`. A `409` means the file changed underneath us and we go through section 4.4.

## Appendix B: minimal `persist()` sketch

```js
async function persist(data){
  const byPerson = groupByPerson(data.tasks);          // Map<name, tasks[]>
  const writes = [];
  for (const [name, tasks] of byPerson){
    const body = JSON.stringify({ tasks }, null, 2);
    if (body === snapshot.get(name)?.body) continue;    // unchanged, skip
    writes.push(putFile(`data/people/${name}.json`, body, snapshot.get(name)?.sha)
      .then(res => snapshot.set(name, { body, sha: res.content.sha }))
      .catch(err => err.status === 409 ? resolveConflict(name, body) : queueOffline(name, body)));
  }
  await Promise.all(writes);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data, null, 2)); // cache only
  updateSyncIndicator();
}
```

`groupByPerson`, `putFile`, `resolveConflict` and `queueOffline` are each a dozen lines. The four existing `localStorage.setItem(STORAGE_KEY, pretty)` call sites become `persist(currentData)`.
