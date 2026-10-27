/** Finding a setting by any word of its name, its hint, where it lives or what else it's called. */
import { describe, expect, it } from "vitest";
import { MAX_RESULTS, type SearchEntry, search } from "./search";

const entries: SearchEntry[] = [
  { label: "Close delay", hint: "How long the island stays open", where: "General", target: "general", field: "Close delay" },
  { label: "Open delay", hint: "How long the pointer rests", where: "General", target: "general", field: "Open delay" },
  { label: "Launch at login", hint: "Starts AiN when you sign in", where: "General", target: "general", keywords: "autostart boot" },
  { label: "Model folder", hint: "Where the model is kept", where: "Widgets › Dictation", target: "widgets:dictation" },
  { label: "Délai", where: "Général", target: "general" },
];
const labels = (q: string) => search(q, entries).map((e) => e.label);

describe("searching settings", () => {
  it("finds nothing for nothing typed", () => {
    expect(labels("")).toEqual([]);
    expect(labels("   ")).toEqual([]);
  });

  it("puts names that start with the words first, then names holding them, then the rest", () => {
    expect(labels("open")).toEqual(["Open delay", "Close delay"]);
    expect(labels("delay")).toEqual(["Close delay", "Open delay"]);
  });

  it("needs every word, found in the name, hint, place or other words, whatever the case", () => {
    expect(labels("DICTATION folder")).toEqual(["Model folder"]);
    expect(labels("autostart")).toEqual(["Launch at login"]);
    expect(labels("open nothing")).toEqual([]);
  });

  it("ignores accents", () => {
    expect(labels("delai")).toEqual(["Délai"]);
  });

  it("stops at a screenful", () => {
    const many = Array.from({ length: MAX_RESULTS + 10 }, (_, i) => ({ label: `Item ${i}`, where: "X", target: "x" }));
    expect(search("item", many)).toHaveLength(MAX_RESULTS);
  });
});
