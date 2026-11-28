<img src="assets/icon.svg" width="64" height="64" alt="AniConnect AniList MCP server icon">

# AniConnect: AniList MCP Server

AniConnect is an AniList MCP server: it connects Claude (or any MCP client) to your [AniList](https://anilist.co) anime list, and your manga list too. Ask it to add shows, search your list, rate things, and track episodes (or chapters), by name.

Every tool that changes your list takes the show the way you'd say it: "jjk", "the second season of Spy x Family", "frieran", "進撃の巨人", or its anilist.co link. AniConnect works out which AniList entry you mean: episode updates go to the season you're watching (or, with several seasons planned, the next one after those you finished), ratings to the one you finished, and new shows start at season 1. When a name could really mean two shows (the two Hunter x Hunter series, say), it changes nothing and asks. In clients that can show forms (MCP elicitation), you pick from the matches in a dialog, and removing a show asks you to confirm there; elsewhere, the first `remove_from_list` call only shows the entry, and a second call with `confirmed: true` removes it. Moving a completed show back to watching waits for its ID when the name only matched it allowing for a typo.

To start, add `https://aniconnect-production.up.railway.app/mcp` to your MCP client as a remote connector and sign in with AniList: see [Connect](#connect).

## Tools

| Tool | What it does |
|---|---|
| `search_anime` | Search all of AniList by title, or browse it by season, year or a range of years, genre, tag ("isekai", "iyashikei"), format, airing status and episode count, leaving out genres or tags you name or shows already on your list ("best-rated isekai from 2023 I haven't added"), sorted by popularity, score or newest, a page at a time. Also lists what airs today, tomorrow or this week, with air times in your time zone, and what AniList users recommend after a show ("something like Frieren"), leaving out what you've completed or dropped. Shows IDs, AniList scores, whether each show is already on your list, and which ones continue a show you've completed. |
| `search_my_list` | Search your own list by title words and/or status (watching, planning, completed, ...), your score ("what did I give a 9 or more?", "what haven't I rated?"), format ("which movies have I seen?") or release year, with your private notes on each show. Sorts by title, your score ("my top-rated shows"), finish or start date, episodes watched, AniList's score or length ("the shortest thing on my plan to watch"), and pages through long lists 50 at a time (up to 200). With `favorites`, lists your AniList favorites in your profile's order ("what are my favorite anime?"). |
| `watch_history` | What you watched and when, from your AniList activity feed: "what did I watch this week?", "what did I finish in March?", "when did I finish Frieren?". Times are in your time zone. Reads up to 150 updates, or up to 300 when a list import fills the feed with plan-to-watch adds, which read as one line; for what you finished, it also uses the finish dates on your list, so "what did I finish this year?" is one call. |
| `add_to_list` | Add a show, as "plan to watch" unless you pick another status. Never overwrites an existing entry. |
| `set_status` | Move a show to watching, completed, paused, dropped, planning, or rewatching. |
| `rate_anime` | Rate a show out of 10 (decimals OK, 0 clears). AniList shows it in your own scoring format (stars, /100, ...). |
| `set_favorite` | Add a show to your AniList favorites (the ones on your profile), or take it out ("take Mob Psycho out of my favorites"). It leaves your list alone, and asking twice never flips it back. |
| `mark_episodes_watched` | Count up from where you are ("I watched the next two episodes"). |
| `set_progress` | Set an exact episode count ("I'm on episode 7"), or catch up to the latest aired episode ("I'm caught up on Dandadan"). |
| `update_shows` | Several changes in one call: several shows ("watched eps 3–5 of JJK and the Dandadan finale") or several things about one ("finished Frieren, 9/10"). Each update can set the status, episodes, episodes watched since last time, score, start and finish dates ("I actually finished it last March"), and your private notes on a show (replaced, or added to). Shows it can't resolve are listed with the reason, and the rest are saved. For imports, `addOnly` adds only shows that aren't on your list yet and never touches the ones that are, and `dryRun` shows what each name matches (up to 50 at a time) before anything is saved. |
| `remove_from_list` | Delete a show from your list, once confirmed. |
| `undo` | Take back the last change, or the last few, exactly: a removed show comes back with its progress, score, dates and notes, a show just added is removed again, and a favorite goes back the way it was. |
| `whats_next` | What to watch next: aired episodes you haven't seen and how long they take, when the next ones air, shows on hold with episodes left, and the next season or sequel movie of shows you've finished. On a long list each section lists the first few (what just aired, then the shows closest to done) and says how many more it has; `all` lists every show. Or ask about one show ("what's Frieren about?", "when's the next Apothecary Diaries episode?", "where can I watch Frieren?"), which also gives a short spoiler-free synopsis, its genres, studio, source material and main tags, and where it streams. |

**Manga.** The list tools (`add_to_list`, `set_status`, `rate_anime`, `set_favorite`, `mark_episodes_watched`, `set_progress`, `update_shows`, `remove_from_list`, `undo`, and `search_my_list`) work on your manga list too: *"I read chapter 74 of Chainsaw Man"*, *"I'm on volume 5 of Berserk"*, *"what manga am I reading?"*. The assistant passes `type: "manga"`, or chapters and volumes in place of episodes, when you talk about a manga; otherwise a name means the anime, unless only your manga list has it, in which case AniConnect asks which one you mean instead of adding the anime. Reaching the last chapter completes a manga, as the last episode does a show. AniList counts a manga's chapters only once it has finished, so for one still running, give the chapter number rather than "I'm caught up". Searching all of AniList, `watch_history` and `whats_next` are for anime only so far.

Project goals and requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

Episode tracking keeps your status in sync: watching an episode of something planned, paused or dropped moves it to watching and sets the start date, finishing the last episode marks it completed with today's date, and setting a completed show back to an earlier episode moves it back to watching. Changing the status directly follows the same date rules. Dates that are already set are never overwritten. Shows that are still airing and have no known episode count never auto-complete. Starting a rewatch resets the episode count to 0; finishing it keeps the original finish date and adds one to AniList's rewatch count. Progress past the episodes that have aired is saved, with a note saying how many have aired. Today's date is the one in your AniList time zone; the tools that fill in dates also take a `timeZone`, which wins when the assistant passes one.

## Connect

The quickest way in is the public AniConnect server. Add this URL to your MCP client as a remote (custom) connector and sign in with your AniList account when it asks:

```
https://aniconnect-production.up.railway.app/mcp
```

There's no token to copy and nothing to install. AniConnect first asks you to approve the app, then sends you to AniList to sign in; the sign-in lasts a year. It's one server shared by everyone who uses it, so AniList's limit of 30 requests a minute is shared too: when it's busy, a tool may say to wait a few seconds. What the server keeps, and for how long, is under [Privacy](#privacy).

**Claude** (claude.ai, Claude Desktop and the mobile apps): open **Customize > Connectors**, click **+ Add**, then **Add custom connector**. Name it AniConnect, paste the URL, and click **Continue**. If Claude asks how to identify itself (**OAuth client**), choose **Register automatically**. Click **Add**, then **Connect** to sign in. A connector added on the web or in Claude Desktop works in the mobile apps too. Free plans can have one custom connector.

**Claude Code:**

```sh
claude mcp add --transport http --scope user aniconnect https://aniconnect-production.up.railway.app/mcp
```

Then sign in from `/mcp` in a session, or with `claude mcp login aniconnect`.

**ChatGPT** (on the web; changing your list needs a Business, Enterprise or Edu plan, since on Pro custom MCP servers are read-only): go to **Plugins**, click **+**, then **Add custom MCP server**. Name it AniConnect, enter the URL as the **Server URL**, choose **OAuth** for authentication, accept the risk warning and click **Create as a plugin**. Then install the plugin, start a new chat, type `@` in the message box and pick AniConnect.

**Cursor:** add it to `~/.cursor/mcp.json`, and Cursor asks you to sign in:

```json
{
  "mcpServers": {
    "aniconnect": { "url": "https://aniconnect-production.up.railway.app/mcp" }
  }
}
```

**VS Code** (GitHub Copilot): run **Chat: Open Customizations**, select **MCP Servers**, then **Add Server** (+) in the User group. Choose **HTTP**, enter the URL and the ID `aniconnect`, and sign in when VS Code asks. Or from a terminal:

```sh
code --add-mcp '{"name":"aniconnect","type":"http","url":"https://aniconnect-production.up.railway.app/mcp"}'
```

Other clients that support remote MCP servers with OAuth sign-in take the same URL. The steps above for clients other than Claude follow those clients' own docs; they haven't been tried with AniConnect yet.

Then try: *"Add Frieren to my plan-to-watch list"*, *"What am I currently watching?"*, *"I just watched episode 5 of Dandadan"*, *"Rate Attack on Titan a 9"*.

## Run it locally

AniConnect can also run on your own computer, talking to your MCP client over stdio with an AniList token you make yourself. Nothing goes through the public server, and your requests have AniList's limit to themselves.

### 1. Get an AniList token

1. Go to [anilist.co/settings/developer](https://anilist.co/settings/developer) and click **Create New Client**.
2. Name it anything (e.g. "AniConnect") and set the **Redirect URL** to `https://anilist.co/api/v2/oauth/pin`. Save.
3. Open this link, with your new client's ID in place of `YOUR_CLIENT_ID`:

   ```
   https://anilist.co/api/v2/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=token
   ```

4. Click **Authorize** and copy the token it shows you. It's valid for one year. In the last two weeks, tool results include a one-line reminder with the expiry date; repeat these steps to get a new one.

Treat the token like a password: it can edit your list.

### 2. Add it to your MCP client

AniConnect isn't published to npm yet, so run it from source. Don't use `npx aniconnect` until this section says it's published: a package by that name today wouldn't be this project.

### From source

You need [Bun](https://bun.sh).

```sh
git clone https://github.com/wwelden/AniConnect.git
cd AniConnect
bun install
```

Then use `bun /absolute/path/to/AniConnect/src/index.ts` as the command:

```sh
claude mcp add aniconnect --scope user --env ANILIST_TOKEN=your-token -- bun /absolute/path/to/AniConnect/src/index.ts
```

## Hosting

AniConnect can also run as a remote server that people add by URL, signing in with their AniList account instead of pasting a token. This is the setup for claude.ai (on the web and on mobile) and for any client that supports remote MCP servers with OAuth.

1. On [anilist.co/settings/developer](https://anilist.co/settings/developer), create a client whose **Redirect URL** is `https://your-host/oauth/callback`. Note its ID and secret.
2. Run the server where it can be reached over https:

   ```sh
   PUBLIC_URL=https://your-host \
   ANILIST_CLIENT_ID=12345 \
   ANILIST_CLIENT_SECRET=... \
   AUTH_SECRET="$(openssl rand -base64 32)" \
   bun run serve          # listens on $PORT, default 3000
   ```

3. In claude.ai, open Settings, Connectors, **Add custom connector**, and enter `https://your-host/mcp`. AniConnect asks you to approve the app, then sends you to AniList to sign in, and the tools work from then on. Claude Code: `claude mcp add --transport http aniconnect https://your-host/mcp`, then `/mcp` to sign in.

| Setting | What it is |
|---|---|
| `PUBLIC_URL` | The https address the server is reached at (http only for localhost). |
| `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` | The AniList client from step 1. |
| `AUTH_SECRET` | 32 or more random characters. AniConnect keeps no database: it seals sign-ins with this. Changing it signs everyone out, unless you keep the old one in `AUTH_SECRET_PREVIOUS`. |
| `AUTH_SECRET_PREVIOUS` | Optional. The secret `AUTH_SECRET` replaced: sign-ins sealed with it keep working, and nothing new is sealed with it. Sign-ins last a year, so remove it only when you're ready to sign out whoever hasn't signed in since. Each MCP client's registration is sealed too and isn't renewed by signing in again: once this is removed, a client registered before the change is refused at its next sign-in (`unknown client_id`) until it registers again, which in some clients means removing the connector and adding it back. If the old secret leaked, leave this unset: then changing `AUTH_SECRET` signs everyone out, which is what you want. |
| `CLIENT_IP_HEADER` | Optional. The header your proxy sets to the client's address, used to throttle sign-ins per address; default `X-Real-IP`, which Railway sets. For a list such as `X-Forwarded-For`, the last address is used. A request without the header counts under the connection's own address. |
| `REVOKED_USERS` | Optional. AniList user IDs, separated by commas, whose access is revoked: their sign-ins stop working and they can't sign in again. Restart the server after changing it. |
| `PORT` | Port to listen on (default 3000). |

A sign-in lasts as long as the AniList token behind it, a year; then the client asks the user to sign in again. If you revoke AniConnect on AniList, the client asks you to sign in again. To cut off one user without signing everyone out, add their AniList user ID to `REVOKED_USERS` and restart. To find the ID of user NAME: `curl -s https://graphql.anilist.co -H 'Content-Type: application/json' -d '{"query":"{User(name:\"NAME\"){id}}"}'`. Taking a user off the list makes their old sign-ins work again; if one of those may have leaked, the user should also revoke AniConnect on AniList. A user's conversations share one undo history, until they've been idle for an hour, even across apps: signed in from both claude.ai and Claude Code, they can undo in one what they changed in the other. AniList's limit of 30 requests a minute applies per server IP, so it is shared by everyone using one server. The server keeps all users under it together, in the order their requests arrive, except that while another user has a request in the last minute, one user can hold at most half the minute's requests, so one user's import can't hold up everyone else (a user alone has the whole limit): a request waits up to 30 seconds for a free slot, and a tool call's waits all end within 40 seconds of it starting; a request that would wait longer isn't sent, and the tool says how long to wait instead. When AniList does answer "too many requests", every user's requests wait out the pause it asks for. For a user with no time zone in their AniList settings, the server can't tell their date: unless the assistant passes `timeZone`, it fills in today's date in UTC and says so, and accepts a date up to a day ahead of UTC. Air times and activity days are shown in UTC then, with a note saying so whenever an answer has one.

The sign-in endpoints are cheap: they keep nothing but the IDs of finished sign-ins and used codes, which expire within 10 minutes. The one costly step is the request each finished sign-in makes to AniList to swap its code for a token, which counts against the server IP's AniList limit; since anyone can start a sign-in, each client address gets 10 of those a minute (see `CLIENT_IP_HEADER`). A sign-in over that gets a page saying how long to wait, and reloading it then finishes the sign-in. The other endpoints have no rate limit; if you ever see abuse, put Cloudflare (or another proxy with rate limiting) in front.

`GET /health` answers `{"status":"ok", ...}` with the version, uptime, the number of open sessions and signed-in users, and the shared AniList limit: the limit, requests in the last minute, how long a 429 still pauses requests, and since the start, requests turned away with a wait and 429s from AniList. It holds no user data, isn't cached and never calls AniList.

### On Railway

Connect the repo to a Railway service, then in the service's settings:

- **Start command**: `bun run serve`. Railway would otherwise run the `start` script, which is the local server and needs `ANILIST_TOKEN`.
- **Healthcheck path**: `/health`.
- **Replicas**: 1. Sessions, undo history and the order of writes to each show are kept in memory, so a second copy wouldn't see the first one's.
- **Variables**: the settings above (`PORT` is set by Railway), plus `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`. On a redeploy AniConnect waits up to 20 seconds for requests in progress, such as a list change, before it exits; Railway's draining time has to be longer, or it stops the server first.
- Turn on **Wait for CI**, so only commits that pass the tests are deployed, and leave PR environments off.

`packageManager` in package.json pins the Bun version Railway builds with. A redeploy keeps everyone signed in, since sign-ins are sealed with `AUTH_SECRET`, but clears undo history and the cached lists: undo then covers only changes made since the restart.

### Privacy

AniConnect keeps no database and writes nothing to disk. Once you've signed in, the only lasting copy of your AniList token is inside the access token AniConnect gives your MCP client, encrypted with the server's `AUTH_SECRET` so that only the server can read it. While you use it, the server keeps your token, your AniList settings, a copy of your list (reused for up to a minute before it's fetched again) and your undo history in memory, and drops them once you've been idle for an hour (it checks every ten minutes) or when it restarts. It reads or changes your list only when a tool call asks it to, sends tool results only to the MCP client that asked, and makes list changes, including undos, only through AniList. It doesn't log your list reads or writes: it logs its address when it starts and, when a request fails unexpectedly, the method, path and error message, never the request or its results. Its `/health` page shows only totals across all users. To throttle sign-ins it keeps, for a minute, when each address finished one. To cut off access, revoke AniConnect in your AniList settings. Run locally, AniConnect talks only to your MCP client and to AniList, with the token you give it in `ANILIST_TOKEN`.

## Notes

- Undo covers changes AniConnect made since it started (the last 50), not ones made on anilist.co. A show changed elsewhere after AniConnect changed it is left alone. AniList's activity feed keeps its posts about an undone change.
- AniList allows 30 requests a minute (90 when its API isn't degraded; AniConnect follows the limit AniList reports). A request waits up to 30 seconds for room under the limit, and a tool call's waits all end within 40 seconds; past that, the tool says how long to wait instead. A read that fails on AniList's side (a 5xx or a dropped connection) is tried once more a second later; a change never is, since it may have been saved.
- Titles come back in the language you picked on AniList (Settings, Anime & Manga, Title Language): English, romaji or native. You can still name shows in any language. When a name could mean more than one show, the choices also list a second title.
- A tool call usually makes 1–4 AniList requests, including season lookups such as "the new season of My Hero Academia".
- AniConnect reuses your list for up to a minute between tool calls, so a burst of requests doesn't refetch it each time. Its own changes show up immediately; changes you make on anilist.co (or through another app) can take up to a minute to appear in what it reads. A change to a show reads that show again first when the list is more than 5 seconds old (one more request; one for all the shows in an `update_shows` call), so it never counts up from, overwrites or records for undo a value that changed elsewhere.
- Ratings are always given out of 10. AniList converts the score to your profile's format (stars, smileys, /100, ...), and the tool replies with the score as AniList shows it.
- Adult (18+) titles are left out of AniList-wide search and name matching unless 18+ content is turned on in your [AniList settings](https://anilist.co/settings). Shows already on your list, and shows you pick by AniList ID, always work. When a name matches only adult titles, the tool says so instead of reporting that the show doesn't exist.

## Development

```sh
bun test           # unit, resolver and tool tests against a fake AniList (no network)
bun run typecheck
bun run build      # dist/index.js, the stdio server the npm package runs under Node
bun run smoke:package   # packs the npm package, installs it in an empty directory and runs it under Node
```

Tests run against a fake AniList (`test/support/fake-anilist.ts`) holding `test/fixtures/media.json`, a snapshot of real AniList data for franchises that are hard to resolve by name. Refresh it with `bun run snapshot`. The fake runs every request against AniList's own GraphQL schema (`test/fixtures/anilist.graphql`, refreshed with `bun run snapshot:schema`), so a query AniList would reject fails the tests too, and other AniList servers' queries work against it as well. Fields it has no data for come back null.

### Evals

`bun run eval` sends each request in [evals/cases.ts](evals/cases.ts) to a real model through the `claude` CLI, with only AniConnect attached (backed by the fake AniList), and grades the list it leaves behind. Each case is one model run, so it uses your Claude usage (or API credits if `ANTHROPIC_API_KEY` is set).

```sh
bun run eval -- --filter progress   # just the episode-progress cases
bun run eval -- --model sonnet --concurrency 2
```

To compare, run the same cases against another AniList MCP server: `--server ani-mcp` or `--server anilist-mcp` (pinned versions, fetched with `npx`; see [evals/servers.ts](evals/servers.ts)). Their AniList requests go to the same fake, through a preload that redirects `graphql.anilist.co`. A read-only case then only needs some tool call, since their tools have other names. The summary lists fields a server asked for that the fake has no data for (descriptions, cover images, ...); those come back empty. `bun evals/probe.ts --server ani-mcp` starts a server against the fake without a model, to list its tools or call one.

## License

[MIT](LICENSE)
