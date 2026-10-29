import "./toasts.css";
import { emit, listen } from "@tauri-apps/api/event";
import { h } from "../../../sdk/dom";
import { commands } from "../../bindings/toasts";
import type { ToastSync } from "../../notice-view";
import { TOAST_EVENTS } from "../../toasts";
import { toastStack } from "./stack";

const root = h("div", { class: "toasts", role: "region", "aria-label": "Notifications" });
document.body.append(root);
const stack = toastStack(root, {
  place: async (corner, width, height) => void (await commands.place(corner, width, height)),
  send: (e) => void emit(TOAST_EVENTS.event, e),
});
await listen<ToastSync>(TOAST_EVENTS.sync, (e) => stack.sync(e.payload));
await emit(TOAST_EVENTS.ready);
