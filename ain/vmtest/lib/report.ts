import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type Status = "PASS" | "FAIL" | "LOOK" | "ERROR";

export interface Check {
  readonly file: string;
  readonly id: string;
  readonly what: string;
  readonly status: Status;
  readonly detail?: string;
  /** For LOOK: the screenshot to judge it on. */
  readonly shot?: string;
}

export interface TargetResult {
  readonly target: string;
  readonly ip?: string;
  /** Set when the target couldn't get as far as the tests: VM, delivery or build. */
  readonly error?: string;
  readonly checks: readonly Check[];
  readonly seconds: number;
}

/** A result line from a test (see guest/lib.sh), or undefined for any other output. */
export function parseLine(file: string, line: string): Check | undefined {
  const m = /^(PASS|FAIL|LOOK) (\S+) (.*)$/.exec(line);
  if (!m) return undefined;
  const [, status, id, rest] = m as unknown as [string, Status, string, string];
  if (status === "FAIL") {
    const f = /^(.*?) \((.*)\)$/.exec(rest);
    return f ? { file, id, what: f[1]!, status, detail: f[2]! } : { file, id, what: rest, status };
  }
  if (status === "LOOK") {
    const l = /^(.*?) \[(.*)\]$/.exec(rest);
    return l ? { file, id, what: l[1]!, status, shot: l[2]! } : { file, id, what: rest, status };
  }
  return { file, id, what: rest, status };
}

const ICON: Record<Status, string> = { PASS: "✅", FAIL: "❌", LOOK: "👀", ERROR: "💥" };

export function failed(results: readonly TargetResult[]): boolean {
  return results.some((r) => r.error || r.checks.some((c) => c.status === "FAIL" || c.status === "ERROR"));
}

/** summary.md, junit.xml and results.json in `dir`; returns the summary's text. */
export function writeReports(dir: string, title: string, results: readonly TargetResult[]): string {
  const ids: { id: string; what: string }[] = [];
  for (const r of results) for (const c of r.checks) if (!ids.some((i) => i.id === c.id)) ids.push({ id: c.id, what: c.what });

  const md: string[] = [`# VM tests: ${title}`, ""];
  md.push(`| | ${results.map((r) => r.target).join(" | ")} |`, `|---|${results.map(() => ":---:").join("|")}|`);
  for (const { id, what } of ids) {
    const cells = results.map((r) => {
      const c = r.checks.find((c) => c.id === id);
      return c ? ICON[c.status] : r.error ? ICON.ERROR : "–";
    });
    md.push(`| \`${id}\` ${what} | ${cells.join(" | ")} |`);
  }
  md.push("", `| | ${results.map((r) => r.target).join(" | ")} |`, `|---|${results.map(() => ":---:").join("|")}|`);
  md.push(`| passed | ${results.map((r) => `${r.checks.filter((c) => c.status === "PASS").length}/${r.checks.length}`).join(" | ")} |`);
  md.push(`| time | ${results.map((r) => `${Math.round(r.seconds)} s`).join(" | ")} |`);

  const problems = results.flatMap((r) => [
    ...(r.error ? [`- **${r.target}**: ${r.error.split("\n")[0]} (see \`${r.target}/run.log\`)`] : []),
    ...r.checks.filter((c) => c.status === "FAIL" || c.status === "ERROR").map((c) => `- **${r.target}** \`${c.id}\` ${c.what}: ${c.detail ?? ""}`),
  ]);
  if (problems.length) md.push("", "## Failures", "", ...problems);
  const looks = results.flatMap((r) => r.checks.filter((c) => c.status === "LOOK").map((c) => `- **${r.target}** \`${c.id}\` ${c.what}: \`${r.target}/shots/${c.shot}.png\``));
  if (looks.length) md.push("", "## To check on the screenshots", "", ...looks);
  const text = md.join("\n") + "\n";
  writeFileSync(join(dir, "summary.md"), text);

  const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]!);
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="${esc(title)}">`];
  for (const r of results) {
    const fails = r.checks.filter((c) => c.status === "FAIL").length + (r.error ? 1 : 0);
    xml.push(`  <testsuite name="${r.target}" tests="${r.checks.length + (r.error ? 1 : 0)}" failures="${fails}" time="${r.seconds.toFixed(1)}">`);
    if (r.error) xml.push(`    <testcase name="setup" classname="${r.target}"><error message="${esc(r.error.split("\n")[0]!)}">${esc(r.error)}</error></testcase>`);
    for (const c of r.checks) {
      const name = `${r.target}.${c.file.replace(/\.sh$/, "")}`;
      xml.push(`    <testcase name="${esc(`${c.id} ${c.what}`)}" classname="${esc(name)}">`);
      if (c.status === "FAIL") xml.push(`      <failure message="${esc(c.detail ?? "")}"/>`);
      if (c.status === "LOOK") xml.push(`      <skipped message="${esc(`check ${r.target}/shots/${c.shot}.png`)}"/>`);
      xml.push("    </testcase>");
    }
    xml.push("  </testsuite>");
  }
  xml.push("</testsuites>", "");
  writeFileSync(join(dir, "junit.xml"), xml.join("\n"));
  writeFileSync(join(dir, "results.json"), JSON.stringify({ title, results }, null, 2));
  return text;
}
