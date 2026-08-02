export function getJarvisBrandName(): string {
  return 'JARVIS';
}

export function getJarvisGreeting(bootstrapping: boolean): string {
  return bootstrapping
    ? 'Boot sequence active. Core systems aligning for launch.'
    : 'Systems online and ready to assist with your next directive.';
}

export function getJarvisWelcomeMessage(): string {
  return 'JARVIS is online. State your objective and I will route it.';
}

export function getJarvisMissionLine(): string {
  return 'Mission control: secure, precise, and fully synchronized.';
}

export function getJarvisDirectiveHint(): string {
  return 'Issue a directive to JARVIS and I will route it across the command deck.';
}

export function getJarvisLiveViewStatus(moduleName: string, bootstrapping: boolean, listening: boolean, speaking: boolean) {
  const mode = listening ? 'Listening' : speaking ? 'Responding' : 'Standby';
  const headline = bootstrapping ? 'Live view: boot sequence active' : 'Live view: command stream online';
  const detail = bootstrapping
    ? `JARVIS is booting ${moduleName} into the mission core.`
    : `JARVIS is tracking ${moduleName} in real time.`;

  return {
    headline,
    detail,
    mode
  };
}

export function getJarvisMissionSnapshot(moduleName: string, projects: number, operators: number, questions: number) {
  return {
    headline: `Mission snapshot: ${moduleName} is synchronized`,
    metrics: {
      projects,
      operators,
      questions
    },
    detail: ` ${projects} mission lanes, ${operators} operators, ${questions} live questions`
  };
}

export function getJarvisMissionPulse(moduleName: string, readiness: number, focus: number) {
  return {
    headline: `Mission pulse: ${moduleName} is in flow`,
    metrics: {
      readiness,
      focus
    },
    detail: `${readiness}/5 readiness • ${focus}/5 focus`
  };
}

export function getJarvisMissionBoard(moduleName: string, active: number, alerts: number) {
  return {
    headline: `Mission board: ${moduleName} is primed`,
    metrics: {
      active,
      alerts
    },
    detail: `${active} active lanes • ${alerts} escalation flags`
  };
}
