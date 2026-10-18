import { describe, expect, it } from "vitest";
import { color, number, numberProblem, resolve, secret, text, textProblem, unset } from "./options";

describe("text rules", () => {
  const key = text("API host", "", { required: true, pattern: "[a-z0-9.-]+", invalid: "a host name", maxLength: 12 });

  it("says what's wrong with typed text, and nothing once it fits", () => {
    expect(textProblem(key, "")).toBe("Required.");
    expect(textProblem(key, "Not A Host")).toBe("Expected a host name.");
    expect(textProblem(key, "a-very-long.host")).toBe("At most 12 characters.");
    expect(textProblem(key, "api.test")).toBeNull();
    expect(textProblem(text("Free"), "")).toBeNull();
    expect(textProblem({ pattern: "\\d+" }, "12a")).toBe("Doesn't have the expected format.");
  });

  it("matches the whole value, not a part of it", () => {
    expect(textProblem({ pattern: "\\d{3}" }, "1234")).not.toBeNull();
    expect(textProblem({ pattern: "a|b" }, "ab")).not.toBeNull();
  });

  it("keeps the older text(label, value, placeholder, hint) form", () => {
    expect(text("City", "Paris", "e.g. Lyon", "Where you are")).toEqual({ kind: "text", label: "City", default: "Paris", placeholder: "e.g. Lyon", hint: "Where you are" });
  });
});

describe("number rules", () => {
  const port = number("Port", 8080, { min: 1, max: 65535, box: true });

  it("wants a number in range, on a step", () => {
    expect(numberProblem(port, Number.NaN)).toBe("Type a number.");
    expect(numberProblem(port, 70000)).toBe("Between 1 and 65535.");
    expect(numberProblem(number("Every", 10, { min: 5, max: 60, step: 5, unit: "s" }), 12)).toBe("In steps of 5 s.");
    expect(numberProblem(port, 443)).toBeNull();
  });
});

describe("resolving stored values", () => {
  const fields = {
    city: text("City", "Paris", { pattern: "[A-Za-z ]+" }),
    token: secret("Token", { required: true }),
    tint: color("Tint", "#FF8800"),
  };

  it("never takes a secret from the settings, and only takes text and colors that fit", () => {
    expect(resolve(fields, { city: "Lyon", token: "leaked", tint: "#00AAFF" })).toEqual({ city: "Lyon", token: "", tint: "#00aaff" });
    expect(resolve(fields, { city: "L1on", tint: "blue" })).toEqual({ city: "Paris", token: "", tint: "#ff8800" });
    expect(resolve(fields, { city: "" }).city).toBe("");
  });

  it("lists the required fields left empty, secrets by whether one is saved", () => {
    const required = { ...fields, city: text("City", "", { required: true }) };
    expect(unset(required, {}, () => false)).toEqual(["City", "Token"]);
    expect(unset(required, { city: "Lyon" }, (key) => key === "token")).toEqual([]);
  });
});
