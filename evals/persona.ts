/** The list every eval starts from, in a fake AniList. */
import { HISTORY, PERSONA } from "../test/fixtures/persona";
import { FakeAniList } from "../test/support/fake-anilist";

/** The fixture's airing schedule was captured on 2026-11-17; evals keep the clock there. */
export const NOW = Date.parse("2026-11-17T12:00:00Z");

export function personaFake(): FakeAniList {
  const fake = new FakeAniList("POINT_10_DECIMAL", "tester").seed(PERSONA).seedActivity(HISTORY);
  fake.clock = () => NOW;
  return fake;
}
