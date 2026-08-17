/**
 * "Good morning" and friends, from the clock on this machine.
 *
 * Kept out of the component so it can be tested without pulling a React tree
 * and its stylesheets into the test runner.
 */
export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
