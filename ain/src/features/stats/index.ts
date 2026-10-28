import { SLOTS, curve, curveArea } from "../../sdk/chart";
import { h, reducedMotion, svg, tween } from "../../sdk/dom";
import { choice } from "../../sdk/options";
import { definePlugin } from "../../sdk/plugin";
import type { Stats, StatsPort } from "./service";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const GLANCE_SLOTS = 12;
/** Numbers count to new values over most of the 1 s between samples. */
const TWEEN_MS = 900;
const GRAPH: readonly [number, number] = [300, 26];

export const fmtBytes = (n: number): string => {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) [n, i] = [n / 1024, i + 1];
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${UNITS[i]}`;
};

export type Level = "ok" | "warn" | "hot";
export const level = (p: number): Level => (p >= 0.85 ? "hot" : p >= 0.6 ? "warn" : "ok");

const meter = (label: string) => {
  const fill = h("i");
  const bar = h("div", { class: "bar" }, fill);
  const value = h("span", { class: "value" });
  const set = (p: number) => {
    bar.style.setProperty("--p", String(p));
    bar.dataset.level = level(p);
  };
  return { row: h("div", { class: "stat" }, h("span", { class: "eyebrow" }, label), bar, value), value, set };
};

export const stats = definePlugin({
  id: "stats",
  label: "Stats",
  description: "CPU, memory and network.",
  icon: `<path d="M2 12.5l3.5-4 3 2.5 5.5-7"/>`,
  slots: ["glance", "tab"],
  options: {
    show: {
      ...choice("On the pill", "cpu", [
        ["cpu", "CPU load"],
        ["memory", "Memory use"],
      ]),
      pill: true,
    },
  },
  sample: (o) => (o.show === "cpu" ? { text: "24%", spark: [12, 30, 18, 40, 24, 35, 20, 28, 22, 30, 26, 24] } : { text: "51%", progress: 0.51 }),
  setup({ stats: port }: { stats: StatsPort }, host) {
    let last: Stats | null = null;
    const cpuHistory: number[] = [];
    const cpu = meter("CPU");
    const ram = meter("RAM");
    const down = h("span");
    const up = h("span");
    // Download lines up with the bars, upload with the values column.
    const net = h("div", { class: "stat" }, h("span", { class: "eyebrow" }, "NET"), h("span", {}, "↓ ", down), h("span", { class: "value" }, "↑ ", up));
    const graph = svg(
      "0 0 300 26",
      `<defs><linearGradient id="cpu-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".45"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><g class="spark-g"><path class="spark-area" fill="url(#cpu-fill)"/><path class="spark-line"/></g>`,
      "spark",
    );
    graph.setAttribute("preserveAspectRatio", "none");

    const group = graph.querySelector("g");
    let drawnAt = 0;

    const draw = (s: Stats) => {
      cpu.set(s.cpu / 100);
      tween(cpu.value, s.cpu, (n) => `${Math.round(n)}%`, TWEEN_MS);
      const memP = s.memTotal ? s.memUsed / s.memTotal : 0;
      ram.set(memP);
      tween(ram.value, s.memUsed, (n) => `${fmtBytes(n)} / ${fmtBytes(s.memTotal)}`, TWEEN_MS);
      tween(down, s.rxPerSec, (n) => `${fmtBytes(n)}/s`, TWEEN_MS);
      tween(up, s.txPerSec, (n) => `${fmtBytes(n)}/s`, TWEEN_MS);
      if (s.sampledAt === drawnAt) return;
      drawnAt = s.sampledAt;
      const [w, hgt] = GRAPH;
      graph.querySelector(".spark-area")?.setAttribute("d", curveArea(cpuHistory, w, hgt));
      graph.querySelector(".spark-line")?.setAttribute("d", curve(cpuHistory, w, hgt));
      // Each sample shifts the curve one slot left: glide it there over the next second, like a ticker.
      if (!reducedMotion()) group?.animate([{ transform: `translateX(${w / (SLOTS - 1)}px)` }, { transform: "none" }], { duration: 1000, easing: "linear" });
    };

    return {
      panel: (root) => root.append(h("div", { class: "stats" }, cpu.row, ram.row, net, graph)),
      async tick({ visible }) {
        const s = await port.stats();
        if (s && s.sampledAt !== last?.sampledAt) {
          last = s;
          cpuHistory.push(s.cpu);
          if (cpuHistory.length > SLOTS) cpuHistory.shift();
        }
        if (visible && last) draw(last);
      },
      glance: () => {
        if (!last) return null;
        if (host.options().show === "cpu") return { text: `${Math.round(last.cpu)}%`, spark: cpuHistory.slice(-GLANCE_SLOTS) };
        const used = last.memTotal ? last.memUsed / last.memTotal : 0;
        return { text: `${Math.round(used * 100)}%`, progress: used };
      },
    };
  },
});
