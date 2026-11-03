import type { KeyboardEvent } from "react";
import { stepIndex } from "./focus";

// A radio group made of buttons. The arrows move the choice and the keyboard together, as
// they do in a native group, and Home and End go to the ends; Tab leaves the group, since
// only the chosen button is a tab stop (radioTabIndex in focus.ts). The group is the
// button's parent, and its buttons are the ones with role="radio".

export function moveRadio(event: KeyboardEvent<HTMLElement>, count: number, index: number, choose: (next: number) => void): void {
  const next = stepIndex(count, index, event.key);
  if (next === null || next === index) return;
  event.preventDefault();
  choose(next);
  event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}
