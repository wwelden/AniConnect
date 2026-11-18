<img src="assets/icon.svg" width="64" height="64" alt="AniConnect AniList MCP server icon">

# AniConnect: AniList MCP Server

AniConnect is an AniList MCP server: it connects Claude (or any MCP client) to your [AniList](https://anilist.co) anime list. Ask it to add shows, search your list, rate things, and track episodes, by name.

Every tool that changes your list takes the show the way you'd say it: "jjk", "the second season of Spy x Family", "frieran", or "進撃の巨人". AniConnect works out which AniList entry you mean: episode updates go to the season you're watching, ratings to the one you finished, and new shows start at season 1. When a name could really mean two shows (the two Hunter x Hunter series, say), it changes nothing and asks. In clients that can show forms (MCP elicitation), you pick from the matches in a dialog, and removing a show asks you to confirm there.

## Tools

| Tool | What it does |
|---|---|
| `search_anime` | Search all of AniList by title, or browse it by season, year, genre, format and airing status ("what's airing this season?", "best-rated romance from 2023"), sorted by popularity, score or newest. Shows IDs, whether each show is already on your list, and which ones continue a show you've completed. |
| `search_my_list` | Search your own list by title words and/or status (watching, planning, completed, ...), with your private notes on each show. |
| `watch_history` | What you watched and when, from your AniList activity feed: "what did I watch this week?", "what did I finish in March?", "when did I finish Frieren?". Times are in your time zone. Reads up to 150 updates; for what you finished, it also uses the finish dates on your list, so "what did I finish this year?" is one call. |
| `add_to_list` | Add a show, as "plan to watch" unless you pick another status. Never overwrites an existing entry. |
| `set_status` | Move a show to watching, completed, paused, dropped, planning, or rewatching. |
| `rate_anime` | Rate a show out of 10 (decimals OK, 0 clears). AniList shows it in your own scoring format (stars, /100, ...). |
| `mark_episodes_watched` | Count up from where you are ("I watched the next two episodes"). |
| `set_progress` | Set an exact episode count ("I'm on episode 7"), or catch up to the latest aired episode ("I'm caught up on Dandadan"). |
| `update_shows` | Several changes in one call: several shows ("watched eps 3–5 of JJK and the Dandadan finale") or several things about one ("finished Frieren, 9/10"). Each update can set the status, episodes, episodes watched since last time, score, start and finish dates ("I actually finished it last March"), and your private notes on a show (replaced, or added to). Shows it can't resolve are listed with the reason, and the rest are saved. For imports, `addOnly` adds only shows that aren't on your list yet and never touches the ones that are, and `dryRun` shows what each name matches (up to 50 at a time) before anything is saved. |
| `remove_from_list` | Delete a show from your list. |
| `undo` | Take back the last change, or the last few, exactly: a removed show comes back with its progress, score, dates and notes, and a show just added is removed again. |
| `whats_next` | What to watch next: aired episodes you haven't seen and how long they take, when the next ones air, shows on hold with episodes left, and the next season or sequel movie of shows you've finished. Or ask about one show ("what's Frieren about?", "when's the next Apothecary Diaries episode?", "where can I watch Frieren?"), which also gives a short spoiler-free synopsis, its genres, studio, source material and main tags, and where it streams. |

Project goals and requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

Episode tracking keeps your status in sync: watching an episode of something planned, paused or dropped moves it to watching and sets the start date, finishing the last episode marks it completed with today's date, and setting a completed show back to an earlier episode moves it back to watching. Changing the status directly follows the same date rules. Dates that are already set are never overwritten. Shows that are still airing and have no known episode count never auto-complete. Starting a rewatch resets the episode count to 0; finishing it keeps the original finish date and adds one to AniList's rewatch count. Progress past the episodes that have aired is saved, with a note saying how many have aired. Today's date is the one in your AniList time zone; the tools that fill in dates also take a `timeZone`, which wins when the assistant passes one.

## Setup

You need [Bun](https://bun.sh) and an AniList account.

### 1. Get an AniList token

1. Go to [anilist.co/settings/developer](https://anilist.co/settings/developer) and click **Create New Client**.
2. Name it anything (e.g. "AniConnect") and set the **Redirect URL** to `https://anilist.co/api/v2/oauth/pin`. Save.
3. Open this link, with your new client's ID in place of `YOUR_CLIENT_ID`:

   ```
   https://anilist.co/api/v2/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=token
   ```

4. Click **Authorize** and copy the token it shows you. It's valid for one year. In the last two weeks, tool results include a one-line reminder with the expiry date; repeat these steps to get a new one.

Treat the token like a password: it can edit your list.

### 2. Install

```sh
git clone https://github.com/wwelden/aniconnect.git
cd aniconnect
bun install
```

### 3. Add it to your MCP client

**Claude Code:**

```sh
claude mcp add aniconnect -s user -e ANILIST_TOKEN=your-token -- bun /absolute/path/to/aniconnect/src/index.ts
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aniconnect": {
      "command": "bun",
      "args": ["/absolute/path/to/aniconnect/src/index.ts"],
      "env": { "ANILIST_TOKEN": "your-token" }
    }
  }
}
```

Then try: *"Add Frieren to my plan-to-watch list"*, *"What am I currently watching?"*, *"I just watched episode 5 of Dandadan"*, *"Rate Attack on Titan a 9"*.

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
| `AUTH_SECRET` | 32 or more random characters. AniConnect keeps no database: it seals sign-ins with this. Changing it signs everyone out. |
| `PORT` | Port to listen on (default 3000). |

A sign-in lasts as long as the AniList token behind it, a year; then the client asks the user to sign in again. If you revoke AniConnect on AniList, the client asks you to sign in again. A user's conversations share one undo history, until they've been idle for an hour. AniList's limit of 30 requests a minute applies per server IP, so it is shared by everyone using one server. For a user with no time zone in their AniList settings, the server can't tell their date: unless the assistant passes `timeZone`, it fills in today's date in UTC and says so, and accepts a date up to a day ahead of UTC.

## Notes

- Undo covers changes AniConnect made since it started (the last 50), not ones made on anilist.co. A show changed elsewhere after AniConnect changed it is left alone. AniList's activity feed keeps its posts about an undone change.
- AniList allows 30 requests a minute. If you hit the limit, the tool says how long to wait instead of retrying.
- Titles come back in the language you picked on AniList (Settings, Anime & Manga, Title Language): English, romaji or native. You can still name shows in any language. When a name could mean more than one show, the choices also list a second title.
- A tool call usually makes 1–4 AniList requests, including season lookups such as "the new season of My Hero Academia".
- AniConnect reuses your list for up to a minute between tool calls, so a burst of requests doesn't refetch it each time. Its own changes show up immediately; changes you make on anilist.co (or through another app) can take up to a minute to appear.
- Ratings are always given out of 10. AniList converts the score to your profile's format (stars, smileys, /100, ...), and the tool replies with the score as AniList shows it.
- Adult (18+) titles are left out of AniList-wide search and name matching unless 18+ content is turned on in your [AniList settings](https://anilist.co/settings). Shows already on your list, and shows you pick by AniList ID, always work. When a name matches only adult titles, the tool says so instead of reporting that the show doesn't exist.

## Development

```sh
bun test           # unit, resolver and tool tests against a fake AniList (no network)
bun run typecheck
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
