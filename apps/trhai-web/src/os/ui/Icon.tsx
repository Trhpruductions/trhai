// Line icons on a 24px box, drawn with the current text colour. Path data
// only - no icon font, no library - so each costs a few bytes.

export const icons = {
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM20 20l-4.6-4.6",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0",
  plus: "M12 5v14M5 12h14",
  mic: "M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3ZM6 11a6 6 0 0 0 12 0M12 17v3.5",
  clip: "M20 11.5 12.3 19.2a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4l7-7",
  send: "M4 12h14M12 5l7 7-7 7",
  stop: "M7 7h10v10H7z",
  close: "M6 6l12 12M18 6 6 18",
  chevronLeft: "M14.5 6 8.5 12l6 6",
  chevronRight: "M9.5 6l6 6-6 6",
  chevronDown: "M6 9.5l6 6 6-6",
  image: "M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 8.5h.01",
  screen: "M3.5 4.5h17v11h-17zM8 20h8M12 15.5V20",
  pin: "M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5ZM12 14v6",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
  eyeOff: "M3 3l18 18M10.6 5.6A9.8 9.8 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-3.2 4M6.3 6.4A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M16 4.5v5M10 14.5v5",
  copy: "M8 8h11v12H8zM5 16V4h11",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  trash: "M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13",
  user: "M12 4.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM4.5 20a7.5 7.5 0 0 1 15 0",
  logout: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10",
  bolt: "M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z",
  command: "M8 8V6a2 2 0 1 0-2 2h12a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H6a2 2 0 1 0 2 2V8",
  wave: "M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2",
  speaker: "M4 9.5h4L13 5v14l-5-4.5H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11",
  speakerOff: "M4 9.5h4L13 5v14l-5-4.5H4zM17 9.5l5 5M22 9.5l-5 5",
  alert: "M12 4 2.5 20h19L12 4ZM12 10v4.5M12 17.5h.01",
  info: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17ZM12 11v5.5M12 7.8h.01",
  ok: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17ZM8 12.5l2.7 2.7L16.5 9.5",
  external: "M14 4h6v6M20 4l-9 9M10 6H5v13h13v-5",
  grid: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z",
  archive: "M3.5 5h17v4h-17zM5.5 9v10h13V9M10 13h4",
  pencil: "M4 20h4.5L19 9.5l-4.5-4.5L4 15.5V20ZM13 6.5l4.5 4.5",
  panel: "M3.5 5h17v14h-17zM9.5 5v14",
  message: "M4.5 5.5h15v10h-9l-4.5 3.5v-3.5h-1.5z",
  play: "M8 5.5v13l10.5-6.5L8 5.5Z",
  pause: "M9 5.5v13M15 5.5v13",
  clock: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17ZM12 7.5V12l3 2",
  log: "M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6"
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name, path, size = 18, className }: { name?: IconName; path?: string; size?: number; className?: string }) {
  const d = path ?? (name ? icons[name] : "");
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
