import { isLight } from "../sdk/color";

/** A color theme for the island: its background, text, accent and the colors that carry meaning. */
export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
  /** Success, healthy load. */
  readonly ok: string;
  /** Warnings, medium load. */
  readonly warn: string;
  /** Errors, recording, high load. */
  readonly hot: string;
  /** A finished timer. */
  readonly done: string;
}

const t = (id: string, name: string, bg: string, fg: string, accent: string, ok: string, warn: string, hot: string, done: string): Theme => ({
  id,
  name,
  bg,
  fg,
  accent,
  ok,
  warn,
  hot,
  done,
});

/** Built-in themes, after the editor themes they're named for. The first is the default. */
export const THEMES: readonly Theme[] = [
  t("island", "Island", "#000000", "#f5f5f7", "#0a84ff", "#30d158", "#ffd60a", "#ff453a", "#ff9f0a"),
  t("monokai", "Monokai", "#272822", "#f8f8f2", "#66d9ef", "#a6e22e", "#e6db74", "#f92672", "#fd971f"),
  t("monokai-pro", "Monokai Pro", "#2d2a2e", "#fcfcfa", "#78dce8", "#a9dc76", "#ffd866", "#ff6188", "#fc9867"),
  t("tokyo-night", "Tokyo Night", "#1a1b26", "#c0caf5", "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#ff9e64"),
  t("tokyo-night-storm", "Tokyo Night Storm", "#24283b", "#c0caf5", "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#ff9e64"),
  t("tokyo-night-moon", "Tokyo Night Moon", "#222436", "#c8d3f5", "#82aaff", "#c3e88d", "#ffc777", "#ff757f", "#ff966c"),
  t("tokyo-night-day", "Tokyo Night Day", "#e1e2e7", "#3760bf", "#2e7de9", "#587539", "#8c6c3e", "#f52a65", "#b15c00"),
  t("dracula", "Dracula", "#282a36", "#f8f8f2", "#bd93f9", "#50fa7b", "#f1fa8c", "#ff5555", "#ffb86c"),
  t("nord", "Nord", "#2e3440", "#eceff4", "#88c0d0", "#a3be8c", "#ebcb8b", "#bf616a", "#d08770"),
  t("gruvbox-dark", "Gruvbox Dark", "#282828", "#ebdbb2", "#83a598", "#b8bb26", "#fabd2f", "#fb4934", "#fe8019"),
  t("gruvbox-light", "Gruvbox Light", "#fbf1c7", "#3c3836", "#076678", "#79740e", "#b57614", "#9d0006", "#af3a03"),
  t("solarized-dark", "Solarized Dark", "#002b36", "#93a1a1", "#268bd2", "#859900", "#b58900", "#dc322f", "#cb4b16"),
  t("solarized-light", "Solarized Light", "#fdf6e3", "#586e75", "#268bd2", "#859900", "#b58900", "#dc322f", "#cb4b16"),
  t("one-dark", "One Dark", "#282c34", "#abb2bf", "#61afef", "#98c379", "#e5c07b", "#e06c75", "#d19a66"),
  t("one-light", "One Light", "#fafafa", "#383a42", "#4078f2", "#50a14f", "#c18401", "#e45649", "#986801"),
  t("catppuccin-latte", "Catppuccin Latte", "#eff1f5", "#4c4f69", "#8839ef", "#40a02b", "#df8e1d", "#d20f39", "#fe640b"),
  t("catppuccin-frappe", "Catppuccin Frappé", "#303446", "#c6d0f5", "#ca9ee6", "#a6d189", "#e5c890", "#e78284", "#ef9f76"),
  t("catppuccin-macchiato", "Catppuccin Macchiato", "#24273a", "#cad3f5", "#c6a0f6", "#a6da95", "#eed49f", "#ed8796", "#f5a97f"),
  t("catppuccin-mocha", "Catppuccin Mocha", "#1e1e2e", "#cdd6f4", "#cba6f7", "#a6e3a1", "#f9e2af", "#f38ba8", "#fab387"),
  t("rose-pine", "Rosé Pine", "#191724", "#e0def4", "#c4a7e7", "#9ccfd8", "#f6c177", "#eb6f92", "#ebbcba"),
  t("rose-pine-moon", "Rosé Pine Moon", "#232136", "#e0def4", "#c4a7e7", "#9ccfd8", "#f6c177", "#eb6f92", "#ea9a97"),
  t("rose-pine-dawn", "Rosé Pine Dawn", "#faf4ed", "#575279", "#907aa9", "#56949f", "#ea9d34", "#b4637a", "#d7827e"),
  t("everforest-dark", "Everforest Dark", "#2d353b", "#d3c6aa", "#7fbbb3", "#a7c080", "#dbbc7f", "#e67e80", "#e69875"),
  t("everforest-light", "Everforest Light", "#fdf6e3", "#5c6a72", "#3a94c5", "#8da101", "#dfa000", "#f85552", "#f57d26"),
  t("kanagawa-wave", "Kanagawa Wave", "#1f1f28", "#dcd7ba", "#7e9cd8", "#98bb6c", "#e6c384", "#ff5d62", "#ffa066"),
  t("kanagawa-dragon", "Kanagawa Dragon", "#181616", "#c5c9c5", "#8ba4b0", "#87a987", "#c4b28a", "#c4746e", "#b6927b"),
  t("kanagawa-lotus", "Kanagawa Lotus", "#f2ecbc", "#545464", "#4d699b", "#6f894e", "#77713f", "#c84053", "#cc6d00"),
  t("ayu-dark", "Ayu Dark", "#0d1017", "#bfbdb6", "#e6b450", "#aad94c", "#ffb454", "#d95757", "#ff8f40"),
  t("ayu-mirage", "Ayu Mirage", "#1f2430", "#cccac2", "#ffcc66", "#d5ff80", "#ffd173", "#f28779", "#ffad66"),
  t("ayu-light", "Ayu Light", "#fcfcfc", "#5c6166", "#ffaa33", "#86b300", "#f2ae49", "#f07171", "#fa8d3e"),
  t("github-dark", "GitHub Dark", "#0d1117", "#e6edf3", "#2f81f7", "#3fb950", "#d29922", "#f85149", "#db6d28"),
  t("github-dark-dimmed", "GitHub Dark Dimmed", "#22272e", "#adbac7", "#539bf5", "#57ab5a", "#c69026", "#e5534b", "#cc6b2c"),
  t("github-light", "GitHub Light", "#ffffff", "#1f2328", "#0969da", "#1a7f37", "#9a6700", "#d1242f", "#bc4c00"),
  t("vscode-dark", "VS Code Dark+", "#1e1e1e", "#d4d4d4", "#007acc", "#4ec9b0", "#dcdcaa", "#f44747", "#ce9178"),
  t("darcula", "Darcula", "#2b2b2b", "#a9b7c6", "#6897bb", "#6a8759", "#bbb529", "#ff6b68", "#cc7832"),
  t("material-palenight", "Material Palenight", "#292d3e", "#a6accd", "#82aaff", "#c3e88d", "#ffcb6b", "#f07178", "#f78c6c"),
  t("material-darker", "Material Darker", "#212121", "#eeffff", "#80cbc4", "#c3e88d", "#ffcb6b", "#f07178", "#f78c6c"),
  t("night-owl", "Night Owl", "#011627", "#d6deeb", "#82aaff", "#addb67", "#ecc48d", "#ef5350", "#f78c6c"),
  t("cobalt2", "Cobalt2", "#193549", "#ffffff", "#ffc600", "#3ad900", "#ffee80", "#ff628c", "#ff9d00"),
  t("synthwave-84", "SynthWave '84", "#262335", "#ffffff", "#ff7edb", "#72f1b8", "#fede5d", "#fe4450", "#f97e72"),
  t("shades-of-purple", "Shades of Purple", "#2d2b55", "#ffffff", "#fad000", "#a5ff90", "#fad000", "#ec3a37", "#ff9d00"),
  t("horizon", "Horizon", "#1c1e26", "#e0e0e0", "#26bbd9", "#29d398", "#fac29a", "#e95678", "#f09483"),
  t("oceanic-next", "Oceanic Next", "#1b2b34", "#d8dee9", "#6699cc", "#99c794", "#fac863", "#ec5f67", "#f99157"),
  t("tomorrow-night", "Tomorrow Night", "#1d1f21", "#c5c8c6", "#81a2be", "#b5bd68", "#f0c674", "#cc6666", "#de935f"),
  t("nightfox", "Nightfox", "#192330", "#cdcecf", "#719cd6", "#81b29a", "#dbc074", "#c94f6d", "#f4a261"),
  t("poimandres", "Poimandres", "#1b1e28", "#a6accd", "#add7ff", "#5de4c7", "#fffac2", "#d0679d", "#f087bd"),
  t("andromeda", "Andromeda", "#23262e", "#d5ced9", "#00e8c6", "#96e072", "#ffe66d", "#ee5d43", "#f39c12"),
  t("panda", "Panda", "#292a2b", "#e6e6e6", "#19f9d8", "#19f9d8", "#ffb86c", "#ff2c6d", "#ffb86c"),
  t("iceberg", "Iceberg", "#161821", "#c6c8d1", "#84a0c6", "#b4be82", "#e2a478", "#e27878", "#e2a478"),
  t("zenburn", "Zenburn", "#3f3f3f", "#dcdccc", "#8cd0d3", "#7f9f7f", "#f0dfaf", "#cc9393", "#dfaf8f"),
  t("oxocarbon", "Oxocarbon", "#161616", "#f2f4f8", "#78a9ff", "#42be65", "#ffe97b", "#ee5396", "#ff7eb6"),
  t("vesper", "Vesper", "#101010", "#ffffff", "#ffc799", "#99ffe4", "#ffc799", "#ff8080", "#ffc799"),
  t("flexoki-dark", "Flexoki Dark", "#100f0f", "#cecdc3", "#4385be", "#879a39", "#d0a215", "#d14d41", "#da702c"),
  t("flexoki-light", "Flexoki Light", "#fffcf0", "#100f0f", "#205ea6", "#66800b", "#ad8301", "#af3029", "#bc5215"),
];

export const DEFAULT_THEME = THEMES[0]!;

/** The theme with this id, or the default one. */
export const themeById = (id: string): Theme => THEMES.find((th) => th.id === id) ?? DEFAULT_THEME;

/** The island's colors: the theme, with the user's own pill and accent colors on top. */
export function palette(theme: Theme, pillColor: string, accentColor: string): Record<string, string> {
  // The theme's text color only fits backgrounds of the same lightness; otherwise use a neutral one.
  const light = isLight(pillColor);
  const fg = isLight(theme.bg) === light ? theme.fg : light ? "#1c1c1e" : "#f5f5f7";
  return {
    "--bg": pillColor,
    "--fg": fg,
    "--accent": accentColor,
    "--on-accent": isLight(accentColor) ? "#1c1c1e" : "#ffffff",
    "--ok": theme.ok,
    "--warn": theme.warn,
    "--hot": theme.hot,
    "--done": theme.done,
  };
}
