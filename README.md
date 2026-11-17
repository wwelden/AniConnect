<img src="assets/icon.svg" width="64" height="64" alt="">

# AniConnect

An MCP server for your [AniList](https://anilist.co) anime list. Ask Claude (or any MCP client) to add shows, search your list, rate things, and track episodes, by name.

Every tool that changes your list takes the show the way you'd say it: "jjk", "the second season of Spy x Family", "frieran", or "進撃の巨人". AniConnect works out which AniList entry you mean: episode updates go to the season you're watching, ratings to the one you finished, and new shows start at season 1. When a name could really mean two shows (the two Hunter x Hunter series, say), it changes nothing and asks.

## Tools

| Tool | What it does |
|---|---|
| `search_anime` | Search all of AniList by title. Shows IDs and whether each show is already on your list. |
| `search_my_list` | Search your own list by title words and/or status (watching, planning, completed, ...). |
| `add_to_list` | Add a show, as "plan to watch" unless you pick another status. Never overwrites an existing entry. |
| `set_status` | Move a show to watching, completed, paused, dropped, planning, or rewatching. |
| `rate_anime` | Rate a show out of 10 (decimals OK, 0 clears). AniList shows it in your own scoring format (stars, /100, ...). |
| `mark_episodes_watched` | Count up from where you are ("I watched the next two episodes"). |
| `set_progress` | Set an exact episode count ("I'm on episode 7"). |
| `remove_from_list` | Delete a show from your list. |
| `whats_next` | What to watch next: aired episodes you haven't seen, when the next ones air, shows on hold with episodes left, and the next season of shows you've finished. Or ask about one show ("when's the next Apothecary Diaries episode?"). |

Project goals and requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

Episode tracking keeps your status in sync: watching an episode of something planned, paused or dropped moves it to watching and sets the start date, and finishing the last episode marks it completed with today's date. Shows that are still airing and have no known episode count never auto-complete.

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
git clone git@github.com:wwelden/aniconnect.git
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

## Notes

- AniList allows about 90 requests a minute. If you hit the limit, the tool says how long to wait instead of retrying.
- Titles come back in the language you picked on AniList (Settings, Anime & Manga, Title Language): English, romaji or native. You can still name shows in any language. When a name could mean more than one show, the choices also list a second title.
- A tool call usually makes 2–4 AniList requests, including season lookups such as "the new season of My Hero Academia".
- Ratings are always given out of 10. AniList converts the score to your profile's format (stars, smileys, /100, ...), and the tool replies with the score as AniList shows it.

## Development

```sh
bun test           # unit, resolver and tool tests against a fake AniList (no network)
bun run typecheck
```

Tests run against `test/fixtures/media.json`, a snapshot of real AniList data for franchises that are hard to resolve by name. Refresh it with `bun run snapshot`.

### Evals

`bun run eval` sends each request in [evals/cases.ts](evals/cases.ts) to a real model through the `claude` CLI, with only AniConnect attached (backed by the fake AniList), and grades the list it leaves behind. Each case is one model run, so it uses your Claude usage (or API credits if `ANTHROPIC_API_KEY` is set).

```sh
bun run eval -- --filter progress   # just the episode-progress cases
bun run eval -- --model sonnet --concurrency 2
```
