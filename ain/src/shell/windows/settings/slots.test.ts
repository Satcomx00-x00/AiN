import { describe, expect, it } from "vitest";
import { move } from "./slots";

describe("move", () => {
  it("moves an item to a new index", () => expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]));
  it("keeps the index within the list", () => {
    expect(move(["a", "b", "c"], 2, 9)).toEqual(["a", "b", "c"]);
    expect(move(["a", "b", "c"], 1, -3)).toEqual(["b", "a", "c"]);
  });
  it("leaves the list as it was for an index that holds nothing", () => expect(move(["a"], 5, 0)).toEqual(["a"]));
  it("doesn't change the list it was given", () => {
    const ids = ["a", "b"];
    move(ids, 0, 1);
    expect(ids).toEqual(["a", "b"]);
  });
});
